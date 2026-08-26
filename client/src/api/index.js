// client/src/api/index.js — U5-API-CLIENT: the published wave-5 interface
// (build-plan §6.1 5B): `import { api, ApiError } from '../api/index.js'`.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-03 / AB-05 — every resource call goes through the ONE fetch wrapper (./http.js):
//     credentials included, opaque HttpOnly cookie never read, every 401 broadcast to the
//     session store (./sessionEvents.js → client/src/session).
//   NFR-07 (groundwork) — `catch (e) { e.code }` is stable across the whole surface.
//   NFR-09 — api.search() models degraded mode as a state, never an exception.
//   AB-08 / ADR-010 — the payload shapes are documented in ./types.js; every endpoint here
//     is transcribed from src/modules/*/routes.js on this tree, and the endpoint-surface
//     spec (endpoints.test.js) fails if any client endpoint has no backend route.
import * as auth from './auth.js';
import * as users from './users.js';
import * as listings from './listings.js';
import { search } from './search.js';
import * as hosts from './hosts.js';
import * as bookings from './bookings.js';
import * as messages from './messages.js';
import * as reviews from './reviews.js';
import * as safety from './safety.js';
import * as moderation from './moderation.js';
import * as media from './media.js';

export { ApiError, NETWORK_ERROR, UNEXPECTED_RESPONSE, MEDIA_UPLOAD_FAILED } from './errors.js';
export { onSessionExpired } from './sessionEvents.js';

/**
 * The Homeplate API client. Per-resource modules; `api.search` is itself the callable
 * FR-01 search (returns the NFR-09 state object — see ./search.js).
 */
export const api = Object.freeze({
  auth,
  users,
  listings,
  search,
  hosts,
  bookings,
  messages,
  reviews,
  safety,
  moderation,
  media,
});
