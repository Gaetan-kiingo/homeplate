// tests/fixtures/moderation-eval/index.js — U4-EVALSET: loader, validator, scorer and
// claim gate for the ADR-008 moderation evaluation set.
//
// Requirement traceability (SRS Appendix B):
//   NFR-10 (IT-03) — owns the operational definition of the bound: a false positive is a benign
//                    item classified into any violating category, a false negative is a violating
//                    item classified benign, and BOTH rates must be < 0.05. score() computes them
//                    from a set + predictions; claimability() decides whether the numbers may be
//                    reported as a pass at all.
//   FR-08  (TC-08) — the taxonomy scored here (offensive / spam / fraudulent / benign) is the one
//                    the moderation pipeline routes on.
//   NFR-13         — validateSet() enforces the ADR-008 provenance contract (synthetic, never
//                    scraped, no personal data), so the set cannot silently acquire real content.
//
// ADR-008 is the reason claimability() exists: "no NFR-10 result may be reported as a pass until a
// human team member has reviewed and signed off the labels", recorded with reviewer, date and set
// version. ADR-007 adds the second gate: CI and the automated suite run the deterministic MOCK
// classifier, which is a fixed fixture-pattern matcher with no discriminating power over unseen
// text — a rate measured through it carries no information about NFR-10, so a mock model id can
// never yield a claimable result.
//
// This module is test-fixture code: pure fs + arithmetic, no adapter and no database.
'use strict';

const fs = require('fs');
const path = require('path');

/** FR-08 / ADR-008 taxonomy. */
const CATEGORIES = Object.freeze(['offensive', 'spam', 'fraudulent', 'benign']);
/** Everything that is not 'benign' — a hit on any of these keeps public content unpublished. */
const VIOLATING_CATEGORIES = Object.freeze(['offensive', 'spam', 'fraudulent']);
/** Content surfaces the v1.0 scope moderates (SRS §1.2). */
const SURFACES = Object.freeze(['listing', 'review', 'message', 'profile']);
/** SRS §4.2 IT-03: "a labeled evaluation set of at least 200 items". */
const MIN_ITEMS = 200;
/** NFR-10: "false positive and false negative rates of less than 5%". */
const MAX_RATE = 0.05;
/** "balanced proportions" (SRS §4.2) — every class within 10% of an equal share. */
const BALANCE_TOLERANCE = 0.1;

const VERSION_DIR = /^v\d+$/;
/** A model id that names a mock/stub/fixture classifier can never back an NFR-10 claim. */
const NON_LIVE_MODEL = /mock|stub|fake|fixture|dummy/i;

/** Versioned set directories present on disk, ascending (["v1", "v2", ...]). */
function listVersions() {
  return fs
    .readdirSync(__dirname, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function countByLabel(items) {
  const counts = {};
  for (const category of CATEGORIES) counts[category] = 0;
  for (const item of items) {
    counts[item.label] = (counts[item.label] || 0) + 1;
  }
  return counts;
}

/**
 * Loads a versioned evaluation set.
 * @param {string} [version] set directory name, default the highest version present
 * @returns {{version: string, dir: string, manifest: object, items: object[], counts: object,
 *            benignItems: object[], violatingItems: object[], resultsPath: string,
 *            hasResults: boolean}}
 */
function loadSet(version) {
  const versions = listVersions();
  const chosen = version || versions[versions.length - 1];
  if (!chosen) {
    throw new Error(`moderation-eval: no versioned set directory under ${__dirname}`);
  }
  const dir = path.join(__dirname, chosen);
  if (!fs.existsSync(dir)) {
    throw new Error(`moderation-eval: set version "${chosen}" does not exist (${dir})`);
  }
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const items = [];
  for (const relative of manifest.itemFiles) {
    const file = path.join(dir, relative);
    const parsed = readJson(file);
    if (!Array.isArray(parsed)) {
      throw new Error(`moderation-eval: ${relative} must contain a JSON array of items`);
    }
    for (const item of parsed) items.push({ ...item, sourceFile: relative });
  }
  const resultsPath = path.join(dir, manifest.resultsFile || 'RESULTS.md');
  return {
    version: chosen,
    dir,
    manifest,
    items,
    counts: countByLabel(items),
    benignItems: items.filter((item) => item.label === 'benign'),
    violatingItems: items.filter((item) => item.label !== 'benign'),
    resultsPath,
    hasResults: fs.existsSync(resultsPath),
  };
}

function normaliseText(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Checks a loaded set against the ADR-008 / SRS §4.2 contract.
 * @param {object} set as returned by loadSet()
 * @returns {string[]} human-readable problems; empty means the set is well formed
 */
function validateSet(set) {
  const problems = [];
  const { manifest, items, counts, version } = set;

  if (manifest.setVersion !== version) {
    problems.push(
      `manifest.setVersion "${manifest.setVersion}" does not match directory "${version}"`
    );
  }
  const minimum = manifest.minimumItems || MIN_ITEMS;
  if (minimum < MIN_ITEMS) {
    problems.push(`manifest.minimumItems ${minimum} is below the SRS §4.2 floor of ${MIN_ITEMS}`);
  }
  if (items.length < MIN_ITEMS) {
    problems.push(`set holds ${items.length} items, below the required ${MIN_ITEMS} (SRS §4.2)`);
  }
  if (!Array.isArray(manifest.categories) || manifest.categories.length !== CATEGORIES.length) {
    problems.push('manifest.categories must list exactly the four FR-08 categories');
  } else {
    for (const category of CATEGORIES) {
      if (!manifest.categories.includes(category)) {
        problems.push(`manifest.categories is missing "${category}"`);
      }
    }
  }

  // Per-item shape.
  const seenIds = new Set();
  const seenText = new Map();
  for (const item of items) {
    const where = item.id || `(${item.sourceFile} item without an id)`;
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      problems.push(`${item.sourceFile}: an item has no id`);
    } else if (seenIds.has(item.id)) {
      problems.push(`duplicate item id "${item.id}"`);
    } else {
      seenIds.add(item.id);
    }
    if (!CATEGORIES.includes(item.label)) {
      problems.push(`${where}: label "${item.label}" is not one of ${CATEGORIES.join(', ')}`);
    }
    if (!SURFACES.includes(item.surface)) {
      problems.push(`${where}: surface "${item.surface}" is not one of ${SURFACES.join(', ')}`);
    }
    if (typeof item.text !== 'string' || item.text.trim().length < 20) {
      problems.push(`${where}: text must be a string of at least 20 characters`);
    } else {
      const key = normaliseText(item.text);
      if (seenText.has(key)) {
        problems.push(`${where}: text duplicates ${seenText.get(key)}`);
      } else {
        seenText.set(key, item.id);
      }
    }
    if (!Array.isArray(item.traits) || item.traits.some((t) => typeof t !== 'string')) {
      problems.push(`${where}: traits must be an array of strings`);
    }
  }

  // Balance across the four classes (SRS §4.2 "balanced proportions").
  const share = items.length / CATEGORIES.length;
  for (const category of CATEGORIES) {
    if (counts[category] === 0) {
      problems.push(`category "${category}" has no items`);
      continue;
    }
    if (Math.abs(counts[category] - share) > share * BALANCE_TOLERANCE) {
      problems.push(
        `category "${category}" holds ${counts[category]} items, outside ${Math.round(
          BALANCE_TOLERANCE * 100
        )}% of an equal share (${share})`
      );
    }
  }
  if (manifest.declaredCounts) {
    for (const category of CATEGORIES) {
      if (manifest.declaredCounts[category] !== counts[category]) {
        problems.push(
          `manifest.declaredCounts.${category} (${manifest.declaredCounts[category]}) does not match the ${counts[category]} items on disk`
        );
      }
    }
    if (manifest.declaredCounts.total !== items.length) {
      problems.push(
        `manifest.declaredCounts.total (${manifest.declaredCounts.total}) does not match the ${items.length} items on disk`
      );
    }
  }

  // ADR-008 / NFR-13 provenance contract.
  const provenance = manifest.provenance || {};
  if (provenance.synthetic !== true) {
    problems.push('provenance.synthetic must be true — the set is written, not collected');
  }
  if (provenance.scraped !== false) {
    problems.push('provenance.scraped must be false (ADR-008: never scraped)');
  }
  if (!Array.isArray(provenance.sources) || provenance.sources.length > 0) {
    problems.push('provenance.sources must be an empty array — no third-party corpus may be used');
  }
  if (provenance.containsPersonalData !== false) {
    problems.push('provenance.containsPersonalData must be false (NFR-13)');
  }
  if (typeof provenance.authoredBy !== 'string' || provenance.authoredBy.trim() === '') {
    problems.push('provenance.authoredBy must name who authored the set');
  }

  // Hard negatives are what make the false-positive rate meaningful.
  const hardNegatives = set.benignItems.filter(
    (item) => Array.isArray(item.traits) && item.traits.includes('hard-negative')
  );
  if (hardNegatives.length < 10) {
    problems.push(
      `only ${hardNegatives.length} benign items are tagged 'hard-negative'; at least 10 are needed for the false-positive rate to mean anything`
    );
  }

  // Sign-off block shape (its *content* is checked by claimability(), not here).
  const review = manifest.labelReview;
  if (!review || typeof review !== 'object') {
    problems.push('manifest.labelReview is missing (ADR-008 sign-off block)');
  } else if (!['unreviewed', 'signed-off'].includes(review.status)) {
    problems.push(
      `manifest.labelReview.status "${review.status}" must be unreviewed or signed-off`
    );
  } else if (review.status === 'signed-off') {
    if (!review.reviewer) problems.push('a signed-off set must name the reviewer (ADR-008)');
    if (!review.date) problems.push('a signed-off set must record the sign-off date (ADR-008)');
    if (review.setVersion !== version) {
      problems.push(`labelReview.setVersion "${review.setVersion}" does not match "${version}"`);
    }
  }

  return problems;
}

/** validateSet(), but throws on the first problem list rather than returning it. */
function assertValidSet(set) {
  const problems = validateSet(set);
  if (problems.length > 0) {
    throw new Error(
      `moderation-eval ${set.version} violates ADR-008:\n  - ${problems.join('\n  - ')}`
    );
  }
  return set;
}

function toPredictionMap(predictions) {
  if (predictions instanceof Map) return new Map(predictions);
  const map = new Map();
  if (Array.isArray(predictions)) {
    for (const entry of predictions) {
      map.set(entry.id, entry.category);
    }
    return map;
  }
  for (const [id, category] of Object.entries(predictions || {})) {
    map.set(id, category);
  }
  return map;
}

/**
 * Scores pipeline predictions against the set's labels (NFR-10 / IT-03).
 *
 * @param {object} set loaded by loadSet()
 * @param {Map<string,string>|Array<{id:string, category:string}>|Object<string,string>} predictions
 * @returns {object} counts, per-class breakdown, confusion matrix and both NFR-10 rates
 */
function score(set, predictions) {
  const predicted = toPredictionMap(predictions);
  const missing = [];
  const invalid = [];

  const confusion = {};
  for (const expected of CATEGORIES) {
    confusion[expected] = {};
    for (const got of CATEGORIES) confusion[expected][got] = 0;
  }

  let falsePositives = 0;
  let falseNegatives = 0;
  let misrouted = 0;
  let correct = 0;
  const falsePositiveIds = [];
  const falseNegativeIds = [];
  const misroutedIds = [];

  for (const item of set.items) {
    const got = predicted.get(item.id);
    if (got === undefined) {
      missing.push(item.id);
      continue;
    }
    if (!CATEGORIES.includes(got)) {
      invalid.push(`${item.id} -> "${got}"`);
      continue;
    }
    confusion[item.label][got] += 1;
    if (got === item.label) {
      correct += 1;
    } else if (item.label === 'benign') {
      falsePositives += 1;
      falsePositiveIds.push(item.id);
    } else if (got === 'benign') {
      falseNegatives += 1;
      falseNegativeIds.push(item.id);
    } else {
      misrouted += 1;
      misroutedIds.push(item.id);
    }
  }

  const unknown = [...predicted.keys()].filter((id) => !set.items.some((item) => item.id === id));
  if (missing.length > 0) {
    throw new Error(
      `moderation-eval: ${missing.length} item(s) have no prediction (e.g. ${missing
        .slice(0, 5)
        .join(', ')}) — a partial run cannot produce an NFR-10 rate`
    );
  }
  if (invalid.length > 0) {
    throw new Error(
      `moderation-eval: prediction(s) outside the FR-08 taxonomy: ${invalid.slice(0, 5).join(', ')}`
    );
  }
  if (unknown.length > 0) {
    throw new Error(
      `moderation-eval: prediction(s) for unknown item id(s): ${unknown.slice(0, 5).join(', ')}`
    );
  }

  const benignCount = set.benignItems.length;
  const violatingCount = set.violatingItems.length;
  const falsePositiveRate = benignCount === 0 ? 0 : falsePositives / benignCount;
  const falseNegativeRate = violatingCount === 0 ? 0 : falseNegatives / violatingCount;

  const perClass = {};
  for (const category of CATEGORIES) {
    const expectedCount = set.counts[category];
    perClass[category] = {
      items: expectedCount,
      correct: confusion[category][category],
      recall: expectedCount === 0 ? 0 : confusion[category][category] / expectedCount,
    };
  }

  return {
    setVersion: set.version,
    itemCount: set.items.length,
    benignCount,
    violatingCount,
    correct,
    accuracy: set.items.length === 0 ? 0 : correct / set.items.length,
    falsePositives,
    falsePositiveRate,
    falsePositiveIds,
    falseNegatives,
    falseNegativeRate,
    falseNegativeIds,
    misrouted,
    misroutedIds,
    perClass,
    confusion,
    withinBound: falsePositiveRate < MAX_RATE && falseNegativeRate < MAX_RATE,
  };
}

/** True when `modelId` names a mock/stub classifier rather than a live provider model (ADR-007). */
function isMockModelId(modelId) {
  return typeof modelId !== 'string' || modelId.trim() === '' || NON_LIVE_MODEL.test(modelId);
}

/**
 * Decides whether an IT-03 run over `set` may be reported as an NFR-10 pass (ADR-007 + ADR-008).
 * A run that is not claimable is not "failed" — its numbers are *provisional* and NFR-10 stays open.
 *
 * @param {{set: object, modelId?: string, promptVersion?: string}} run
 * @returns {{claimable: boolean, provisional: boolean, reasons: string[]}}
 */
function claimability(run) {
  const { set, modelId, promptVersion } = run;
  const reasons = validateSet(set);

  const review = (set.manifest && set.manifest.labelReview) || {};
  if (review.status !== 'signed-off') {
    reasons.push(
      'the label sign-off is missing: ADR-008 requires a human reviewer to review and sign off the labels before any NFR-10 pass may be claimed'
    );
  } else {
    if (!review.reviewer) reasons.push('the sign-off records no reviewer name (ADR-008)');
    if (!review.date) reasons.push('the sign-off records no date (ADR-008)');
    if (review.setVersion !== set.version) {
      reasons.push(`the sign-off names set version "${review.setVersion}", not "${set.version}"`);
    }
  }

  if (isMockModelId(modelId)) {
    reasons.push(
      `model id ${JSON.stringify(modelId)} is absent or names a mock classifier; the ADR-007 mock is a fixed fixture matcher with no discriminating power over unseen text, so rates measured through it say nothing about NFR-10`
    );
  }
  if (typeof promptVersion !== 'string' || promptVersion.trim() === '') {
    reasons.push('no prompt version recorded — ADR-008 requires it so the bound can be re-checked');
  }

  return { claimable: reasons.length === 0, provisional: reasons.length > 0, reasons };
}

/** claimability(), but throws when the run may not be claimed. */
function assertClaimable(run) {
  const verdict = claimability(run);
  if (!verdict.claimable) {
    throw new Error(
      `NFR-10 may not be claimed from this run:\n  - ${verdict.reasons.join('\n  - ')}`
    );
  }
  return verdict;
}

module.exports = {
  CATEGORIES,
  VIOLATING_CATEGORIES,
  SURFACES,
  MIN_ITEMS,
  MAX_RATE,
  listVersions,
  loadSet,
  validateSet,
  assertValidSet,
  score,
  isMockModelId,
  claimability,
  assertClaimable,
};
