// src/schemas/messaging.js — U4-MESSAGING: request schemas for the FR-06 booking-thread
// surface, enforced by the ONE shared validation middleware (src/middleware/validate.js).
//
// Requirement traceability (SRS Appendix B):
//   FR-06 (TC-06) — messageParams validates the :id path segment of
//                   POST/GET /api/bookings/:id/messages (the booking whose thread it is);
//                   postMessageBody is the message itself: bounded sanitized free text —
//                   the message body IS the content the FR-08 pipeline scans
//                   asynchronously, so it is required and non-empty. listMessagesQuery is
//                   the shared capped pagination for the thread read.
//   NFR-11 / AB-06 (ST-04) — every shape composes src/schemas/common.js (uuid, safeText,
//                   pagination) rather than redefining per-module copies; hostile strings
//                   fail as 422 shape violations or arrive as inert sanitized data —
//                   never markup, never SQL (parameterized statements are the SQLi wall).
//   FR-08 / AB-04 — nothing here publishes or withholds anything: a valid body becomes a
//                   delivered message row born moderation_status='pending' (service), and
//                   the ADR-002 pipeline scans it AFTER delivery.
//   NFR-02        — the thread read is paginated by the shared capped `pagination` schema:
//                   no caller can demand an unbounded page of messages.
'use strict';

const { z } = require('zod');
const common = require('./common');

/** Longest message body accepted at the chat boundary (raw input, before sanitizing). */
const MAX_BODY_CHARS = 2000;

/** :id path param of POST/GET /api/bookings/:id/messages (the booking under discussion). */
const messageParams = z.object({
  id: common.uuid,
});

/** POST /api/bookings/:id/messages — { body } (FR-06). Sanitized bounded free text only:
 *  unknown keys are stripped by the shared middleware, so nothing but the message text can
 *  enter the messaging path. */
const postMessageBody = z.object({
  body: common.safeText({ min: 1, max: MAX_BODY_CHARS }),
});

/** GET /api/bookings/:id/messages — the thread, oldest first, capped pages (NFR-02). */
const listMessagesQuery = common.pagination;

module.exports = {
  messageParams,
  postMessageBody,
  listMessagesQuery,
  MAX_BODY_CHARS,
};
