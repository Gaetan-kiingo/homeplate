// tests/fixtures/moderation-eval/set-integrity.test.js — U4-EVALSET.
//
// Requirement traceability (SRS Appendix B):
//   NFR-10 (IT-03) — the ADR-008 evaluation set exists, is versioned, holds >= 200 balanced
//                    labelled items, and the metric definitions the bound is measured with behave
//                    as specified. Also proves the two gates that stand between a measured number
//                    and an NFR-10 pass: the human label sign-off (ADR-008) and a live model id
//                    (ADR-007). This suite does NOT measure NFR-10 and does not claim it.
//   FR-08  (TC-08) — the corpus covers the four routing categories across all four v1.0 content
//                    surfaces (listing, review, message, profile).
//   NFR-13         — the provenance contract holds on disk: synthetic, never scraped, and no
//                    personal data (fictional handles, reserved 555-01xx numbers, .example domains).
'use strict';

const fs = require('fs');
const path = require('path');

const evalSet = require('.');
const mockClassifier = require('../../../src/adapters/llmModeration.mock');

const SET_VERSION = 'v1';

/** Deep clone through JSON so a test can hypothesise a signed-off manifest without touching disk. */
function cloneSet(set, mutate) {
  const copy = {
    ...set,
    manifest: JSON.parse(JSON.stringify(set.manifest)),
    items: set.items.map((item) => ({ ...item })),
  };
  copy.benignItems = copy.items.filter((item) => item.label === 'benign');
  copy.violatingItems = copy.items.filter((item) => item.label !== 'benign');
  if (mutate) mutate(copy);
  return copy;
}

describe('ADR-008 evaluation set (v1) — structure, balance and provenance', () => {
  const set = evalSet.loadSet(SET_VERSION);

  test('the set is present, versioned, and passes the full ADR-008 contract', () => {
    expect(evalSet.listVersions()).toContain(SET_VERSION);
    expect(fs.existsSync(path.join(set.dir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(set.dir, 'MANIFEST.md'))).toBe(true);
    expect(evalSet.validateSet(set)).toEqual([]);
    expect(() => evalSet.assertValidSet(set)).not.toThrow();
  });

  test('at least 200 items, balanced across the four FR-08 categories (SRS §4.2)', () => {
    expect(set.items.length).toBeGreaterThanOrEqual(evalSet.MIN_ITEMS);
    expect(Object.keys(set.counts).sort()).toEqual([...evalSet.CATEGORIES].sort());
    const counts = evalSet.CATEGORIES.map((category) => set.counts[category]);
    expect(Math.min(...counts)).toBeGreaterThan(0);
    // "balanced proportions": no class more than 10% off an equal share.
    const share = set.items.length / evalSet.CATEGORIES.length;
    for (const count of counts) {
      expect(Math.abs(count - share)).toBeLessThanOrEqual(share * 0.1);
    }
    expect(set.benignItems.length + set.violatingItems.length).toBe(set.items.length);
  });

  test('every v1.0 content surface is represented in every violating class (FR-08)', () => {
    for (const surface of evalSet.SURFACES) {
      expect(set.items.some((item) => item.surface === surface)).toBe(true);
    }
    for (const category of evalSet.VIOLATING_CATEGORIES) {
      const surfaces = new Set(
        set.items.filter((item) => item.label === category).map((item) => item.surface)
      );
      expect(surfaces.size).toBeGreaterThanOrEqual(3);
    }
  });

  test('item ids and texts are unique — no item is measured twice', () => {
    const ids = set.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const texts = set.items.map((item) => item.text.toLowerCase().replace(/\s+/g, ' ').trim());
    expect(new Set(texts).size).toBe(texts.length);
  });

  test('benign class carries the hard negatives the false-positive rate depends on', () => {
    const hard = set.benignItems.filter((item) => item.traits.includes('hard-negative'));
    expect(hard.length).toBeGreaterThanOrEqual(20);
    // Honest criticism, safety reports and quoted abuse must survive moderation: silently
    // removing them is the false positive NFR-10 bounds.
    for (const trait of ['negative-review', 'safety-report', 'quotes-abuse', 'lexical-lookalike']) {
      expect(set.benignItems.some((item) => item.traits.includes(trait))).toBe(true);
    }
  });

  test('provenance: synthetic, never scraped, no personal data (ADR-008, NFR-13)', () => {
    const { provenance } = set.manifest;
    expect(provenance.synthetic).toBe(true);
    expect(provenance.scraped).toBe(false);
    expect(provenance.sources).toEqual([]);
    expect(provenance.containsRealUserContent).toBe(false);
    expect(provenance.containsPersonalData).toBe(false);
    expect(provenance.authoredBy).toMatch(/\S/);

    for (const item of set.items) {
      const text = item.text.toLowerCase();
      // Every domain-like token must sit in the reserved .example TLD.
      for (const match of text.match(/\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}\b/g) || []) {
        expect(`${item.id}: ${match}`).toMatch(/\.example$/);
      }
      // Every phone-like token must sit in the reserved 555-01xx range.
      for (const match of text.match(/\b\d{3}-\d{4}\b/g) || []) {
        expect(`${item.id}: ${match}`).toMatch(/555-01\d{2}$/);
      }
      expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/); // no email addresses at all
    }
  });
});

describe('NFR-10 metric definitions — score()', () => {
  const set = evalSet.loadSet(SET_VERSION);
  const perfect = set.items.map((item) => ({ id: item.id, category: item.label }));

  test('a perfect run scores 0% false positives and 0% false negatives', () => {
    const result = evalSet.score(set, perfect);
    expect(result.falsePositives).toBe(0);
    expect(result.falseNegatives).toBe(0);
    expect(result.falsePositiveRate).toBe(0);
    expect(result.falseNegativeRate).toBe(0);
    expect(result.accuracy).toBe(1);
    expect(result.withinBound).toBe(true);
    expect(result.itemCount).toBe(set.items.length);
  });

  test('false positive = benign flagged; false negative = violating passed; misroute = neither', () => {
    const benignIds = set.benignItems.slice(0, 3).map((item) => item.id);
    const offensiveIds = set.items
      .filter((item) => item.label === 'offensive')
      .slice(0, 2)
      .map((item) => item.id);
    const spamId = set.items.find((item) => item.label === 'spam').id;

    const predictions = perfect.map((entry) => {
      if (benignIds.includes(entry.id)) return { id: entry.id, category: 'spam' };
      if (offensiveIds.includes(entry.id)) return { id: entry.id, category: 'benign' };
      if (entry.id === spamId) return { id: entry.id, category: 'fraudulent' };
      return entry;
    });

    const result = evalSet.score(set, predictions);
    expect(result.falsePositives).toBe(3);
    expect(result.falsePositiveIds.sort()).toEqual([...benignIds].sort());
    expect(result.falseNegatives).toBe(2);
    expect(result.falseNegativeIds.sort()).toEqual([...offensiveIds].sort());
    expect(result.misrouted).toBe(1);
    expect(result.misroutedIds).toEqual([spamId]);
    expect(result.falsePositiveRate).toBeCloseTo(3 / set.benignItems.length, 10);
    expect(result.falseNegativeRate).toBeCloseTo(2 / set.violatingItems.length, 10);
    // 3/56 = 5.36% — above the bound, so this hypothetical run fails NFR-10.
    expect(result.withinBound).toBe(false);
    expect(result.confusion.benign.spam).toBe(3);
    expect(result.confusion.offensive.benign).toBe(2);
  });

  test('a partial, malformed or foreign prediction set cannot produce a rate', () => {
    expect(() => evalSet.score(set, perfect.slice(0, 10))).toThrow(/no prediction/);
    const badCategory = perfect.map((entry, index) =>
      index === 0 ? { id: entry.id, category: 'toxic' } : entry
    );
    expect(() => evalSet.score(set, badCategory)).toThrow(/outside the FR-08 taxonomy/);
    expect(() =>
      evalSet.score(set, [...perfect, { id: 'not-an-item', category: 'benign' }])
    ).toThrow(/unknown item id/);
  });
});

describe('ADR-007 / ADR-008 claim gates — why no NFR-10 number may be quoted yet', () => {
  const set = evalSet.loadSet(SET_VERSION);

  // Until 2026-08-21 this test asserted the OPPOSITE — that the labels were unreviewed — so a
  // sign-off could not appear unnoticed. The labels were reviewed and signed off on that date, so
  // the assertion is INVERTED rather than deleted: it now pins that the sign-off is well-formed
  // (reviewer, ISO date, matching set version) AND that NFR-10 is still not claimable, because
  // the label gate was only one of several. Deleting it would leave the claim gate unguarded in
  // both directions, which is the failure this whole file exists to prevent.
  test('the labels are signed off, and the sign-off is well formed (ADR-008)', () => {
    const review = set.manifest.labelReview;
    expect(review.status).toBe('signed-off');
    expect(typeof review.reviewer).toBe('string');
    expect(review.reviewer.trim().length).toBeGreaterThan(0);
    expect(review.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(review.date))).toBe(false);
    expect(review.setVersion).toBe(set.version);
  });

  test('sign-off satisfies the PRECONDITIONS only — there is still no run and no results file', () => {
    // Read claimability()'s contract carefully: it answers "IF a run were made with this model
    // and prompt, could its numbers be claimed?" — it gates on set validity, the label sign-off,
    // a non-mock model id and a recorded prompt version. It does NOT assert that a run happened,
    // because the rates come from the run itself (score() → withinBound). So after the 2026-08-21
    // sign-off, a hypothetical LIVE model legitimately returns claimable: true, and that is not an
    // NFR-10 pass. What still makes NFR-10 unclaimable in reality is asserted here: no pipeline,
    // no recorded run, no results file.
    expect(set.hasResults).toBe(false);
    expect(fs.existsSync(set.resultsPath)).toBe(false);

    const preconditions = evalSet.claimability({
      set,
      modelId: 'a-real-live-model-id',
      promptVersion: 'moderation-prompt-v1',
    });
    expect(preconditions.claimable).toBe(true);
    expect(preconditions.reasons).toEqual([]);

    // …and the gates that DO still bite, on the two ways a run could be worthless:
    expect(evalSet.claimability({ set, modelId: '', promptVersion: 'p' }).claimable).toBe(false);
    expect(evalSet.claimability({ set, modelId: 'live', promptVersion: '' }).claimable).toBe(false);
    expect(() => evalSet.assertClaimable({ set, modelId: '', promptVersion: '' })).toThrow(
      /NFR-10 may not be claimed/
    );
  });

  test('even a signed-off set cannot be claimed through a mock classifier (ADR-007)', () => {
    const signedOff = cloneSet(set, (copy) => {
      copy.manifest.labelReview = {
        status: 'signed-off',
        reviewer: 'Reviewer Under Test',
        date: '2026-08-14',
        setVersion: SET_VERSION,
      };
    });
    expect(evalSet.validateSet(signedOff)).toEqual([]);

    const viaMock = evalSet.claimability({
      set: signedOff,
      modelId: mockClassifier.model,
      promptVersion: 'moderation-prompt-v1',
    });
    expect(viaMock.claimable).toBe(false);
    expect(viaMock.reasons.join(' ')).toMatch(/mock/i);
    expect(evalSet.isMockModelId(mockClassifier.model)).toBe(true);
    expect(evalSet.isMockModelId('')).toBe(true);
    expect(evalSet.isMockModelId(undefined)).toBe(true);

    // A missing prompt version is its own blocker (the bound must be re-checkable).
    const noPrompt = evalSet.claimability({ set: signedOff, modelId: 'live-model-id' });
    expect(noPrompt.claimable).toBe(false);
    expect(noPrompt.reasons.join(' ')).toMatch(/prompt version/i);

    // The gate is not unconditionally closed: sign-off + live model + prompt version passes.
    const ready = evalSet.claimability({
      set: signedOff,
      modelId: 'live-model-id',
      promptVersion: 'moderation-prompt-v1',
    });
    expect(ready).toEqual({ claimable: true, provisional: false, reasons: [] });
  });

  test('an unbalanced or shrunken set is refused before any rate is computed', () => {
    const shrunk = cloneSet(set, (copy) => {
      copy.items = copy.items.filter((item) => item.label !== 'benign');
      copy.benignItems = [];
      copy.violatingItems = copy.items;
      copy.counts = { offensive: 56, spam: 56, fraudulent: 56, benign: 0 };
    });
    const problems = evalSet.validateSet(shrunk);
    expect(problems.join(' ')).toMatch(/has no items/);
    expect(
      evalSet.claimability({ set: shrunk, modelId: 'live', promptVersion: 'v1' }).claimable
    ).toBe(false);
  });

  test('scoring through the ADR-007 mock produces an invented rate — the gate is why that is safe', async () => {
    // The mock is a fixed fixture-pattern matcher: unseen text scores benign/0.99. Running the
    // corpus through it is the exact mistake ADR-008 guards against, so the numbers it yields
    // must never be reportable.
    const predictions = [];
    for (const item of set.items) {
      const { category } = await mockClassifier.classify(item.text);
      predictions.push({ id: item.id, category });
    }
    const result = evalSet.score(set, predictions);

    // Nearly every genuinely violating item is waved through: an artefact of the fixture, not a
    // measurement of any classifier's recall.
    expect(result.falseNegativeRate).toBeGreaterThan(0.9);
    // And the blocklist-shaped patterns trip over benign hard negatives that quote abuse or
    // mention a gift card, which is what makes the hard negatives worth having.
    expect(result.falsePositives).toBeGreaterThanOrEqual(1);

    const verdict = evalSet.claimability({
      set,
      modelId: mockClassifier.model,
      promptVersion: 'moderation-prompt-v1',
    });
    expect(verdict.claimable).toBe(false);
    // Before the 2026-08-21 label sign-off this produced TWO reasons (unreviewed labels AND a
    // mock model id). The sign-off removed the first; assert the one that matters here rather
    // than a count that tracked an unrelated gate.
    expect(verdict.reasons.join(' ')).toMatch(/mock/i);
  });
});
