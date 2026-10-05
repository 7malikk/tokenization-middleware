// Latency (NFR1): one target at one constant arrival rate. Driven by
// evaluation/run.sh, which repeats it per target, rate and repetition.
//
// Two scenarios run back to back: `warmup` (excluded from results) and
// `measure`. Every figure in the report comes from the `measure` scenario only,
// through the {scenario:measure} submetrics declared in `thresholds` (they
// always pass; they exist so the summary carries per-scenario statistics).
//
// Targets:
//   measurement A (app-level, through the evaluation app):
//     baseline-write   POST /baseline/customers             BVN stored directly
//     treatment-write  POST /customers                      tokenize, then store the token
//     baseline-read    POST /baseline/customers/:id/read    BVN read directly
//     treatment-read   POST /customers/:id/reveal-bvn       detokenize
//   measurement B (the middleware alone, over HTTPS):
//     mw-tokenize, mw-detokenize, mw-erase

import http from 'k6/http';
import exec from 'k6/execution';

const TARGET = __ENV.TARGET;
const RATE = Number(__ENV.RATE);
const WARMUP = Number(__ENV.WARMUP_SECONDS || 15);
const DURATION = Number(__ENV.DURATION_SECONDS || 60);
const APP = __ENV.APP_URL;
const MW = __ENV.MIDDLEWARE_URL;
const SUMMARY_FILE = __ENV.SUMMARY_FILE;
const POOL = 100; // customers or tokens created in setup for the read paths

const API_KEY = JSON.parse(open(__ENV.EVALUATION_CREDENTIALS_FILE)).appA.apiKey;
const JSON_HEADERS = { 'content-type': 'application/json' };
const MW_PARAMS = { headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` } };

/** Random 11-digit string shaped like a BVN. Synthetic data only. */
function syntheticBvn() {
  let bvn = '';
  for (let i = 0; i < 11; i++) bvn += Math.floor(Math.random() * 10);
  return bvn;
}

const customer = () => JSON.stringify({ fullName: 'Evaluation Customer', bvn: syntheticBvn() });
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Requests made in setup, in parallel batches; returns the parsed bodies. Fails the run on any error. */
function createAll(count, request, expected) {
  const out = [];
  for (let done = 0; done < count; done += 20) {
    const batch = [];
    for (let i = done; i < Math.min(count, done + 20); i++) batch.push(request());
    for (const res of http.batch(batch)) {
      if (res.status !== expected) exec.test.abort(`setup request returned ${res.status}`);
      out.push(res.json());
    }
  }
  return out;
}

const tokenizeRequest = () => ['POST', `${MW}/v1/tokenize`, JSON.stringify({ dataType: 'BVN', value: syntheticBvn() }), { ...MW_PARAMS, responseType: 'text' }];

const TARGETS = {
  'baseline-write': {
    run: () => http.post(`${APP}/baseline/customers`, customer(), { headers: JSON_HEADERS }),
  },
  'treatment-write': {
    run: () => http.post(`${APP}/customers`, customer(), { headers: JSON_HEADERS }),
  },
  'baseline-read': {
    setup: () => ({ ids: createAll(POOL, () => ['POST', `${APP}/baseline/customers`, customer(), { headers: JSON_HEADERS, responseType: 'text' }], 201).map((c) => c.id) }),
    run: (data) => http.post(`${APP}/baseline/customers/${pick(data.ids)}/read`),
  },
  'treatment-read': {
    setup: () => ({ ids: createAll(POOL, () => ['POST', `${APP}/customers`, customer(), { headers: JSON_HEADERS, responseType: 'text' }], 201).map((c) => c.id) }),
    run: (data) => http.post(`${APP}/customers/${pick(data.ids)}/reveal-bvn`),
  },
  'mw-tokenize': {
    run: () => http.post(`${MW}/v1/tokenize`, JSON.stringify({ dataType: 'BVN', value: syntheticBvn() }), MW_PARAMS),
  },
  'mw-detokenize': {
    setup: () => ({ tokens: createAll(POOL, tokenizeRequest, 201).map((r) => r.token) }),
    run: (data) => http.post(`${MW}/v1/detokenize`, JSON.stringify({ token: pick(data.tokens) }), MW_PARAMS),
  },
  'mw-erase': {
    // Each erase needs its own live token: one per iteration of each scenario, plus a margin.
    setup: () => ({
      warmup: createAll(Math.ceil(RATE * WARMUP) + 5, tokenizeRequest, 201).map((r) => r.token),
      measure: createAll(Math.ceil(RATE * DURATION) + 5, tokenizeRequest, 201).map((r) => r.token),
    }),
    run: (data) => {
      const pool = data[exec.scenario.name];
      const token = pool[exec.scenario.iterationInTest];
      if (!token) exec.test.abort('erase token pool exhausted');
      return http.post(`${MW}/v1/erase`, JSON.stringify({ token }), MW_PARAMS);
    },
  },
};

const target = TARGETS[TARGET];
if (!target || !(RATE > 0)) throw new Error(`unknown TARGET "${TARGET}" or bad RATE`);

const arrival = (startTime, duration) => ({
  executor: 'constant-arrival-rate',
  exec: 'iteration',
  rate: RATE,
  timeUnit: '1s',
  startTime: `${startTime}s`,
  duration: `${duration}s`,
  preAllocatedVUs: Math.max(5, Math.ceil(RATE / 5)),
  maxVUs: RATE * 2 + 20,
  gracefulStop: '5s',
});

export const options = {
  // Resolve localhost to 127.0.0.1 only (the middleware certificate names localhost).
  hosts: { localhost: '127.0.0.1' },
  discardResponseBodies: true,
  setupTimeout: '600s',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
  scenarios: {
    warmup: arrival(0, WARMUP),
    measure: arrival(WARMUP, DURATION),
  },
  thresholds: {
    'http_req_duration{scenario:measure}': ['max>=0'],
    'http_req_failed{scenario:measure}': ['rate>=0'],
    'http_reqs{scenario:measure}': ['count>=0'],
    'iterations{scenario:measure}': ['count>=0'],
    'dropped_iterations{scenario:measure}': ['count>=0'],
    'http_req_duration{scenario:warmup}': ['max>=0'],
  },
};

http.setResponseCallback(http.expectedStatuses(200, 201));

export function setup() {
  return target.setup ? target.setup() : {};
}

export function iteration(data) {
  target.run(data);
}

export function handleSummary(data) {
  const m = (name) => (data.metrics[name] ? data.metrics[name].values : null);
  const d = m('http_req_duration{scenario:measure}');
  const failed = m('http_req_failed{scenario:measure}');
  const line = d
    ? `${TARGET} @ ${RATE}/s: median ${d.med.toFixed(2)} ms, p95 ${d['p(95)'].toFixed(2)} ms, errors ${(100 * (failed ? failed.rate : 0)).toFixed(2)}%\n`
    : `${TARGET} @ ${RATE}/s: no measured requests\n`;
  return {
    stdout: line,
    [SUMMARY_FILE]: JSON.stringify({ target: TARGET, rate: RATE, warmupSeconds: WARMUP, durationSeconds: DURATION, k6: data }, null, 1),
  };
}
