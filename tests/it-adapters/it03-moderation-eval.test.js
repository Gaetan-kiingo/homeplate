// tests/it-adapters/it03-moderation-eval.test.js — IT-03 harness mechanics (SRS §4.2;
// NFR-10; ADR-007/ADR-008), exercised against the DETERMINISTIC MOCK adapter only and
// explicitly labelled NON-MEASUREMENT.
//
// What this file proves — and refuses to prove:
//   PROVES  — scripts/it03-eval.js runs the REAL pipeline order (prefilter first, classifier
//             second), covers every set item exactly once, records the model id and prompt
//             version, and labels a mock-scored run NOT-A-MEASUREMENT carrying NO
//             false-positive/false-negative rate at all (ADR-007: the mock is a fixture
//             matcher with no discriminating power — a rate through it is an invented
//             number). The live-run report SHAPE is checked with an injected stand-in
//             classifier whose numbers are never asserted, printed or persisted.
//   REFUSES — any NFR-10 claim. The live IT-03 run is wave 7 (U7-MODERATION-MEASURE): it
//             needs the live provider, the recorded model id + prompt version, RESULTS.md
//             and the ADR-008 sign-off. Nothing here reads or writes a results file, and
//             tests/it-adapters/it01c-adapter-depth.test.js separately asserts none exists.
//
// Requirement traceability (SRS Appendix B): NFR-10 (IT-03 harness), FR-08 (the scored
// pipeline path), NFR-13/ADR-008 (synthetic set only), ADR-007 (mock in the suite — this
// file asserts the config pin before touching the adapter).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const config = require('../../src/config');
const llm = require('../../src/adapters/llmModeration');
const evalSet = require('../fixtures/moderation-eval');
const prefilter = require('../../src/modules/moderation/prefilter');
const service = require('../../src/modules/moderation/service');
const { runEval, parseArgs, main, LIVE_DEFAULT_DELAY_MS } = require('../../scripts/it03-eval');

beforeAll(() => {
  // ADR-007: the automated suite may NEVER reach a live provider. The config layer pins the
  // mock under NODE_ENV=test; this is the tripwire that stops the file cold if that changes.
  expect(config.isTest).toBe(true);
  expect(config.moderation.mode).toBe('mock');
  expect(llm.mode).toBe('mock');
});

describe('IT-03 harness — mock-scored runs are NOT-A-MEASUREMENT (ADR-007/ADR-008)', () => {
  let report;

  beforeAll(async () => {
    report = await runEval(); // the resolved adapter IS the mock here (pinned above)
  });

  test('the run is labelled NOT-A-MEASUREMENT and is not claimable', () => {
    expect(report.measurement).toBe(false);
    expect(report.label).toBe('NOT-A-MEASUREMENT');
    expect(report.claimable).toBe(false);
    expect(report.claimabilityReasons.join(' ')).toMatch(/mock/i);
  });

  test('NO false-positive/false-negative rate exists ANYWHERE in the mock report', () => {
    // The ADR-008 rule is absolute: no FP/FN number may be quoted from the mock. The report
    // must not merely mark the numbers provisional — they must be ABSENT.
    for (const banned of [
      'falsePositiveRate',
      'falseNegativeRate',
      'falsePositives',
      'falseNegatives',
      'withinBound',
      'accuracy',
      'confusion',
    ]) {
      expect(Object.keys(report)).not.toContain(banned);
    }
    expect(JSON.stringify(report)).not.toMatch(/falsePositiveRate|falseNegativeRate/);
  });

  test('harness mechanics: every ADR-008 v1 item was scored exactly once through the pipeline order', () => {
    expect(report.setVersion).toBe('v1');
    expect(report.itemCount).toBeGreaterThanOrEqual(evalSet.MIN_ITEMS);
    expect(report.prefilterBlocked + report.classified).toBe(report.itemCount);
    // Stage 1 exists in the scored path (a pipeline without it would classify everything).
    expect(report.prefilterBlocked).toBeGreaterThanOrEqual(0);
    expect(report.classified).toBeGreaterThan(0);
  });

  test('the model id and prompt version ARE recorded — the ADR-007/ADR-008 provenance fields', () => {
    expect(report.modelId).toBe('mock-moderation-deterministic-v1'); // self-evidently not live
    expect(report.promptVersion).toBe(service.PROMPT_VERSION);
    expect(report.testId).toBe('IT-03');
    expect(report.requirement).toBe('NFR-10');
    // The signed-off ADR-008 label review rides along for the wave-7 RESULTS.md.
    expect(report.labelReview.status).toBe('signed-off');
    expect(report.labelReview.setVersion).toBe('v1');
  });
});

describe('IT-03 harness — the pipeline order is REAL (prefilter first, classifier second)', () => {
  test('the injected classifier is called once per item the prefilter passed — never for blocked items', async () => {
    const classify = jest.fn(async () => ({
      category: 'benign',
      confidence: 0.9,
      model: 'injected-order-probe',
    }));
    const report = await runEval({
      classify,
      model: 'injected-order-probe-mock', // 'mock' keeps the run in the non-measurement lane
      mode: 'mock',
    });
    expect(classify).toHaveBeenCalledTimes(report.classified);
    expect(report.prefilterBlocked + report.classified).toBe(report.itemCount);
    // Cross-check stage 1 against the prefilter directly on a sample of items.
    const set = evalSet.loadSet('v1');
    const blockedCount = set.items.filter(
      (item) => prefilter.check(item.text).verdict === 'blocked'
    ).length;
    expect(report.prefilterBlocked).toBe(blockedCount);
  });

  test('a live-shaped report carries the rate FIELDS the wave-7 RESULTS.md needs (values never asserted)', async () => {
    // Shape check only, via an injected stand-in: no provider is called, and none of the
    // numbers produced here mean anything — they are neither asserted nor recorded.
    const report = await runEval({
      classify: async () => ({ category: 'benign', confidence: 0.9, model: 'shape-probe' }),
      model: 'harness-live-shape-probe', // deliberately non-mock-named to take the live branch
      mode: 'mock',
      log: () => {}, // and nothing is printed
    });
    expect(report.measurement).toBe(true);
    for (const field of ['falsePositiveRate', 'falseNegativeRate', 'withinBound', 'confusion']) {
      expect(Object.keys(report)).toContain(field);
    }
    expect(typeof report.falsePositiveRate).toBe('number');
    expect(typeof report.falseNegativeRate).toBe('number');
    expect(report.maxRate).toBe(evalSet.MAX_RATE);
    // The claimability verdict is COMPUTED, not asserted claimable: it must agree with the
    // fixture module's own answer for this model + prompt (preconditions only — the note in
    // it01c: claimable=true never means NFR-10 passed, and this run records no results file).
    const verdict = evalSet.claimability({
      set: evalSet.loadSet('v1'),
      modelId: 'harness-live-shape-probe',
      promptVersion: service.PROMPT_VERSION,
    });
    expect(report.claimable).toBe(verdict.claimable);
    expect(report.note).toMatch(/RESULTS\.md/);
  });
});

describe('IT-03 harness — CLI contract and free-tier pacing (ADR-007)', () => {
  test('parseArgs pins the operator surface', () => {
    expect(parseArgs([])).toEqual({ set: undefined, delayMs: undefined, out: undefined });
    expect(parseArgs(['--set', 'v1', '--delay-ms', '0'])).toMatchObject({ set: 'v1', delayMs: 0 });
    expect(parseArgs(['--set=v1', '--delay-ms=250', '--out=/tmp/x.json'])).toMatchObject({
      set: 'v1',
      delayMs: 250,
      out: '/tmp/x.json',
    });
    expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--delay-ms', '-5'])).toThrow(/non-negative/);
  });

  test('live runs default to batch-and-backoff pacing; mock runs need none', () => {
    expect(LIVE_DEFAULT_DELAY_MS).toBeGreaterThan(0); // ADR-007 free-tier throughput note
  });

  test('the CLI entry runs the mock lane end to end; --out writes only where told (never the repo)', async () => {
    // Injected io: nothing is printed into the suite output, and the pacing branch is
    // exercised with a 0ms delay override.
    const outFile = path.join(os.tmpdir(), `hp-it03-harness-${crypto.randomUUID()}.json`);
    const io = { log: jest.fn(), error: jest.fn() };
    try {
      const report = await main(['--set', 'v1', '--delay-ms', '0', '--out', outFile], io);
      expect(report.label).toBe('NOT-A-MEASUREMENT');
      expect(io.log).toHaveBeenCalledTimes(1); // the JSON report, stdout only
      const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      expect(written.label).toBe('NOT-A-MEASUREMENT');
      expect(JSON.stringify(written)).not.toMatch(/falsePositiveRate|falseNegativeRate/);
    } finally {
      fs.rmSync(outFile, { force: true });
    }
    // Nothing was written into the repository's results locations (it01c also guards this).
    for (const rel of ['docs/results', 'docs/_generated/results']) {
      const dir = path.join(__dirname, '..', '..', rel);
      if (fs.existsSync(dir)) {
        expect(fs.readdirSync(dir).filter((f) => /it-?03|moderation/i.test(f))).toEqual([]);
      }
    }
  });

  test('inter-call pacing is honoured when configured (free-tier batching, ADR-007)', async () => {
    // One-millisecond pacing over a classifier stub: proves the sleep path runs without
    // slowing the suite. The item count bounds the added wall time to ~a quarter second.
    const report = await runEval({
      classify: async () => ({ category: 'benign', confidence: 0.9, model: 'pacing-probe' }),
      model: 'pacing-probe-mock',
      mode: 'mock',
      delayMs: 1,
    });
    expect(report.label).toBe('NOT-A-MEASUREMENT');
    expect(report.classified).toBeGreaterThan(0);
  });

  test('a run with NO model id recorded can never be a measurement (defensive lane)', async () => {
    const report = await runEval({
      classify: async () => ({ category: 'benign', confidence: 0.9, model: 'x' }),
      mode: 'mock',
    });
    expect(report.modelId).toBeUndefined();
    expect(report.label).toBe('NOT-A-MEASUREMENT'); // isMockModelId(undefined) === true
    expect(report.claimable).toBe(false);
  });
});
