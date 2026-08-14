// src/outbox/handlers/listingGeocode.js — U3-LISTINGS: worker-side geocoding of a listing's
// address, discovered by src/outbox/dispatch.js (build-plan wave 3A; SPMP WA-2).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-11 / FR-01 — POST /api/listings persists the address fields and enqueues
//            'listing.geocode' {listingId} in the SAME transaction; THIS handler resolves the
//            address through the ADR-005 Maps adapter and writes lat/lng (precise, for the
//            ADR-010 privileged serializer) plus coarse_lat/coarse_lng/area_label (the public
//            projection) back to PostgreSQL. Search (U3-SEARCH) and map placement read ONLY
//            the coarse pair (ADR-010).
//   ADR-001/003 — this file is the ONLY place listing geocoding touches the Maps adapter: it
//            runs exclusively under the outbox worker, never on a request path. A Maps outage
//            therefore delays map placement but NEVER blocks or fails listing creation
//            (NFR-09) — safe because the listing is moderation_status='pending' (invisible
//            publicly, FR-08) until approved, long after geocoding completes.
//   NFR-09 — transient Maps failures throw, so the worker's retry/backoff/dead-letter budget
//            applies; a definitive no-results answer is NOT retried (retrying cannot help) —
//            the listing simply keeps a null geocode and the job completes.
//   ADR-010 — the precise coordinates travel job → PostgreSQL only. The adapter's Redis cache
//            never sees them ({ precision: 'exact' } bypasses the cache by design), so no
//            cache read can leak an exact location.
//   NFR-08 — ctx.log is the worker's job-scoped child logger carrying the originating
//            request's correlationId (MT-01); log lines carry listing IDs only, never the
//            address text (SRS §3.4 PII register — a host address is protected data).
//
// Handler contract (build-plan §1 convention 3): { type, handle(payload, ctx) } with
// ctx = { jobId, type, attempt, correlationId, idempotencyKey, log }.
'use strict';

const { logger } = require('../../lib/logger');
// Worker-only import (ADR-001/003): handlers are loaded by dispatch.loadHandlers() under the
// worker, never by the HTTP app factory — the adr-conformance boot check stays adapter-free.
const maps = require('../../adapters/maps');
const { NotFoundError } = require('../../lib/errors');
const listingsRepo = require('../../modules/listings/repo');
const { query } = require('../../db/pool');

const TYPE = 'listing.geocode';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '';
}

module.exports = {
  type: TYPE,

  /**
   * Geocode one listing's stored address and persist both precisions (ADR-010).
   * Idempotent under redelivery: re-running simply rewrites the same coordinates.
   *
   * @param {{listingId: string}} payload  IDs only (ADR-003)
   * @param {{log?: object}} [ctx]         worker job context
   * @returns {Promise<{status: 'geocoded'|'skipped'|'no_results', listingId: string}>}
   * @throws on malformed payload (dead-letters — a caller bug) and on transient Maps
   *   failures (worker retry/backoff/dead-letter, NFR-09)
   */
  async handle(payload, ctx = {}) {
    const log = ctx.log || logger;
    if (!payload || typeof payload !== 'object') {
      throw new TypeError(`${TYPE}: payload must be { listingId }`);
    }
    const { listingId } = payload;
    if (typeof listingId !== 'string' || !UUID_RE.test(listingId)) {
      throw new TypeError(`${TYPE}: payload.listingId must be a UUID`);
    }

    const { rows } = await query(
      `SELECT id, status, address_line1, address_line2, city, region, postal_code, country
       FROM listings WHERE id = $1`,
      [listingId]
    );
    const listing = rows[0];
    if (!listing || listing.status === 'cancelled') {
      // Deleted host (CASCADE) or cancelled listing — nothing worth geocoding.
      log.info({ event: 'listing_geocode_skipped', listingId }, 'listing_geocode_skipped');
      return { status: 'skipped', listingId };
    }

    const address = [
      listing.address_line1,
      listing.address_line2,
      listing.city,
      listing.region,
      listing.postal_code,
      listing.country,
    ]
      .filter(nonBlank)
      .join(', ');
    if (address === '') {
      log.info({ event: 'listing_geocode_skipped', listingId }, 'listing_geocode_skipped');
      return { status: 'skipped', listingId };
    }

    let result;
    try {
      // { precision: 'exact' }: a forced live call whose precise coordinates are returned to
      // THIS worker only and are never written to the Redis cache (ADR-005/ADR-010).
      result = await maps.geocode(address, { precision: 'exact' });
    } catch (err) {
      if (err instanceof NotFoundError) {
        // Definitive answer: the address does not geocode. Retrying cannot help — complete
        // the job; the listing keeps a null geocode (detail still works, map pin absent).
        log.warn(
          { event: 'listing_geocode_no_results', listingId, code: err.code },
          'listing_geocode_no_results'
        );
        return { status: 'no_results', listingId };
      }
      // Transient (timeout/quota/outage): rethrow so the worker retries with backoff and
      // eventually dead-letters, keeping the failure visible (NFR-09).
      throw err;
    }

    // Persist precise (privileged serializer's source) + public precision (ADR-010).
    await listingsRepo.setGeocode(listingId, {
      lat: result.precise.lat,
      lng: result.precise.lng,
      coarseLat: result.lat,
      coarseLng: result.lng,
      areaLabel: result.areaLabel,
    });

    // IDs only in logs — never the address or the precise coordinates (SRS §3.4, ADR-010).
    log.info({ event: 'listing_geocoded', listingId }, 'listing_geocoded');
    return { status: 'geocoded', listingId };
  },
};
