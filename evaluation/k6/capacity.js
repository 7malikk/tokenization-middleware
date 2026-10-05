// Indicative capacity (NFR1): one stepped run against the middleware alone.
// The arrival rate rises in steps (STEPS, each STEP_SECONDS long); each step is
// its own constant-arrival-rate scenario so the report can show where latency
// or errors start to climb. The run aborts early if more than half of the
// requests fail, to avoid hammering a saturated host.
//
// OPERATION is tokenize (default) or detokenize.

import http from 'k6/http';
import exec from 'k6/execution';

const STEPS = (__ENV.STEPS || '25 50 100 200 400 800').split(/[ ,]+/).filter(Boolean).map(Number);
const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 30);
const OPERATION = __ENV.OPERATION || 'tokenize';
const MW = __ENV.MIDDLEWARE_URL;
const SUMMARY_FILE = __ENV.SUMMARY_FILE;

const API_KEY = JSON.parse(open(__ENV.EVALUATION_CREDENTIALS_FILE)).appA.apiKey;
const MW_PARAMS = { headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` } };

if (!['tokenize', 'detokenize'].includes(OPERATION)) throw new Error('OPERATION must be tokenize or detokenize');

function syntheticBvn() {
  let bvn = '';
  for (let i = 0; i < 11; i++) bvn += Math.floor(Math.random() * 10);
  return bvn;
}

const stepName = (rate) => `step_${String(rate).padStart(4, '0')}`;

const scenarios = {};
const thresholds = {
  http_req_failed: [{ threshold: 'rate<0.5', abortOnFail: true, delayAbortEval: '10s' }],
};
STEPS.forEach((rate, i) => {
  scenarios[stepName(rate)] = {
    executor: 'constant-arrival-rate',
    exec: 'iteration',
    rate,
    timeUnit: '1s',
    startTime: `${i * STEP_SECONDS}s`,
    duration: `${STEP_SECONDS}s`,
    preAllocatedVUs: Math.max(5, Math.ceil(rate / 5)),
    maxVUs: Math.max(50, rate * 2),
    gracefulStop: '2s',
  };
  thresholds[`http_req_duration{scenario:${stepName(rate)}}`] = ['max>=0'];
  thresholds[`http_req_failed{scenario:${stepName(rate)}}`] = ['rate>=0'];
  thresholds[`http_reqs{scenario:${stepName(rate)}}`] = ['count>=0'];
  thresholds[`dropped_iterations{scenario:${stepName(rate)}}`] = ['count>=0'];
});

export const options = {
  hosts: { localhost: '127.0.0.1' },
  discardResponseBodies: true,
  setupTimeout: '300s',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
  scenarios,
  thresholds,
};

http.setResponseCallback(http.expectedStatuses(200, 201));

export function setup() {
  if (OPERATION !== 'detokenize') return {};
  const tokens = [];
  for (let n = 0; n < 5; n++) {
    const batch = [];
    for (let i = 0; i < 20; i++) {
      batch.push(['POST', `${MW}/v1/tokenize`, JSON.stringify({ dataType: 'BVN', value: syntheticBvn() }), { ...MW_PARAMS, responseType: 'text' }]);
    }
    for (const res of http.batch(batch)) {
      if (res.status !== 201) exec.test.abort(`setup tokenize returned ${res.status}`);
      tokens.push(res.json().token);
    }
  }
  return { tokens };
}

export function iteration(data) {
  if (OPERATION === 'tokenize') {
    http.post(`${MW}/v1/tokenize`, JSON.stringify({ dataType: 'BVN', value: syntheticBvn() }), MW_PARAMS);
  } else {
    const token = data.tokens[Math.floor(Math.random() * data.tokens.length)];
    http.post(`${MW}/v1/detokenize`, JSON.stringify({ token }), MW_PARAMS);
  }
}

export function handleSummary(data) {
  return {
    stdout: `capacity (${OPERATION}): ${STEPS.length} steps of ${STEP_SECONDS}s, ${STEPS.join(', ')} requests/s\n`,
    [SUMMARY_FILE]: JSON.stringify({ operation: OPERATION, steps: STEPS, stepSeconds: STEP_SECONDS, k6: data }, null, 1),
  };
}
