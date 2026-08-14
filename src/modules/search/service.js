// src/modules/search/service.js — U3-SEARCH: the FR-01 search/discovery service (build-plan
// wave 3B; SPMP WA-2).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-01 (TC-01) — location/time/host/cuisine search over approved active future listings.
//            Location strings resolve through the wave-2 Maps adapter's searchArea (ADR-005);
//            the repo then matches listings within radiusKm of ANY resolved candidate area.
//   NFR-01 (LT-01) — two cache layers keep the hot path off the provider and mostly off
//            PostgreSQL: the adapter's own Redis geocode cache (ADR-005) plus THIS service's
//            result-page cache (cache.wrap; TTL config.search.cacheTtlSeconds). A repeat of
//            an identical query performs ZERO Maps adapter calls — the page cache answers
//            before the adapter is even required.
//   NFR-09 (RT-01) — DEGRADED MODE: the adapter call is resilience-wrapped internally
//            (timeout, bounded retries, backoff — src/lib/resilience via the adapter). When
//            the provider is down the adapter serves its stale Redis copy and flags it; this
//            service passes that through as `degraded: true` on a still-working response and
//            NEVER caches the degraded page (so recovery is visible within one request).
//            When there is no cached area at all, a location query fails as a typed
//            503 SEARCH_DEGRADED with a user-facing message — never an unhandled 500 — while
//            non-location queries are entirely unaffected (they never touch the adapter).
//   NFR-11 — input is validated/stripped at the boundary (src/schemas/search.js); everything
//            that reaches SQL is parameterized (./repo).
//   AB-08 / ADR-010 — every result is shaped EXCLUSIVELY by the U3-LISTINGS publicListing
//            serializer (coarse coordinates + area label; no street address, no precise
//            coordinates, no host contact data). The Redis page cache therefore stores
//            PUBLIC PRECISION ONLY, and its keys are SHA-256 digests of the normalized query
//            — a raw location string (possibly an address) never appears in a key or value.
//   ADR-001/003 + ADR-005 (build-plan §6.1) — the Maps READ adapter is required AT CALL TIME
//            inside resolveAreas(), so app boot loads no adapter (adr-conformance boot and
//            depth-0 static checks). This is the documented ADR-005 read-path exception;
//            SendGrid/FCM/LLM/objectStorage remain worker-only without exception.
'use strict';

const crypto = require('crypto');

const config = require('../../config');
const cache = require('../../lib/cache');
const { key: redisKey } = require('../../db/redis');
const { ServiceUnavailableError } = require('../../lib/errors');
const serializers = require('../listings/serializers');
const repo = require('./repo');

// Default radius when a location is given without radiusKm (km). A UX default, not a MEHKO
// cap (ADR-009 concerns capacity numbers only; those live in src/config/locale.js).
const DEFAULT_RADIUS_KM = 10;

/**
 * Canonical form of a validated search query: one shape → one cache cell. Location text is
 * whitespace-collapsed and lowercased exactly like the Maps adapter normalizes its own cache
 * input, so equivalent spellings share a page.
 * @param {object} query  validated GET /api/listings/search query (src/schemas/search.js)
 * @returns {object} normalized query (also the page-cache identity)
 */
function normalizeQuery(query) {
  const location =
    typeof query.location === 'string' && query.location.trim().length > 0
      ? query.location.trim().replace(/\s+/g, ' ').toLowerCase()
      : null;
  return {
    location,
    // radiusKm is meaningful only with a location; normalized away otherwise so
    // "?radiusKm=5" alone shares the cache cell (and results) of the bare browse.
    radiusKm: location ? (query.radiusKm ?? DEFAULT_RADIUS_KM) : null,
    from: query.from ?? null,
    to: query.to ?? null,
    hostId: query.hostId ?? null,
    cuisine: query.cuisine ?? null,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * Redis key for one normalized query's result page. The key carries a SHA-256 digest, never
 * the query itself: a street address typed into `location` must not leak through key names
 * any more than through values (ADR-010, AB-08 — same rule as the Maps adapter's cache).
 * @param {object} normalized  output of normalizeQuery
 * @returns {string}
 */
function cacheKeyFor(normalized) {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex')
    .slice(0, 32);
  return redisKey('cache', 'search', 'page', digest);
}

/**
 * Resolve a location string to candidate public-precision areas via the Maps adapter
 * (call-time require — see the module header). The adapter is cache-first and
 * resilience-wrapped internally; `degraded` is true when it served a stale cached copy
 * during a provider outage (NFR-09).
 * @param {string} location  normalized location text
 * @returns {Promise<{areas: Array<{lat: number, lng: number, areaLabel: string}>,
 *                    degraded: boolean}>}
 * @throws {ServiceUnavailableError} 503 SEARCH_DEGRADED when the provider is unavailable
 *         and no cached area exists (the documented NFR-09 failure mode, RT-01).
 */
async function resolveAreas(location) {
  // ADR-005 read-path exception (build-plan §6.1): required at CALL TIME so app boot —
  // and every non-location search — never loads an adapter module.
  // eslint-disable-next-line global-require
  const maps = require('../../adapters/maps');
  try {
    const resolved = await maps.searchArea(location);
    return {
      areas: Array.isArray(resolved.areas) ? resolved.areas : [],
      degraded: resolved.degraded === true,
    };
  } catch (err) {
    // Adapter exhausted its retries with no cached fallback (or refused the input): the
    // location dimension is down. Typed, user-facing, never an unhandled 500 (NFR-09).
    throw new ServiceUnavailableError(
      'Location search is temporarily unavailable. Please try again shortly, or search ' +
        'without a location.',
      { code: 'SEARCH_DEGRADED', cause: err }
    );
  }
}

/**
 * Build one result page from the source of truth (PostgreSQL), shaped by the ADR-010
 * public serializer.
 * @param {object} normalized  output of normalizeQuery
 * @returns {Promise<{payload: object, degraded: boolean}>}
 */
async function loadPage(normalized) {
  let areas = null;
  let degraded = false;
  if (normalized.location) {
    const resolved = await resolveAreas(normalized.location);
    areas = resolved.areas; // may be [] — a real "no such place" answer, zero results
    degraded = resolved.degraded;
  }

  const { rows, total } = await repo.searchListings({
    hostId: normalized.hostId,
    cuisine: normalized.cuisine,
    from: normalized.from,
    to: normalized.to,
    areas,
    radiusKm: normalized.radiusKm,
    limit: normalized.pageSize,
    offset: (normalized.page - 1) * normalized.pageSize,
  });

  const mediaByListing = await repo.listMediaForListings(rows.map((row) => row.id));
  // ADR-010: the U3-LISTINGS PUBLIC serializer is the ONLY shape search ever emits — coarse
  // coordinates + area label, explicit key allowlist, no address, no host contact data.
  const results = rows.map((row) =>
    serializers.publicListing(row, mediaByListing.get(row.id) || [])
  );

  const payload = { results, page: normalized.page, pageSize: normalized.pageSize, total };
  if (degraded) payload.degraded = true;
  return { payload, degraded };
}

/**
 * FR-01 search. Read-through page cache first; on a miss the page is built from PostgreSQL
 * (resolving the location through the Maps adapter when present) and cached UNLESS it was
 * served degraded — degraded pages are returned but never stored, so the cache only ever
 * holds healthy public-precision pages (ADR-010, NFR-09).
 * @param {object} query  validated query (src/schemas/search.js)
 * @returns {Promise<{results: object[], page: number, pageSize: number, total: number,
 *                    degraded?: true}>}
 */
async function searchListings(query) {
  const normalized = normalizeQuery(query);
  let degradedPayload = null;

  const payload = await cache.wrap(
    cacheKeyFor(normalized),
    config.search.cacheTtlSeconds,
    async () => {
      const built = await loadPage(normalized);
      if (built.degraded) {
        // `undefined` is cache.wrap's "do not store" signal: the degraded page is served
        // once (below) but never cached, so recovery is visible on the very next request.
        degradedPayload = built.payload;
        return undefined;
      }
      return built.payload;
    }
  );

  return payload !== undefined ? payload : degradedPayload;
}

module.exports = { searchListings, normalizeQuery, cacheKeyFor, DEFAULT_RADIUS_KM };
