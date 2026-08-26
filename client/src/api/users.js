// client/src/api/users.js — U5-API-CLIENT: /api/users/me + the privacy module's
// /api/users/me/* lifecycle endpoints, transcribed from src/modules/users/routes.js and
// src/modules/privacy/routes.js on this tree (never invented).
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-12 — requestDeletion(): DELETE /api/users/me answers 202 (accepted now, erased at
//     the scheduled instant) and clears the session server-side — callers must treat it as
//     a logout too.
//   NFR-13 — requestExport()/getExport(): the CCPA export request lifecycle (202 + 30-day
//     SLA; data present once status is 'completed').
//   AB-08 — me() is the caller's OWN profile only; there is no read path for other users'
//     profiles here (hosts are served via the ADR-010 host-page allowlist, ./hosts.js).
import { get, patch, post, del, pathParam } from './http.js';

/**
 * GET /api/users/me — the authenticated user's own profile (401 ⇒ anonymous; the session
 * store hydrates from exactly this call).
 * @returns {Promise<{user: import('./types.js').SessionUser}>}
 */
export function me() {
  return get('/api/users/me');
}

/**
 * PATCH /api/users/me — profile update + server-side eligibility recomputation (NFR-06).
 * @param {object} body  partial profile fields (src/schemas/auth.js profileUpdate)
 * @returns {Promise<{user: import('./types.js').SessionUser}>}
 */
export function updateMe(body) {
  return patch('/api/users/me', { body });
}

/**
 * DELETE /api/users/me — NFR-12 account deletion request (202; session destroyed).
 * @returns {Promise<{request: object}>}
 */
export function requestDeletion() {
  return del('/api/users/me');
}

/**
 * POST /api/users/me/export — NFR-13 data export request (202; the worker produces the copy).
 * @returns {Promise<{request: object}>}
 */
export function requestExport() {
  return post('/api/users/me/export', { body: {} });
}

/**
 * GET /api/users/me/export/:id — one export request; `export.data` present once completed.
 * @param {string} id
 * @returns {Promise<{export: object}>}
 */
export function getExport(id) {
  return get(`/api/users/me/export/${pathParam(id, 'id')}`);
}
