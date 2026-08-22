// src/modules/moderation/prefilter.js — U4-MODERATION: stage 1 of the ADR-002 moderation
// pipeline — the deterministic pre-filter (blocklist / regex / per-author submission rate
// limit) that runs BEFORE the LLM stage and blocks obvious violations instantly with ZERO
// provider calls.
//
// Requirement traceability (SRS Appendix B):
//   FR-08 (TC-08)  — check(text) is the deterministic first stage: a blocklist hit yields a
//                    'blocked' verdict with its FR-08 taxonomy category, which the pipeline
//                    records as a MODERATION_DECISION with decided_by='pre_filter' and NO
//                    LLM call (ADR-002 "blocks obvious violations instantly").
//   AB-01/AB-03    — fraudulent-listing and spam-flood patterns are pre-filter rules, so the
//                    cheapest attacks are refused before they cost a provider call; the
//                    RATE_LIMIT knob flags a high-volume submitter for human review (spam).
//   AB-04          — the offensive-language blocklist applies to every scanned surface
//                    (listing, review, message) through the one shared pipeline.
//   NFR-09 (RT-01) — the pre-filter is pure local computation: a moderation-provider outage
//                    cannot degrade it, so stage 1 keeps rejecting obvious violations even
//                    while stage 2 defers (public content stays pending either way).
//   NFR-13 / ADR-007 — liveContentGate(text) is the ratified data-use gate: classification
//                    through the LIVE provider is permitted only when the signed data-use
//                    review stands ratified AND the content carries nothing personal-shaped
//                    (email/phone). Content that fails the gate is NEVER sent to the
//                    provider; the pipeline escalates it to the human Moderator queue
//                    instead (ADR-007: "the 'would have called the LLM' path still routes to
//                    the human Moderator queue whenever the content gate fails").
//
// Knob note (build-plan §4A): the blocklist and the rate limit are DELIBERATE module-level
// frozen configuration, exported for tests and tuning. They are not MEHKO caps (ADR-009 —
// those live in src/config/locale.js exclusively) and src/config/schema.js is a shared file
// owned by no wave-4 unit, so the knobs live here, in the one module that reads them.
'use strict';

/** FR-08 taxonomy (ADR-008; mirrors src/adapters/llmModeration.mock CATEGORIES). */
const CATEGORIES = Object.freeze(['offensive', 'spam', 'fraudulent', 'benign']);

/**
 * Per-author submission rate limit (ADR-002 "rate limits"): more than
 * maxSubmissionsPerWindow pieces of scanned content from ONE author inside windowMinutes
 * flags the author's next submission as probable spam and routes it to the human queue —
 * it never auto-rejects, because volume alone is a signal, not proof (AB-03).
 */
const RATE_LIMIT = Object.freeze({
  windowMinutes: 60,
  maxSubmissionsPerWindow: 15,
});

/**
 * ADR-007 ratified free-tier data-use review (docs/adr007-data-use-review.md). The GATE
 * binds on this recorded ratification plus the content check below — never on the mere
 * existence of the review file. Flipping `ratified` to false closes live classification
 * entirely (every scan escalates to the human queue), which is the ADR-002 safe direction.
 */
const DATA_USE_REVIEW = Object.freeze({
  ratified: true,
  option: '(a)+(b) — only non-personal content may reach the live provider',
  signedBy: 'Gaetan Rieben',
  signedOn: '2026-08-18',
  countersignedBy: 'Nam Tran',
  countersignedOn: '2026-08-21',
  document: 'docs/adr007-data-use-review.md',
});

// ---- personal-data shapes (NFR-13 / ADR-007 content gate) ------------------------------------
// Mirrors the shapes src/outbox/outbox.js rejects in payloads: an email-shaped substring
// anywhere, or a phone-shaped token (7-15 digits, optional +/separators). ISO dates are not
// phones. Kept intentionally conservative: a false "personal" hit merely routes the item to a
// human, while a miss would send personal content to a third party — so the gate over-blocks.
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_TOKEN = /(?:^|[\s:;,(<])\+?[0-9][0-9\s().-]{5,18}[0-9](?:$|[\s.,;)>!?])/;
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `text` contains a phone-shaped token that is not an ISO date. */
function containsPhoneShape(text) {
  const match = PHONE_TOKEN.exec(text);
  if (!match) return false;
  const token = match[0].replace(/^[\s:;,(<]+|[\s.,;)>!?]+$/g, '');
  if (ISO_DATE_SHAPE.test(token)) return false;
  const digits = token.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

// ---- blocklist (ADR-002 stage 1) -------------------------------------------------------------
// Deterministic rules for OBVIOUS violations only — nuance belongs to the LLM stage and the
// human queue. Every rule carries the FR-08 category its hit decides, and a stable rule id so
// the MODERATION_DECISION row and the audit record can name WHICH rule fired without ever
// logging the content itself (NFR-08 / §3.4: IDs and rule names only, never text).
//
// The patterns deliberately do NOT overlap the deterministic mock classifier's fixture
// patterns (src/adapters/llmModeration.mock.js — "wire transfer", "click here", …), so tests
// can drive stage 2 without stage 1 swallowing the probe.
const BLOCKLIST = Object.freeze([
  Object.freeze({
    id: 'offensive.direct-threat',
    category: 'offensive',
    test: (text) => /\bkill\s+your(?:self|selves)\b|\bkys\b|\bgo\s+die\b/i.test(text),
  }),
  Object.freeze({
    id: 'offensive.dehumanizing',
    category: 'offensive',
    test: (text) =>
      /\bsubhuman\s+(?:scum|trash|filth)\b|\byou\s+people\s+are\s+vermin\b/i.test(text),
  }),
  Object.freeze({
    id: 'spam.link-farm',
    category: 'spam',
    // Three or more links in one submission is link farming on every Homeplate surface.
    test: (text) => (text.match(/https?:\/\//gi) || []).length >= 3,
  }),
  Object.freeze({
    id: 'spam.bulk-promo',
    category: 'spam',
    test: (text) =>
      /\bcasino\s+bonus\b|\bcrypto\s+giveaway\b|\bfollow\s+for\s+follow\b/i.test(text),
  }),
  Object.freeze({
    id: 'fraud.offsite-wire',
    category: 'fraudulent',
    test: (text) => /\bwestern\s+union\b|\bmoneygram\b/i.test(text),
  }),
  Object.freeze({
    id: 'fraud.advance-fee',
    category: 'fraudulent',
    test: (text) => /\bsend\s+(?:me\s+)?\$?\d+[\s\S]{0,60}\brefund\b/i.test(text),
  }),
]);

/**
 * Stage 1: deterministic blocklist/regex check (FR-08, ADR-002).
 * @param {string} text  the scanned content text (already sanitized at the API boundary)
 * @returns {{verdict: 'blocked', category: string, rule: string} | {verdict: 'pass'}}
 */
function check(text) {
  if (typeof text !== 'string') {
    throw new TypeError('prefilter.check(text): text must be a string');
  }
  for (const rule of BLOCKLIST) {
    if (rule.test(text)) {
      return { verdict: 'blocked', category: rule.category, rule: rule.id };
    }
  }
  return { verdict: 'pass' };
}

/**
 * The ADR-007 data-use gate for LIVE classification (NFR-13). The pipeline consults it only
 * when the resolved adapter mode is 'live'; the deterministic mock never leaves the process.
 * @param {string} text
 * @returns {{allowed: boolean, reasons: string[]}} reasons name the failing condition —
 *          they never quote the content.
 */
function liveContentGate(text) {
  if (typeof text !== 'string') {
    throw new TypeError('prefilter.liveContentGate(text): text must be a string');
  }
  const reasons = [];
  if (DATA_USE_REVIEW.ratified !== true) {
    reasons.push('data-use review not ratified (ADR-007 §7)');
  }
  if (EMAIL_SHAPE.test(text)) {
    reasons.push('content contains an email-shaped token (option (a)+(b): non-personal only)');
  }
  if (containsPhoneShape(text)) {
    reasons.push('content contains a phone-shaped token (option (a)+(b): non-personal only)');
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Rate-limit verdict from a submission count the repository measured (ADR-002 "rate
 * limits"; AB-03). Pure so the threshold logic is unit-testable without a database.
 * @param {number} recentCount  submissions by the author inside RATE_LIMIT.windowMinutes,
 *                              INCLUDING the one under scan
 * @returns {boolean} true when the author exceeded the window budget
 */
function exceedsRateLimit(recentCount) {
  if (!Number.isFinite(recentCount) || recentCount < 0) {
    throw new TypeError(
      'prefilter.exceedsRateLimit(recentCount): a non-negative number is required'
    );
  }
  return recentCount > RATE_LIMIT.maxSubmissionsPerWindow;
}

module.exports = {
  CATEGORIES,
  RATE_LIMIT,
  DATA_USE_REVIEW,
  BLOCKLIST,
  check,
  liveContentGate,
  exceedsRateLimit,
};
