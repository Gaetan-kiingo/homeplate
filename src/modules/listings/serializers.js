// src/modules/listings/serializers.js — U3-LISTINGS: the ADR-010 progressive-disclosure
// chokepoint (build-plan wave 3A; SPMP WA-2).
//
// EVERY read path that emits a listing — search (U3-SEARCH), listing detail, host profile
// (U3-HOSTS-MEDIA), booking payloads, wave-4 moderation views — imports THESE two functions
// instead of shaping rows itself. That is the whole ADR-010 defence: one forgotten serializer
// leaks a host's home address silently, so there is exactly one place to get it right.
//
// Requirement traceability (SRS Appendix B):
//   FR-02 (TC-02) — the detail payload: dish, ingredients, allergy warnings, schedule, seats
//            and image URLs derived from media_objects storage keys (ADR-004, mediaUrls).
//   NFR-13 / AB-08 — responses are built from EXPLICIT KEY ALLOWLISTS. publicListing carries
//            NO address line, NO postal code, NO precise lat/lng and no host contact data —
//            only the coarse public-precision projection (coarse_*, area_label, city/region).
//            A scraper harvesting any public payload gets ~300 m areas, never a street.
//   ADR-010 — publicListing is the DEFAULT; privilegedListing (exact street address + precise
//            coordinates) is emitted ONLY behind access.canViewPreciseLocation (pending/
//            in-progress guest, owner, or access-logged FR-07 moderator).
//
// Public interface (build-plan wave-3A contract):
//   publicListing(row, media)      → public allowlist projection
//   privilegedListing(row, media)  → public projection + exact address/coordinates
//   PUBLIC_KEYS / PRIVILEGED_ONLY_KEYS — frozen allowlists (adr-conformance lane audits them)
//   DETAIL_CONTEXT_KEYS / HOST_SUMMARY_KEYS — the FR-02 detail-only extension (host summary
//   + approved host reviews attached by the service on GET /api/listings/:id ONLY)
'use strict';

const mediaUrls = require('../../lib/mediaUrls');

/** The complete public payload key set (AB-08 "explicit field allowlists"). */
const PUBLIC_KEYS = Object.freeze([
  'id',
  'hostId',
  'title',
  'description',
  'ingredients',
  'allergens',
  'cuisine',
  'scheduledStart',
  'durationMinutes',
  'localDate',
  'city',
  'region',
  'country',
  'coarseLat',
  'coarseLng',
  'areaLabel',
  'seatCapacity',
  'seatsRemaining',
  'status',
  'moderationStatus',
  'createdAt',
  'updatedAt',
  'images',
]);

/** Keys ONLY the privileged projection may add (ADR-010 disclosure set). */
const PRIVILEGED_ONLY_KEYS = Object.freeze([
  'addressLine1',
  'addressLine2',
  'postalCode',
  'lat',
  'lng',
]);

/**
 * FR-02 detail-only context keys: the service attaches
 * { host, reviews, reviewsTotal, reviewsPageSize } ON TOP of the listing projection for
 * GET /api/listings/:id — and ONLY there. Search results (U3-SEARCH) and host-page example
 * dishes (U3-HOSTS-MEDIA) stay exactly PUBLIC_KEYS. Every value is composed from the
 * U3-HOSTS-MEDIA repo/serializers (non-PII columns only) or is a plain count, so no key here
 * can widen the ADR-010/NFR-13 disclosure surface.
 *
 * `reviews` is a bounded PREVIEW (NFR-01/NFR-02: no read path returns an unbounded row set),
 * so the payload must SAY it is a page rather than leave a client guessing: reviewsTotal is
 * the number of approved reviews about the host and reviewsPageSize is the preview cap, so
 * `reviewsTotal > reviews.length` tells a client, from the detail response alone, that
 * GET /api/hosts/:id/reviews?page=N&pageSize=M holds the remainder (TCC-04).
 */
const DETAIL_CONTEXT_KEYS = Object.freeze(['host', 'reviews', 'reviewsTotal', 'reviewsPageSize']);

/**
 * The complete FR-02 host-summary key set (NFR-13/AB-08 allowlist): display identity, bio
 * and review aggregates only — never contact data, never any address/location key.
 */
const HOST_SUMMARY_KEYS = Object.freeze(['displayName', 'bio', 'averageRating', 'reviewCount']);

/** Accepts raw listings rows (snake_case) or repo.toListing output (camelCase). */
function field(row, snake, camel) {
  return row[snake] !== undefined ? row[snake] : row[camel];
}

/**
 * Render the MEHKO calendar day (listings.local_date, SQL DATE) as a plain 'YYYY-MM-DD'
 * string on the wire (FR-11, FR-02, ADR-009).
 *
 * node-postgres parses a DATE column into a JS Date at PROCESS-LOCAL midnight, which
 * JSON.stringify would emit as a server-timezone-dependent UTC instant — on any server
 * east of UTC the visible date part shifts to the PREVIOUS day, so a client reading it
 * would see the wrong MEHKO calendar day. The stored value is already the
 * America/Los_Angeles calendar day (mehko.localDateFor at write time), so reading the
 * Date's LOCAL components recovers exactly the SQL calendar date on ANY server timezone.
 * Deliberately NOT mehko.localDateFor here: re-projecting a local-midnight instant into
 * LA time would re-introduce the same off-by-one on non-LA servers.
 */
function isoCalendarDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const y = String(value.getFullYear()).padStart(4, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Already a string (e.g. a repo selecting local_date::text): keep the date part only.
  return String(value).slice(0, 10);
}

/**
 * Resolve attached media rows into { id, url, contentType } — URLs derived locally from
 * storage keys (ADR-004, src/lib/mediaUrls — no adapter, no network on the request path).
 * Accepts media/repo camelCase rows or raw media_objects rows.
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

/**
 * PUBLIC projection (the ADR-010 DEFAULT for every read path). Explicit allowlist — no
 * address line, no postal code, no precise coordinates, no host contact data can ever
 * appear here regardless of what the row carries (NFR-13, AB-08).
 *
 * @param {object} row    listings row (snake_case) or repo.toListing output (camelCase)
 * @param {Array}  [media]  media_objects rows for the listing (ADR-004)
 */
function publicListing(row, media = []) {
  if (!row || typeof row !== 'object') {
    throw new TypeError('publicListing: row is required');
  }
  return {
    id: row.id,
    hostId: field(row, 'host_id', 'hostId'),
    title: row.title,
    description: row.description,
    ingredients: row.ingredients,
    allergens: row.allergens,
    cuisine: row.cuisine ?? null,
    scheduledStart: field(row, 'scheduled_start', 'scheduledStart'),
    durationMinutes: field(row, 'duration_minutes', 'durationMinutes'),
    localDate: isoCalendarDate(field(row, 'local_date', 'localDate')),
    // Coarse locality context only (ADR-010): city-level text plus the coarsened projection.
    city: row.city ?? null,
    region: row.region ?? null,
    country: row.country ?? null,
    coarseLat: field(row, 'coarse_lat', 'coarseLat') ?? null,
    coarseLng: field(row, 'coarse_lng', 'coarseLng') ?? null,
    areaLabel: field(row, 'area_label', 'areaLabel') ?? null,
    seatCapacity: field(row, 'seat_capacity', 'seatCapacity'),
    seatsRemaining: field(row, 'seats_remaining', 'seatsRemaining'),
    status: row.status,
    moderationStatus: field(row, 'moderation_status', 'moderationStatus'),
    createdAt: field(row, 'created_at', 'createdAt'),
    updatedAt: field(row, 'updated_at', 'updatedAt'),
    images: imagesFor(media),
  };
}

/**
 * PRIVILEGED projection (ADR-010): the public shape PLUS the exact street address and
 * precise coordinates. Emitted ONLY for the listing's own host, a guest holding a
 * pending/in-progress booking on this listing, or a moderator handling an FR-07 safety
 * alert on it (access-logged) — enforced by src/modules/listings/access.js, never here.
 */
function privilegedListing(row, media = []) {
  return {
    ...publicListing(row, media),
    addressLine1: field(row, 'address_line1', 'addressLine1') ?? null,
    addressLine2: field(row, 'address_line2', 'addressLine2') ?? null,
    postalCode: field(row, 'postal_code', 'postalCode') ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
  };
}

module.exports = {
  publicListing,
  privilegedListing,
  PUBLIC_KEYS,
  PRIVILEGED_ONLY_KEYS,
  DETAIL_CONTEXT_KEYS,
  HOST_SUMMARY_KEYS,
};
