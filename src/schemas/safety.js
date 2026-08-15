// src/schemas/safety.js — U4-SAFETY: request schemas for the FR-07 safety-alert surface,
// enforced by the ONE shared validation middleware (src/middleware/validate.js).
//
// Requirement traceability (SRS Appendix B):
//   FR-07 (TC-07, IT-04) — raiseAlertParams validates the :id path segment of
//                   POST /api/bookings/:id/safety-alerts; the alert itself carries NO
//                   caller-supplied content (§3.4 SAFETY_ALERT is booking + raiser + delivery
//                   state only), so the body schema is the empty object: unknown keys are
//                   stripped and nothing free-text — which would need FR-08 moderation
//                   before anyone could read it — can enter the safety path.
//   NFR-11 / AB-06 — every route on this surface declares a schema built from
//                   src/schemas/common.js (uuid, pagination); hostile ids and pagination
//                   values fail as shape violations (422) instead of reaching SQL, and the
//                   route-enumeration conformance check can prove full coverage.
//   NFR-02        — the moderator queue is paginated by the shared capped `pagination`
//                   schema: no caller can demand an unbounded page of alerts.
'use strict';

const { z } = require('zod');
const common = require('./common');

/** :id path param of POST /api/bookings/:id/safety-alerts (the booking the alert is about). */
const raiseAlertParams = z.object({
  id: common.uuid,
});

/** The alert body carries nothing: IDs only (§3.4). Declared so the route is enumerable. */
const raiseAlertBody = z.object({});

/** Input-less GET routes still declare a query validator (NFR-11 route enumeration). */
const noInput = z.object({});

/** The §3.4 alert_delivery_status domain, mirrored for the moderator queue filter. */
const ALERT_DELIVERY_STATUSES = Object.freeze([
  'pending',
  'retrying',
  'delivered',
  'failed',
  'no_channel',
]);

/** GET /api/moderation/alerts — moderator queue, newest first, optionally status-filtered. */
const alertQueueQuery = common.pagination.extend({
  status: z.enum(ALERT_DELIVERY_STATUSES).optional(),
});

module.exports = {
  raiseAlertParams,
  raiseAlertBody,
  noInput,
  alertQueueQuery,
  ALERT_DELIVERY_STATUSES,
};
