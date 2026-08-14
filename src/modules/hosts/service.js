// src/modules/hosts/service.js — U3-HOSTS-MEDIA: the FR-03 host personal-page service
// (build-plan wave 3B; SPMP WA-8).
//
// Requirement traceability (SRS Appendix B):
//   FR-03 (TC-03) — getHostPage composes: self-introduction (host_profiles.bio), example
//            dishes (the host's approved active upcoming listings via the U3-LISTINGS repo,
//            shaped by ITS publicListing serializer — ADR-010 chokepoint), approved reviews
//            about the host with numeric ratings + averageRating/reviewCount, and the
//            kitchen/dining image URLs from media_objects storage keys (ADR-004).
//            listHostReviews serves the paginated review list (LT-01 target). An unknown,
//            deleted, or profile-less user is a 404 on both.
//   FR-02  — the host summary data consumed alongside listing detail comes from the same
//            repo/serializer pair, so the two pages can never disagree on what is public.
//   FR-08  — only approved reviews and approved listings are ever read (repo-level filters);
//            pending/rejected content is invisible here in every state.
//   NFR-13 / AB-08 — output is serializers.hostPage / publicReview allowlists ONLY; the
//            repo never fetches PII columns, this service never adds a field. AB-08's 401
//            gate (requireSession) sits at the route.
//   NFR-11 — inputs are validated at the boundary (src/schemas/hosts.js); all SQL is
//            parameterized in the repos.
//   ADR-001/003 — pure PostgreSQL reads + local URL derivation: nothing reachable from this
//            module imports src/adapters/*; no network call happens on this request path.
'use strict';

const { NotFoundError } = require('../../lib/errors');
const repo = require('./repo');
const listingsRepo = require('../listings/repo');
const serializers = require('./serializers');

// Presentation page sizes (bounded reads, NFR-02). Not regulatory values — the ADR-009
// config-only rule covers MEHKO caps; these are response-shape constants.
const EXAMPLE_DISHES_LIMIT = 12;
const PROFILE_REVIEWS_LIMIT = 5;

/**
 * Resolve the host or 404. Unknown id, deleted account and a user with no host profile are
 * deliberately indistinguishable (AB-08 — the response never confirms account existence).
 */
async function requireHost(hostId) {
  const host = await repo.findHost(hostId);
  if (!host) throw new NotFoundError('Host not found');
  return host;
}

/**
 * FR-03: the host personal page (GET /api/hosts/:id).
 * @param {{userId: string}} _auth  authenticated viewer (AB-08: 401 enforced at the route);
 *                                  the page is public-shape for every viewer, owner included
 * @param {string} hostId
 * @returns {Promise<object>} serializers.hostPage allowlist projection
 */
async function getHostPage(_auth, hostId) {
  const host = await requireHost(hostId);

  // Example dishes: approved + active + upcoming only (FR-03/FR-08), soonest first.
  const listings = await listingsRepo.findApprovedByHost(hostId, { limit: EXAMPLE_DISHES_LIMIT });
  const mediaByListing = await repo.listMediaForListings(listings.map((row) => row.id));
  const profileMedia = await repo.listHostProfileMedia(hostId);
  const stats = await repo.getReviewStats(hostId);
  const reviews = await repo.listApprovedReviews(hostId, { limit: PROFILE_REVIEWS_LIMIT });

  return serializers.hostPage({ host, profileMedia, listings, mediaByListing, reviews, stats });
}

/**
 * FR-03: the paginated approved-reviews list (GET /api/hosts/:id/reviews; LT-01 target).
 * @param {{userId: string}} _auth  authenticated viewer (401 at the route)
 * @param {string} hostId
 * @param {{page: number, pageSize: number}} pageInput  validated pagination (bounded)
 * @returns {Promise<{reviews: object[], page: number, pageSize: number, total: number,
 *                    averageRating: number|null, reviewCount: number}>}
 */
async function listHostReviews(_auth, hostId, { page, pageSize }) {
  await requireHost(hostId);

  const stats = await repo.getReviewStats(hostId);
  const rows = await repo.listApprovedReviews(hostId, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    reviews: rows.map(serializers.publicReview),
    page,
    pageSize,
    total: stats.reviewCount,
    averageRating: serializers.roundedAverage(stats.averageRating),
    reviewCount: stats.reviewCount,
  };
}

module.exports = { getHostPage, listHostReviews, EXAMPLE_DISHES_LIMIT, PROFILE_REVIEWS_LIMIT };
