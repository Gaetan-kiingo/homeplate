// src/modules/hosts/serializers.js — U3-HOSTS-MEDIA: explicit-allowlist projections for the
// FR-03 host personal page (build-plan wave 3B; SPMP WA-8).
//
// Requirement traceability (SRS Appendix B):
//   FR-03 (TC-03) — hostPage assembles selfIntroduction (host_profiles.bio), exampleDishes,
//            approved reviews with numeric ratings + averageRating/reviewCount, and the
//            kitchen/dining image URLs derived locally from media_objects storage keys
//            (ADR-004, src/lib/mediaUrls — no adapter, no network on the request path).
//   NFR-13 / AB-08 — responses are built from EXPLICIT KEY ALLOWLISTS (frozen below, audited
//            by the adr-conformance lane): no email, no phone, no emergency contact, no
//            password hash, no exact street address for ANY user can appear — the repo never
//            even fetches those columns, and this module never spreads a row.
//   ADR-010 — exampleDishes are shaped EXCLUSIVELY by the U3-LISTINGS publicListing
//            serializer (the one progressive-disclosure chokepoint): coarse coordinates and
//            area label only, never an address line or precise lat/lng. This module adds no
//            location key of its own.
//   FR-05 / NFR-12 — publicReview renders an anonymized-safe author display: a review whose
//            author was erased (author_id severed / account deleted) shows a neutral display
//            name instead of breaking or leaking anything.
//
// Public interface (build-plan wave-3B contract):
//   hostPage({host, profileMedia, listings, mediaByListing, reviews, stats})
//   publicReview(row)
//   roundedAverage(value)
//   HOST_PAGE_KEYS / REVIEW_KEYS — frozen allowlists (test + adr-conformance audits)
'use strict';

const mediaUrls = require('../../lib/mediaUrls');
const listingSerializers = require('../listings/serializers');

/** The complete host-page payload key set (NFR-13 "assert by key allowlist"). */
const HOST_PAGE_KEYS = Object.freeze([
  'id',
  'displayName',
  'memberSince',
  'selfIntroduction',
  'images',
  'exampleDishes',
  'reviews',
  'averageRating',
  'reviewCount',
]);

/** The complete public-review key set (FR-05 numeric rating; no author contact data). */
const REVIEW_KEYS = Object.freeze([
  'id',
  'rating',
  'body',
  'createdAt',
  'authorId',
  'authorDisplayName',
]);

/** Display name shown for reviews whose author was anonymized/deleted (NFR-12). */
const ANONYMIZED_AUTHOR = 'Former Homeplate member';

/**
 * Resolve media rows ({id, storage_key, content_type}) into {id, url, contentType} —
 * URLs derived locally from storage keys (ADR-004; pure computation, request-path safe).
 */
function imagesFor(media) {
  if (!Array.isArray(media)) return [];
  return media
    .map((m) => {
      const storageKey = m.storageKey !== undefined ? m.storageKey : m.storage_key;
      if (typeof storageKey !== 'string' || storageKey.length === 0) return null;
      return {
        id: m.id,
        url: mediaUrls.urlForKey(storageKey),
        contentType: m.contentType !== undefined ? m.contentType : (m.content_type ?? null),
      };
    })
    .filter(Boolean);
}

/** Presentation rounding for averageRating (2 decimals; null-safe). */
function roundedAverage(value) {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value) * 100) / 100;
}

/**
 * PUBLIC review projection (FR-03/FR-05). Explicit allowlist — rating is numeric, the author
 * appears as id + display name only (no email/phone/contact data exists in the input row by
 * repo construction, and no key beyond REVIEW_KEYS can leave here).
 * @param {object} row  hosts repo listApprovedReviews row
 */
function publicReview(row) {
  if (!row || typeof row !== 'object') {
    throw new TypeError('publicReview: row is required');
  }
  return {
    id: row.id,
    rating: Number(row.rating),
    body: row.body ?? null,
    createdAt: row.created_at,
    authorId: row.author_id ?? null,
    authorDisplayName: row.author_full_name ?? ANONYMIZED_AUTHOR,
  };
}

/**
 * The FR-03 host personal page (GET /api/hosts/:id) — the ONLY shape that endpoint returns.
 *
 * @param {object} input
 * @param {object} input.host            hosts repo findHost output
 * @param {Array}  input.profileMedia    live host_profile media rows (kitchen/dining images)
 * @param {Array}  input.listings        approved active upcoming listings rows (FR-03
 *                                       example dishes; listings repo findApprovedByHost)
 * @param {Map}    input.mediaByListing  listing id → live media rows
 * @param {Array}  input.reviews         approved reviews page (hosts repo)
 * @param {{reviewCount: number, averageRating: number|null}} input.stats
 */
function hostPage({ host, profileMedia, listings, mediaByListing, reviews, stats }) {
  if (!host || typeof host !== 'object') {
    throw new TypeError('hostPage: host is required');
  }
  const byListing = mediaByListing instanceof Map ? mediaByListing : new Map();
  return {
    id: host.id,
    displayName: host.fullName ?? ANONYMIZED_AUTHOR,
    memberSince: host.memberSince,
    selfIntroduction: host.bio ?? null,
    images: imagesFor(profileMedia),
    // ADR-010: the ONE public-listing chokepoint shapes every example dish — coarse
    // location only, never an address (see module header).
    exampleDishes: (Array.isArray(listings) ? listings : []).map((row) =>
      listingSerializers.publicListing(row, byListing.get(row.id) || [])
    ),
    reviews: (Array.isArray(reviews) ? reviews : []).map(publicReview),
    averageRating: roundedAverage(stats ? stats.averageRating : null),
    reviewCount: stats ? stats.reviewCount : 0,
  };
}

module.exports = {
  hostPage,
  publicReview,
  imagesFor,
  roundedAverage,
  HOST_PAGE_KEYS,
  REVIEW_KEYS,
  ANONYMIZED_AUTHOR,
};
