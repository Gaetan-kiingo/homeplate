// src/schemas/reviews.js — U4-REVIEWS: request schemas for the FR-05 review surface,
// enforced by the ONE shared validation middleware (src/middleware/validate.js).
//
// Requirement traceability (SRS Appendix B):
//   FR-05 (TC-05) — createReviewParams validates the :id path segment of
//                   POST /api/bookings/:id/reviews; createReviewBody is the review itself:
//                   rating MUST be an INTEGER 1..5 (a float, a string or an out-of-range
//                   value is the acceptance 422), comment is bounded sanitized free text,
//                   and imageKeys are previously minted object-storage keys (the "including
//                   photos" clause; WHOSE namespace they are is the service's 403).
//
//   FR-05 TEXT REQUIREMENT — RATIFIED 2026-08-26 (was an open spec question; verification
//   findings TCC-W4-02 / TCB-W4-03 / RTLT-W4-02 / F-ADR4-02 / COV-W4-02, report W4-F2).
//                   DECISION: option (a) — a review comment is REQUIRED, min 1 char, and that
//                   is the team's ratified reading of FR-05 for v1.0. A photo-only review
//                   ({rating, imageKeys} with no text) is a 422 by design, not by omission.
//                   SRS §3.1 FR-05 ("reviews ... including photos and a numerical rating")
//                   does not mandate text and does not forbid a photo-only review, so this
//                   is a choice the specification left open and the team has now made.
//                   WHY IT IS ALSO LOAD-BEARING: both moderation adapters' classify() throw
//                   TypeError on empty/whitespace text (src/adapters/llmModeration.js /
//                   .mock.js) — not the typed retryable ModerationProviderError — so an
//                   empty-bodied review's moderation.scan job (moderation/repo projects
//                   coalesce(body,'')) would retry then PERMANENTLY dead-letter, stranding
//                   the review pending forever (ADR-002/ADR-003).
//                   TO REVISIT THIS (the rejected option (b)): relaxing min:1 REQUIRES the
//                   pipeline change in the SAME unit — skip the LLM stage for empty text and
//                   route the image-bearing item to the human queue per ADR-002, which is the
//                   right direction anyway since the v1.0 pipeline is a TEXT classifier and
//                   cannot inspect images. Relaxing this schema alone reintroduces the
//                   permanent dead-letter above. The natural trigger is UT-01: if a study
//                   participant reaches for a photo-only review and cannot post it, that is
//                   evidence, and the change becomes justified rather than speculative.
//   FR-08 / AB-01 / AB-04 — nothing here publishes anything: a valid body only ever becomes
//                   a moderation_status='pending' row (service), so hostile-but-well-formed
//                   content still meets the ADR-002 pipeline before any reader.
//   NFR-11 / AB-06 (ST-04) — every shape composes src/schemas/common.js (uuid, safeText)
//                   and the ONE canonical storage-key schema (src/schemas/media.js) rather
//                   than redefining per-module copies; hostile strings fail as 422 shape
//                   violations or arrive as inert sanitized data — never markup, never SQL.
//   AB-08         — imageKeys are bounded in count and validated to the canonical S3-safe
//                   shape (no '..' traversal) before the service ever sees them.
'use strict';

const { z } = require('zod');
const common = require('./common');
const { storageKey } = require('./media');

/** Photos one review may carry (NFR-02 — no unbounded attachment fan-out per request). */
const MAX_IMAGE_KEYS = 6;

/** :id path param of POST /api/bookings/:id/reviews (the completed booking under review). */
const createReviewParams = z.object({
  id: common.uuid,
});

/** POST /api/bookings/:id/reviews — {rating 1..5 int, comment, imageKeys[]} (FR-05). */
const createReviewBody = z.object({
  rating: z
    .number({ invalid_type_error: 'must be a number' })
    .int('must be an integer')
    .min(1, 'must be at least 1')
    .max(5, 'must be at most 5'),
  comment: common.safeText({ min: 1, max: 2000 }),
  imageKeys: z.array(storageKey).max(MAX_IMAGE_KEYS).default([]),
});

module.exports = {
  createReviewParams,
  createReviewBody,
  MAX_IMAGE_KEYS,
};
