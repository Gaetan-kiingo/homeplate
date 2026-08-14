// src/adapters/llmModeration.mock.js — U2-MEDIA-LLM: deterministic mock moderation
// classifier (ADR-007 — CI and the whole automated suite run THIS adapter; only the IT-03
// measurement run may call the live provider).
//
// Requirement traceability (SRS Appendix B):
//   FR-08 (TC-08)  — same {category, confidence, model} contract as the live adapter, so the
//                    wave-4 moderation pipeline (pre-filter → classifier → human queue) is
//                    fully exercisable offline, including confidence-threshold routing via
//                    the LOW_CONFIDENCE sentinel.
//   NFR-10 (IT-03) — deterministic fixture mapping: the same input always yields the same
//                    {category, confidence}, so evaluation-harness plumbing is testable
//                    without provider noise. The reported model id names the MOCK so a mock
//                    run can never be mistaken for a live NFR-10 measurement (ADR-008).
//   NFR-09 (RT-01) — the outage sentinel and setOutage() simulate a provider failure as the
//                    same typed retryable error the live adapter raises, so the ADR-002 rule
//                    (public content stays pending, never publishes unreviewed) is testable.
//
// ADR-001/ADR-003 — WORKER-ONLY MODULE, like every file under src/adapters/.
//
// ModerationProviderError is defined HERE (not in llmModeration.js) so both adapters can
// share one class without a circular require: llmModeration.js already depends on this file
// for mock-mode resolution and re-exports the class.
'use strict';

const { ServiceUnavailableError } = require('../lib/errors');

/**
 * Typed provider failure (FR-08 / NFR-09): retryable by default, so the outbox worker backs
 * off and retries while public content stays 'pending' — an outage NEVER publishes
 * unreviewed content (ADR-002). Match instanceof or code MODERATION_PROVIDER_UNAVAILABLE.
 */
class ModerationProviderError extends ServiceUnavailableError {
  constructor(message = 'Moderation provider unavailable', options = {}) {
    super(message, { code: 'MODERATION_PROVIDER_UNAVAILABLE', ...options });
  }
}

/** The moderation taxonomy (SRS NFR-10 / ADR-008: offensive, spam, fraudulent, benign). */
const CATEGORIES = Object.freeze(['offensive', 'spam', 'fraudulent', 'benign']);

// Identifies the mock in every result and MODERATION_DECISION row — deliberately NOT a real
// provider model id, so a mock run is self-evidently not an IT-03 live measurement.
const MOCK_MODEL_ID = 'mock-moderation-deterministic-v1';

// Sentinels for deterministic drills (RT-01 outage; FR-08 threshold routing).
const OUTAGE_SENTINEL = '[[LLM_OUTAGE]]';
const LOW_CONFIDENCE_SENTINEL = '[[LOW_CONFIDENCE]]';

// Fixed fixture mapping text patterns -> {category, confidence} (ADR-007: deterministic).
// Groups are checked IN ORDER (offensive > spam > fraudulent); the first match wins, so a
// text hitting several groups still classifies deterministically. No match => benign 0.99.
const FIXTURE = Object.freeze([
  Object.freeze({
    category: 'offensive',
    confidence: 0.97,
    patterns: Object.freeze([
      /\bidiot\b/i,
      /\bhate you\b/i,
      /\bdisgusting people\b/i,
      /offensive-fixture/i,
    ]),
  }),
  Object.freeze({
    category: 'spam',
    confidence: 0.95,
    patterns: Object.freeze([
      /click here/i,
      /buy now/i,
      /limited time offer/i,
      /free money/i,
      /spam-fixture/i,
    ]),
  }),
  Object.freeze({
    category: 'fraudulent',
    confidence: 0.93,
    patterns: Object.freeze([
      /wire transfer/i,
      /gift card/i,
      /pay outside the (app|platform)/i,
      /fraud-fixture/i,
    ]),
  }),
]);

const BENIGN = Object.freeze({ category: 'benign', confidence: 0.99 });
const LOW_CONFIDENCE_RESULT = Object.freeze({ category: 'benign', confidence: 0.4 });

let forcedOutage = false;

/** Force every classify() call to fail like a provider outage (RT-01 drills). */
function setOutage(active) {
  forcedOutage = active === true;
}

/** Restores normal deterministic behaviour. */
function reset() {
  forcedOutage = false;
}

/**
 * Deterministically classifies `text` with the same contract as the live adapter.
 * @param {string} text
 * @returns {Promise<{category: string, confidence: number, model: string}>}
 */
async function classify(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError('llmModeration.classify(text): text must be a non-empty string');
  }
  if (forcedOutage || text.includes(OUTAGE_SENTINEL)) {
    throw new ModerationProviderError('Moderation provider unavailable (mock outage)');
  }
  if (text.includes(LOW_CONFIDENCE_SENTINEL)) {
    return { ...LOW_CONFIDENCE_RESULT, model: MOCK_MODEL_ID };
  }
  for (const group of FIXTURE) {
    if (group.patterns.some((pattern) => pattern.test(text))) {
      return { category: group.category, confidence: group.confidence, model: MOCK_MODEL_ID };
    }
  }
  return { ...BENIGN, model: MOCK_MODEL_ID };
}

module.exports = {
  mode: 'mock',
  model: MOCK_MODEL_ID,
  classify,
  setOutage,
  reset,
  ModerationProviderError,
  CATEGORIES,
  FIXTURE,
  OUTAGE_SENTINEL,
  LOW_CONFIDENCE_SENTINEL,
};
