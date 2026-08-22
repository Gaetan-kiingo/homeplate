// scripts/it03-eval.js — U4-MODERATION: the IT-03 scoring harness (SRS §4.2; NFR-10;
// ADR-007/ADR-008). Runs every item of the ADR-008 evaluation set through the REAL FR-08
// pipeline path — deterministic pre-filter first (src/modules/moderation/prefilter), then
// the ADR-007 classifier — and reports the run with the model id and prompt version.
//
// WHAT THIS SCRIPT REFUSES TO DO (ADR-007/ADR-008, build-plan §4A):
//   - A run through the deterministic MOCK adapter is labelled NOT-A-MEASUREMENT and carries
//     NO false-positive/false-negative rate at all. The mock is a fixture-pattern matcher
//     that scores unseen abusive text 'benign' at 0.99 — a rate measured through it is an
//     invented number, so none is computed, printed or written. Only the item mechanics
//     (counts, prediction completeness, which stage answered) are reported.
//   - No NFR-10 pass is EVER claimed here: even a live run's rates are reported alongside
//     the ADR-008 claimability verdict (label sign-off + live model id + prompt version),
//     and recording RESULTS.md with the human sign-off is the wave-7 measurement task
//     (U7-MODERATION-MEASURE), not this script's.
//
// The live invocation is wave 7 ONLY:
//   NODE_ENV=production-like env with LLM_MODERATION_MODE=live, LLM_MODERATION_BASE_URL,
//   LLM_MODERATION_API_KEY, MODERATION_MODEL set — never from the automated suite
//   (NODE_ENV=test pins the mock; ADR-007). Free-tier pacing: --delay-ms (default 4000 live).
//
// Usage:
//   node scripts/it03-eval.js [--set v1] [--delay-ms N] [--out <file.json>]
//
// Requirement traceability (SRS Appendix B): NFR-10 (IT-03), FR-08, AB-01, AB-03, AB-04,
// NFR-13 (the set is synthetic and non-personal — the only content this script may send).
'use strict';

const fs = require('fs');
const path = require('path');

/* istanbul ignore next -- .env loading is CLI-only; the suite pins NODE_ENV=test */
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const evalSet = require('../tests/fixtures/moderation-eval');
const prefilter = require('../src/modules/moderation/prefilter');
const { PROMPT_VERSION } = require('../src/modules/moderation/service');

const LIVE_DEFAULT_DELAY_MS = 4000; // ADR-007: free-tier rate limits need batching/backoff

/** Parse CLI arguments; exported for tests. */
function parseArgs(argv) {
  const args = { set: undefined, delayMs: undefined, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--set') {
      args.set = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--set=')) {
      args.set = arg.slice('--set='.length);
    } else if (arg === '--delay-ms') {
      args.delayMs = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--delay-ms=')) {
      args.delayMs = Number(arg.slice('--delay-ms='.length));
    } else if (arg === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
    } else {
      throw new Error(
        `unknown argument "${arg}" — usage: node scripts/it03-eval.js ` +
          '[--set vN] [--delay-ms N] [--out <file.json>]'
      );
    }
  }
  if (args.delayMs !== undefined && (!Number.isFinite(args.delayMs) || args.delayMs < 0)) {
    throw new Error('it03-eval: --delay-ms must be a non-negative number');
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Score the set through the real pipeline path. Injectable for tests; the CLI passes the
 * mode-resolved ADR-007 adapter.
 *
 * @param {object} [options]
 * @param {(text: string) => Promise<{category: string, confidence: number, model: string}>}
 *        [options.classify]  stage-2 classifier (default: the resolved adapter)
 * @param {string} [options.model]  model id reported by the adapter
 * @param {'mock'|'live'} [options.mode]
 * @param {string} [options.setVersion]
 * @param {number} [options.delayMs]  pacing between provider calls (free tier)
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<object>} the run report (see header for the mock/live shape split)
 */
async function runEval(options = {}) {
  // The adapter is required lazily so tests can run the harness with an injected classifier
  // without this script touching adapter config at load time.
  // eslint-disable-next-line global-require
  const llm = options.classify ? null : require('../src/adapters/llmModeration');
  const classify = options.classify ?? ((text) => llm.classify(text));
  const model = options.model ?? (llm ? llm.model : undefined);
  const mode = options.mode ?? (llm ? llm.mode : 'mock');
  const delayMs = options.delayMs ?? (mode === 'live' ? LIVE_DEFAULT_DELAY_MS : 0);
  const log = options.log ?? (() => {});

  const set = evalSet.loadSet(options.setVersion);
  evalSet.assertValidSet(set); // ADR-008: a malformed set may not be scored at all

  const predictions = new Map();
  let prefilterBlocked = 0;
  let classified = 0;
  const stageByItem = new Map();

  for (const item of set.items) {
    // THE REAL PIPELINE ORDER (ADR-002): deterministic pre-filter first, zero LLM calls on a
    // blocklist hit — identical to service.processScan stage 1.
    const blocked = prefilter.check(item.text);
    if (blocked.verdict === 'blocked') {
      predictions.set(item.id, blocked.category);
      stageByItem.set(item.id, 'pre_filter');
      prefilterBlocked += 1;
      continue;
    }
    const result = await classify(item.text);
    predictions.set(item.id, result.category);
    stageByItem.set(item.id, 'llm');
    classified += 1;
    if (delayMs > 0) await sleep(delayMs);
  }

  // Prediction completeness is harness mechanics, checkable in ANY mode.
  const missing = set.items.filter((item) => !predictions.has(item.id)).map((item) => item.id);
  if (missing.length > 0) {
    throw new Error(`it03-eval: ${missing.length} item(s) received no prediction`);
  }

  const verdict = evalSet.claimability({ set, modelId: model, promptVersion: PROMPT_VERSION });
  const mock = evalSet.isMockModelId(model);

  const base = {
    testId: 'IT-03',
    requirement: 'NFR-10',
    setVersion: set.version,
    itemCount: set.items.length,
    prefilterBlocked,
    classified,
    modelId: model,
    promptVersion: PROMPT_VERSION,
    labelReview: set.manifest.labelReview,
    claimable: verdict.claimable,
    claimabilityReasons: verdict.reasons,
  };

  if (mock) {
    // ADR-007/ADR-008: a mock-scored run is NOT a measurement. No rate is computed, printed
    // or written — the mock has no discriminating power over unseen text, so any rate would
    // be an invented number that could be mistaken for an NFR-10 result.
    const report = {
      measurement: false,
      label: 'NOT-A-MEASUREMENT',
      note:
        'Scored through the deterministic ADR-007 mock adapter. Harness mechanics only — ' +
        'no false-positive/false-negative rate exists in this output by design. ' +
        'The live IT-03 run is wave 7 (U7-MODERATION-MEASURE).',
      ...base,
      claimable: false,
    };
    log(`IT-03 harness: ${report.label} — ${set.items.length} items scored via the mock`);
    return report;
  }

  // Live run (wave 7): compute and report both NFR-10 rates against the exact model + prompt.
  const scored = evalSet.score(set, predictions);
  const report = {
    measurement: true,
    label: 'IT-03 live-run report',
    note:
      'NFR-10 may be claimed ONLY per the claimability verdict below, and only once this ' +
      'report is recorded in tests/fixtures/moderation-eval/' +
      `${set.version}/RESULTS.md with the ADR-008 human sign-off (reviewer, date, set version).`,
    ...base,
    falsePositives: scored.falsePositives,
    falsePositiveRate: scored.falsePositiveRate,
    falseNegatives: scored.falseNegatives,
    falseNegativeRate: scored.falseNegativeRate,
    misrouted: scored.misrouted,
    accuracy: scored.accuracy,
    perClass: scored.perClass,
    confusion: scored.confusion,
    withinBound: scored.withinBound,
    maxRate: evalSet.MAX_RATE,
  };
  log(
    `IT-03 live run: model=${model} prompt=${PROMPT_VERSION} ` +
      `FP=${scored.falsePositiveRate.toFixed(4)} FN=${scored.falseNegativeRate.toFixed(4)} ` +
      `withinBound=${scored.withinBound} claimable=${verdict.claimable}`
  );
  return report;
}

/**
 * CLI entry. `argv`/`io` are injectable so the harness surface is testable in-process
 * without spawning a child or printing into the suite's output.
 */
async function main(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv);
  const report = await runEval({
    setVersion: args.set,
    delayMs: args.delayMs,
    log: (line) => io.error(line),
  });
  const json = JSON.stringify(report, null, 2);
  io.log(json);
  if (args.out) {
    fs.writeFileSync(args.out, `${json}\n`);
    io.error(`report written to ${args.out}`);
  }
  return report;
}

/* istanbul ignore next -- process wiring, exercised only when run as a CLI; the suite
   covers main() in-process (tests/it-adapters/it03-moderation-eval.test.js) */
if (require.main === module) {
  main().catch((err) => {
    console.error(`it03-eval failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, runEval, main, LIVE_DEFAULT_DELAY_MS };
