'use strict';
// Latency report (NFR1). Reads <dir>/runs.jsonl and the k6 summaries in
// <dir>/k6/, writes <dir>/summary.md and <dir>/summary.json.
//
//   node latency-report.js <dir>
//
// Per scenario (target and rate) it reports, for the measured window only:
// median, p95, p99, mean, achieved rate and error rate, for each repetition and
// as the mean across repetitions (with the min-max range). Overhead is
// treatment minus baseline, in milliseconds and as a percentage of baseline.

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { log, mdTable, writeJson, writeText } = require('./lib');

/** Capacity step criteria: a step "holds" if all three are met. */
const CAPACITY_MAX_ERROR_RATE = 0.01;
const CAPACITY_MIN_ACHIEVED = 0.95;
const CAPACITY_MAX_P95_FACTOR = 2;

const LABELS = {
  'baseline-write': 'Baseline write: POST /baseline/customers',
  'treatment-write': 'Treatment write: POST /customers (tokenize, store token)',
  'baseline-read': 'Baseline read: POST /baseline/customers/:id/read',
  'treatment-read': 'Treatment read: POST /customers/:id/reveal-bvn (detokenize)',
  'mw-tokenize': 'Middleware: POST /v1/tokenize',
  'mw-detokenize': 'Middleware: POST /v1/detokenize',
  'mw-erase': 'Middleware: POST /v1/erase',
};
const PATHS = [
  { path: 'Write', baseline: 'baseline-write', treatment: 'treatment-write' },
  { path: 'Read', baseline: 'baseline-read', treatment: 'treatment-read' },
];
const STATS = ['median', 'p95', 'p99', 'mean', 'achievedRate', 'errorRate'];

function stats(k6, scenario, seconds) {
  const v = (name) => k6.metrics[`${name}{scenario:${scenario}}`]?.values;
  const d = v('http_req_duration');
  if (!d) return null;
  const reqs = v('http_reqs')?.count ?? 0;
  return {
    requests: reqs,
    median: d.med,
    p95: d['p(95)'],
    p99: d['p(99)'],
    mean: d.avg,
    max: d.max,
    achievedRate: reqs / seconds,
    errorRate: v('http_req_failed')?.rate ?? 0,
    droppedIterations: v('dropped_iterations')?.count ?? 0,
  };
}

function aggregate(reps) {
  const out = { repetitions: reps.length };
  for (const s of [...STATS, 'requests', 'droppedIterations']) {
    const values = reps.map((r) => r[s]);
    out[s] = { mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values) };
  }
  return out;
}

const ms = (x) => (x === undefined || x === null ? 'n/a' : x.toFixed(2));
const pct = (x) => `${(100 * x).toFixed(2)}%`;
const withRange = (a, f = ms) => (a.min === a.max ? f(a.mean) : `${f(a.mean)} (${f(a.min)} to ${f(a.max)})`);

function main() {
  const dir = process.argv[2];
  const runs = readFileSync(join(dir, 'runs.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const load = (run) => {
    const file = join(dir, run.summary);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };

  // Latency scenarios.
  const scenarios = new Map(); // key target@rate -> { target, rate, reps: [] }
  const problems = [];
  for (const run of runs.filter((r) => r.kind === 'latency')) {
    const summary = load(run);
    const s = summary && stats(summary.k6, 'measure', summary.durationSeconds);
    if (!s) {
      problems.push(`${run.target} @ ${run.rate}/s rep ${run.rep}: no summary (k6 exit ${run.exitCode})`);
      continue;
    }
    const key = `${run.target}@${run.rate}`;
    if (!scenarios.has(key)) scenarios.set(key, { target: run.target, rate: run.rate, reps: [] });
    scenarios.get(key).reps.push({ rep: run.rep, start: run.start, end: run.end, exitCode: run.exitCode, ...s });
  }
  for (const sc of scenarios.values()) sc.aggregate = aggregate(sc.reps);
  const get = (target, rate) => scenarios.get(`${target}@${rate}`);
  const rates = [...new Set([...scenarios.values()].map((s) => s.rate))].sort((a, b) => a - b);

  // Overhead: treatment minus baseline, from the mean-of-repetitions figures.
  const overhead = [];
  for (const p of PATHS) {
    for (const rate of rates) {
      const b = get(p.baseline, rate);
      const t = get(p.treatment, rate);
      if (!b || !t) continue;
      const row = { path: p.path, rate };
      for (const s of ['median', 'p95', 'p99', 'mean']) {
        const base = b.aggregate[s].mean;
        const treat = t.aggregate[s].mean;
        row[s] = { baseline: base, treatment: treat, overheadMs: treat - base, overheadPct: base > 0 ? (100 * (treat - base)) / base : null };
      }
      overhead.push(row);
    }
  }

  // Capacity.
  let capacity = null;
  const capRun = runs.find((r) => r.kind === 'capacity');
  const capSummary = capRun && load(capRun);
  if (capSummary) {
    const steps = capSummary.steps.map((rate) => ({ rate, ...stats(capSummary.k6, `step_${String(rate).padStart(4, '0')}`, capSummary.stepSeconds) }));
    const firstP95 = steps[0]?.p95;
    let indicative = null;
    let knee = null;
    for (const s of steps) {
      s.holds =
        s.requests > 0 &&
        s.errorRate < CAPACITY_MAX_ERROR_RATE &&
        s.achievedRate >= CAPACITY_MIN_ACHIEVED * s.rate &&
        s.p95 <= CAPACITY_MAX_P95_FACTOR * firstP95;
      if (!knee && s.holds) indicative = s.rate;
      if (!knee && !s.holds) knee = s.rate;
    }
    capacity = { operation: capSummary.operation, stepSeconds: capSummary.stepSeconds, start: capRun.start, end: capRun.end, exitCode: capRun.exitCode, steps, indicativeCapacity: indicative, firstFailingStep: knee };
  }

  const result = {
    part: 'latency (NFR1)',
    method: 'k6 constant-arrival-rate, warm-up excluded; statistics from http_req_duration of the measured window',
    scenarios: [...scenarios.values()],
    overhead,
    capacity,
    problems,
  };
  writeJson(join(dir, 'summary.json'), result);
  writeText(join(dir, 'summary.md'), render(result, runs));
  log(`latency report: ${scenarios.size} scenarios, ${overhead.length} overhead rows${capacity ? `, indicative capacity ${capacity.indicativeCapacity ?? 'none'}/s` : ''}`);
  if (problems.length > 0) process.exit(3);
}

function render(result, runs) {
  const first = runs[0];
  const last = runs[runs.length - 1];
  const scenarioRows = (targets) =>
    result.scenarios
      .filter((s) => targets.includes(s.target))
      .sort((a, b) => targets.indexOf(a.target) - targets.indexOf(b.target) || a.rate - b.rate)
      .map((s) => {
        const a = s.aggregate;
        return [LABELS[s.target], s.rate, a.repetitions, withRange(a.median), withRange(a.p95), withRange(a.p99), withRange(a.mean), withRange(a.achievedRate), withRange(a.errorRate, pct)];
      });
  const header = ['Scenario', 'Target rate (/s)', 'Reps', 'Median (ms)', 'p95 (ms)', 'p99 (ms)', 'Mean (ms)', 'Achieved (/s)', 'Error rate'];

  const lines = [
    '# Latency (NFR1)',
    '',
    'k6 ran on the server against 127.0.0.1 (constant-arrival-rate). Each run had a warm-up that is excluded',
    'from every figure; the statistics come from `http_req_duration` of the measured window only (time from',
    'sending the request to the last response byte, on kept-alive connections). Each figure is the mean of',
    'the repetitions, with the range across repetitions in brackets.',
    '',
    `k6 runs: ${runs.length} (latency and capacity), from ${first?.start} to ${last?.end} (UTC). Each run's start and end time is in`,
    '`runs.jsonl` and the per-repetition table below, for checking CPU credits in the Azure portal.',
    '',
    '## Measurement A: app-level overhead (baseline vs treatment)',
    '',
    mdTable(
      ['Path', 'Rate (/s)', 'Statistic', 'Baseline (ms)', 'Treatment (ms)', 'Overhead (ms)', 'Overhead (%)'],
      result.overhead.flatMap((o) =>
        ['median', 'p95', 'p99', 'mean'].map((s) => [o.path, o.rate, s, ms(o[s].baseline), ms(o[s].treatment), ms(o[s].overheadMs), o[s].overheadPct === null ? 'n/a' : `${o[s].overheadPct.toFixed(1)}%`]),
      ),
    ),
    '',
    mdTable(header, scenarioRows(['baseline-write', 'treatment-write', 'baseline-read', 'treatment-read'])),
    '',
    '## Measurement B: the middleware alone',
    '',
    mdTable(header, scenarioRows(['mw-tokenize', 'mw-detokenize', 'mw-erase'])),
    '',
  ];

  const c = result.capacity;
  if (c) {
    lines.push(
      '## Indicative capacity (stepped run)',
      '',
      `One run of \`/v1/${c.operation}\`, the arrival rate raised in steps of ${c.stepSeconds} s (${c.start} to ${c.end}).`,
      `A step holds if its error rate is below ${pct(CAPACITY_MAX_ERROR_RATE)}, it achieves at least ${CAPACITY_MIN_ACHIEVED * 100}% of the target rate,`,
      `and its p95 is at most ${CAPACITY_MAX_P95_FACTOR} times the first step's p95. **Indicative capacity: ${c.indicativeCapacity ?? 'below the first step'} requests/s**`,
      `${c.firstFailingStep ? `(the ${c.firstFailingStep}/s step did not hold)` : '(every step held; the true limit is higher)'}. This is a single short run on one VM, an indication only.`,
      '',
      mdTable(
        ['Target (/s)', 'Achieved (/s)', 'Median (ms)', 'p95 (ms)', 'p99 (ms)', 'Error rate', 'Dropped iterations', 'Holds'],
        c.steps.map((s) => [s.rate, s.requests ? s.achievedRate.toFixed(1) : '0', ms(s.median), ms(s.p95), ms(s.p99), s.requests ? pct(s.errorRate) : 'n/a', s.droppedIterations ?? 0, s.holds ? 'yes' : 'no']),
      ),
      '',
    );
  }

  lines.push(
    '## Every repetition',
    '',
    mdTable(
      ['Scenario', 'Rate', 'Rep', 'Start (UTC)', 'End (UTC)', 'Requests', 'Median', 'p95', 'p99', 'Mean', 'Achieved', 'Errors', 'Dropped'],
      result.scenarios.flatMap((s) =>
        s.reps.map((r) => [s.target, s.rate, r.rep, r.start, r.end, r.requests, ms(r.median), ms(r.p95), ms(r.p99), ms(r.mean), r.achievedRate.toFixed(2), pct(r.errorRate), r.droppedIterations]),
      ),
    ),
    '',
  );
  if (result.problems.length > 0) lines.push('## Problems', '', ...result.problems.map((p) => `- ${p}`), '');
  return lines.join('\n');
}

main();
