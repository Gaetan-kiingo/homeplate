// src/schemas/privacy.js — U4-PRIVACY: request schemas for the NFR-12/NFR-13 data-lifecycle
// surface, enforced by the ONE shared validation middleware (src/middleware/validate.js).
//
// Requirement traceability (SRS Appendix B):
//   NFR-12 (ST-05) — DELETE /api/users/me carries no input: `noInput` still declares a
//                    schema so the route joins the NFR-11 route-enumeration sweep, and any
//                    body a client does send is stripped to {} (zod object semantics) —
//                    a deletion request can never smuggle parameters.
//   NFR-13 (ST-06) — POST /api/users/me/export likewise takes no input (the export scope is
//                    the WHOLE §3.4 register for the authenticated user — never a caller-
//                    chosen subset, so there is nothing to parameterize); GET
//                    /api/users/me/export/:id validates the request id as a canonical UUID.
//   NFR-11 / AB-06 (ST-04) — shapes compose src/schemas/common.js; hostile path segments
//                    fail as 422 shape violations before any SQL runs.
//   AB-08          — no schema here accepts a target user id: every route operates on the
//                    SESSION identity only (req.auth), so one user can never aim a deletion
//                    or an export at another.
'use strict';

const { z } = require('zod');
const common = require('./common');

/** Input-less routes still declare a validator (NFR-11 route enumeration; cf. schemas/auth). */
const noInput = z.object({});

/** :id path param of GET /api/users/me/export/:id — the data_requests row being fetched. */
const exportGetParams = z.object({
  id: common.uuid,
});

module.exports = {
  noInput,
  exportGetParams,
};
