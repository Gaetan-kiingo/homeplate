// src/schemas/moderation.js — U4-MODERATION: request schemas for the FR-08 moderator
// surface, enforced by the ONE shared validation middleware (src/middleware/validate.js).
//
// Requirement traceability (SRS Appendix B):
//   FR-08 (TC-08)  — queueQuery filters/pages GET /api/moderation/queue; decisionParams +
//                    decisionBody shape POST /api/moderation/queue/:id/decision
//                    (approve/reject + FR-08 category + optional note).
//   NFR-11 / AB-06 — every route declares schemas built from src/schemas/common.js
//                    (uuid, pagination, safeText): hostile ids and bodies fail as 422 shape
//                    violations or arrive as inert sanitized data, never as SQL or markup,
//                    and the route-enumeration conformance check proves full coverage.
//   NFR-02         — the queue page is bounded by the shared capped `pagination` schema.
'use strict';

const { z } = require('zod');
const common = require('./common');

/** §3.4 moderation_queue_status domain, mirrored for the queue filter. */
const QUEUE_STATUSES = Object.freeze(['open', 'in_review', 'resolved']);

/** §3.4 moderation_content_type domain (the FR-08 v1.0 surfaces). */
const CONTENT_TYPES = Object.freeze(['listing', 'review', 'message']);

/** FR-08 taxonomy a human decision records (ADR-008). */
const CATEGORIES = Object.freeze(['offensive', 'spam', 'fraudulent', 'benign']);

/** GET /api/moderation/queue — filtered, paged, newest first. */
const queueQuery = common.pagination.extend({
  status: z.enum(QUEUE_STATUSES).optional(),
  contentType: z.enum(CONTENT_TYPES).optional(),
});

/** :id path param of POST /api/moderation/queue/:id/decision (the queue item). */
const decisionParams = z.object({
  id: common.uuid,
});

/** The human decision: approve/reject + category + optional note (build-plan §4A). The note
 *  is sanitized free text (AB-06) persisted on the MODERATION_DECISION row — it is never
 *  logged (NFR-08 keeps audit records to IDs and categories). */
const decisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  category: z.enum(CATEGORIES),
  note: common.safeText({ min: 1, max: 1000 }).optional(),
});

module.exports = {
  QUEUE_STATUSES,
  CONTENT_TYPES,
  CATEGORIES,
  queueQuery,
  decisionParams,
  decisionBody,
};
