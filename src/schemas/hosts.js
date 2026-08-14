// src/schemas/hosts.js — U3-HOSTS-MEDIA: zod schemas for every /api/hosts route (API boundary,
// build-plan wave 3B).
//
// Requirement traceability (SRS Appendix B):
//   FR-03 (TC-03) — the host personal page is addressed by host user id (path uuid); the
//            paginated reviews list bounds its page size through the shared pagination
//            schema so no request can demand an unbounded page (NFR-02, LT-01 target).
//   NFR-11 / AB-06 — every /api/hosts route declares its schema through the shared U1-VALID
//            middleware: a hostile :id ('<script>…', '../..', SQLi text) is a 422 shape
//            violation, never a 500 and never a query input (ST-04).
//   NFR-13 / AB-08 — these schemas accept IDENTIFIERS AND PAGINATION ONLY: no field exists
//            through which a caller could request extra personal data; what leaves the API
//            is decided exclusively by src/modules/hosts/serializers.js allowlists.
'use strict';

const { z } = require('zod');
const { uuid, pagination } = require('./common');

/** Path params for /api/hosts/:id and /api/hosts/:id/reviews. */
const idParams = z.object({ id: uuid });

/** GET /api/hosts/:id/reviews query — shared bounded pagination (page, pageSize). */
const reviewsQuery = pagination;

/** Input-less query (GET /api/hosts/:id): unknown keys stripped, validator still declared
 *  so the NFR-11 route enumeration finds a schema on every mounted route. */
const noInput = z.object({});

module.exports = { idParams, reviewsQuery, noInput };
