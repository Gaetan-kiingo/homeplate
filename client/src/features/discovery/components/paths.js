// client/src/features/discovery/components/paths.js — U6-DISCOVERY URL-string builders.
// Cross-feature navigation happens BY URL STRING ONLY (build-plan §6 wave-6 rule): the
// discovery screens link to the booking flow (U6-BOOKING) and the login screen
// (U6-ACCOUNT-MOD) without importing any other feature's files.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-02 — the listing-detail Reserve CTA targets /bookings/new?listing=<id> (FR-12 flow).
//   FR-01 / FR-03 — listing cards link to /listings/:id; host links to /hosts/:id; the host
//     page links back to /search?hostId=<id> (the FR-01 host filter).
//   AB-08 — every discovery endpoint is session-gated server-side, so a 401 sends the user
//     to /login carrying a `next` param with the page they wanted (never a dead end).

/** FR-02 listing detail. */
export function listingPath(id) {
  return `/listings/${encodeURIComponent(id)}`;
}

/** FR-03 host profile. */
export function hostPath(id) {
  return `/hosts/${encodeURIComponent(id)}`;
}

/** FR-12 booking flow entry (U6-BOOKING's route, addressed by URL string only). */
export function newBookingPath(listingId) {
  return `/bookings/new?listing=${encodeURIComponent(listingId)}`;
}

/** FR-01 search filtered to one host's meals. */
export function searchByHostPath(hostId) {
  return `/search?hostId=${encodeURIComponent(hostId)}`;
}

/**
 * AB-08 401 handling: the login screen (U6-ACCOUNT-MOD's route), carrying where the user
 * was headed so a successful sign-in can return there.
 * @param {{pathname: string, search: string}} location  react-router location
 */
export function loginPath(location) {
  const next = `${location.pathname}${location.search}`;
  return `/login?next=${encodeURIComponent(next)}`;
}
