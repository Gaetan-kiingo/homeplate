// src/adapters/maps.js — U2-ADAPTER-MAPS: Google Maps/Places adapter with Redis result cache
// and degraded-mode fallback (build-plan wave 2; ADR-005, ADR-010; SPMP WA-2).
//
// WORKER/SERVICE-ONLY MODULE (ADR-001/003): request handlers must never import src/adapters/* —
// only outbox handlers, worker code and module services behind the search read path may. The
// adr-conformance lane enforces this.
//
// Requirement traceability (SRS Appendix B):
//   FR-01  — address→coordinate resolution and location-query→area resolution for meal search
//            (Search Service consumes geocode/searchArea in wave 3).
//   NFR-01 — results cached in Redis with TTL: a repeated identical lookup performs ZERO HTTP
//            requests, keeping the search path inside the 500 ms p95 budget.
//   NFR-09 (RT-01) — every provider call runs through httpClient/withResilience: 3000 ms
//            per-attempt timeout (config.adapters.timeoutMs), bounded retries with exponential
//            backoff (config.adapters.retryMax/backoffBaseMs), and a documented fallback — a
//            stale cached entry is served with `degraded: true`; an uncached lookup fails with
//            a typed ServiceUnavailableError (code MAPS_UNAVAILABLE), never an unhandled throw.
//   NFR-13 / AB-08 / ADR-010 — data minimization from birth: everything this adapter writes to
//            Redis is the PUBLIC-precision projection from src/lib/geoPrecision.js — coarsened
//            coordinates + area label. Cache keys are SHA-256 hashes of the normalized input, so
//            neither keys nor values ever contain a street address or exact coordinates; a cache
//            read can never leak an exact location. Precise coordinates are returned ONLY to a
//            caller that explicitly opts in ({ precision: 'exact' }, a forced live call for
//            persisting host coordinates to PostgreSQL) and are never cached.
//   ADR-005 — Google Maps Geocoding + Places Text Search are the providers; the API key comes
//            from the environment (MAPS_API_KEY → config.maps.apiKey) and is NEVER hardcoded.
//   ADR-007 (pattern) — config.maps.mode = 'mock' gives a deterministic, HTTP-free stand-in for
//            dev and the automated suite; 'live' (production default) calls Google.
'use strict';

const crypto = require('crypto');

const config = require('../config');
const cache = require('../lib/cache');
const { key: redisKey } = require('../db/redis');
const httpClient = require('../lib/httpClient');
const { withResilience } = require('../lib/resilience');
const { coarsen } = require('../lib/geoPrecision');
const { logger } = require('../lib/logger');
const {
  ValidationError,
  NotFoundError,
  ServiceUnavailableError,
  UpstreamServiceError,
} = require('../lib/errors');

// Google endpoints (ADR-005). Paths are fixed; the key rides as a query parameter and
// httpClient logs host names only, so the key never reaches a log line.
const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_TEXT_SEARCH_ENDPOINT = 'https://maps.googleapis.com/maps/api/place/textsearch/json';

// Stale copies live longer than the fresh TTL so the NFR-09 degraded mode has something to
// serve during a provider outage after the fresh entry expires (ADR-005 fallback).
const STALE_TTL_MULTIPLIER = 7;

// Longest input we will send to the provider; anything longer is junk, not an address/query.
const MAX_INPUT_LENGTH = 512;

// Places result types that identify a street-level object; their names/labels must never be
// used as an area label (ADR-010 — labels are neighbourhood/city granularity).
const STREET_LEVEL_TYPES = new Set([
  'street_address',
  'street_number',
  'route',
  'premise',
  'subpremise',
  'intersection',
  'plus_code',
]);

const MAX_SEARCH_AREAS = 5;

// ---- input + provider-response helpers -------------------------------------------------------

/** Collapse whitespace and case so equivalent inputs share one cache cell. */
function normalizeInput(raw) {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

function assertLookupInput(raw, what) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ValidationError(`maps adapter: ${what} must be a non-empty string`);
  }
  if (raw.length > MAX_INPUT_LENGTH) {
    throw new ValidationError(`maps adapter: ${what} exceeds ${MAX_INPUT_LENGTH} characters`);
  }
}

/**
 * Cache keys carry a hash of the normalized input, NEVER the input itself: a street address in
 * a key name would leak through the ADR-010 Redis audit exactly like one in a value (AB-08).
 */
function hashInput(kind, normalized) {
  return crypto.createHash('sha256').update(`${kind}:${normalized}`).digest('hex').slice(0, 32);
}

/**
 * Map Google's in-body status to the error taxonomy. HTTP-level failures (5xx/429/timeouts)
 * are already typed by httpClient; this covers the 200-with-error-status protocol.
 */
function providerStatusError(status, errorMessage, operation) {
  const detail = errorMessage ? `: ${errorMessage}` : '';
  switch (status) {
    case 'ZERO_RESULTS':
      return new NotFoundError(`${operation}: no results for the given input`, {
        code: 'MAPS_NO_RESULTS',
      });
    case 'OVER_QUERY_LIMIT':
    case 'RESOURCE_EXHAUSTED':
      return new UpstreamServiceError(`${operation}: provider quota exhausted${detail}`, {
        code: 'MAPS_QUOTA_EXCEEDED',
        retryable: true,
      });
    case 'UNKNOWN_ERROR':
      return new UpstreamServiceError(`${operation}: provider transient error${detail}`, {
        code: 'MAPS_PROVIDER_ERROR',
        retryable: true,
      });
    default:
      // REQUEST_DENIED / INVALID_REQUEST / anything unexpected: retrying will not help.
      return new UpstreamServiceError(`${operation}: provider rejected the request${detail}`, {
        code: 'MAPS_REQUEST_REJECTED',
        retryable: false,
      });
  }
}

function assertFiniteCoords(lat, lng, operation) {
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    throw new UpstreamServiceError(`${operation}: provider returned malformed coordinates`, {
      code: 'MAPS_BAD_RESPONSE',
      retryable: false,
    });
  }
}

/**
 * Area label from geocode address_components: neighbourhood/locality granularity ONLY —
 * street_number/route are deliberately never read (ADR-010, NFR-13).
 */
function areaLabelFromComponents(components) {
  if (!Array.isArray(components)) return undefined;
  const byType = (type) => {
    const match = components.find((c) => Array.isArray(c && c.types) && c.types.includes(type));
    return match && typeof match.long_name === 'string' ? match.long_name : undefined;
  };
  const neighbourhood =
    byType('neighborhood') || byType('sublocality') || byType('sublocality_level_1');
  const locality =
    byType('locality') || byType('postal_town') || byType('administrative_area_level_2');
  const region = byType('administrative_area_level_1');
  const parts = [];
  for (const part of [neighbourhood, locality || region]) {
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Area label for one Places Text Search result. A result naming a street-level object must not
 * contribute its name; fall back to the city-level tail of the plus_code compound code, then to
 * the coarse-cell label generated by geoPrecision.
 */
function areaLabelFromPlace(place) {
  const types = Array.isArray(place.types) ? place.types : [];
  const streetLevel = types.some((t) => STREET_LEVEL_TYPES.has(t));
  if (!streetLevel && typeof place.name === 'string' && place.name.trim().length > 0) {
    return place.name.trim();
  }
  const compound = place.plus_code && place.plus_code.compound_code;
  if (typeof compound === 'string') {
    const spaceIdx = compound.indexOf(' ');
    if (spaceIdx > 0 && spaceIdx < compound.length - 1) return compound.slice(spaceIdx + 1).trim();
  }
  return undefined; // geoPrecision.coarsen supplies its cell-center default label
}

/** Deterministic pseudo-location for mock mode: same input → same coordinates, forever. */
function mockLocation(seed) {
  const digest = crypto.createHash('sha256').update(seed).digest();
  const u = digest.readUInt32BE(0) / 0xffffffff;
  const v = digest.readUInt32BE(4) / 0xffffffff;
  return {
    // San Diego county band — matches the seeded fixture geography.
    lat: 32.55 + u * 0.65,
    lng: -117.35 + v * 0.55,
    token: digest.toString('hex').slice(0, 6),
  };
}

// ---- adapter factory -------------------------------------------------------------------------

/**
 * Build a Maps adapter instance. The default export is built from config; tests build their own
 * with an injected fetchImpl so the automated suite never calls Google (ADR-007 mock-in-CI
 * pattern applied to ADR-005).
 *
 * @param {object} [overrides]
 * @param {'mock'|'live'} [overrides.mode]      Defaults to config.maps.mode.
 * @param {string} [overrides.apiKey]           Defaults to config.maps.apiKey (env MAPS_API_KEY).
 * @param {number} [overrides.cacheTtlSeconds]  Fresh-entry TTL (config.maps.cacheTtlSeconds).
 * @param {number} [overrides.timeoutMs]        Per-attempt budget (config.adapters.timeoutMs).
 * @param {number} [overrides.retries]          Retries after the first attempt (config.adapters.retryMax).
 * @param {number} [overrides.backoffBaseMs]    Exponential-backoff base (config.adapters.backoffBaseMs).
 * @param {function} [overrides.fetchImpl]      Injected fetch for tests.
 * @param {object} [overrides.log]              Logger.
 * @returns {{geocode: function, searchArea: function}}
 */
function createMapsAdapter(overrides = {}) {
  const mode = overrides.mode || config.maps.mode;
  const apiKey = overrides.apiKey !== undefined ? overrides.apiKey : config.maps.apiKey;
  const cacheTtlSeconds =
    overrides.cacheTtlSeconds !== undefined
      ? overrides.cacheTtlSeconds
      : config.maps.cacheTtlSeconds;
  const timeoutMs =
    overrides.timeoutMs !== undefined ? overrides.timeoutMs : config.adapters.timeoutMs;
  const retries = overrides.retries !== undefined ? overrides.retries : config.adapters.retryMax;
  const backoffBaseMs =
    overrides.backoffBaseMs !== undefined ? overrides.backoffBaseMs : config.adapters.backoffBaseMs;
  const fetchImpl = overrides.fetchImpl;
  const log = overrides.log || logger.child({ module: 'maps-adapter' });

  if (mode !== 'mock' && mode !== 'live') {
    throw new TypeError(`createMapsAdapter: mode must be 'mock' or 'live', got ${String(mode)}`);
  }
  if (mode === 'live' && (typeof apiKey !== 'string' || apiKey.length === 0)) {
    // Config already fails fast on MAPS_MODE=live without MAPS_API_KEY; this guards direct use.
    throw new TypeError('createMapsAdapter: live mode requires an API key from the environment');
  }
  if (!Number.isInteger(cacheTtlSeconds) || cacheTtlSeconds <= 0) {
    throw new TypeError('createMapsAdapter: cacheTtlSeconds must be a positive integer');
  }

  const staleTtlSeconds = cacheTtlSeconds * STALE_TTL_MULTIPLIER;

  /** One resilient provider round-trip; httpClient enforces the per-attempt timeout. */
  async function callProvider(endpoint, params, operation) {
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    url.searchParams.set('key', apiKey);
    const response = await httpClient.request({
      url: url.toString(),
      method: 'GET',
      timeoutMs,
      retries: 0, // the shared lookup pipeline owns retries/backoff/fallback
      fetchImpl,
      name: operation,
      log,
    });
    const body = response.json;
    if (!body || typeof body.status !== 'string') {
      throw new UpstreamServiceError(`${operation}: provider returned a malformed body`, {
        code: 'MAPS_BAD_RESPONSE',
        retryable: false,
      });
    }
    if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
      throw providerStatusError(body.status, body.error_message, operation);
    }
    return body;
  }

  /**
   * Shared cache-then-live-then-fallback pipeline (NFR-09).
   * `loadLive()` returns { publicValue, extra } — ONLY publicValue (already coarsened by
   * geoPrecision) is written to Redis; `extra` (precise coordinates) is attached to the result
   * only when `includeExtra` is set (explicit { precision: 'exact' } opt-in), so the DEFAULT
   * result shape is the public projection on every path (ADR-010).
   */
  async function cachedLookup({
    operation,
    kind,
    normalized,
    loadLive,
    bypassCache,
    includeExtra,
  }) {
    const digest = hashInput(kind, normalized);
    const freshKey = redisKey('cache', 'maps', kind, digest);
    const staleKey = redisKey('cache', 'maps', kind, digest, 'stale');

    if (!bypassCache) {
      const hit = await cache.get(freshKey);
      if (hit !== undefined) return { ...hit, degraded: false, source: 'cache' };
    }

    return withResilience(
      async () => {
        const { publicValue, extra } = await loadLive();
        // Public precision ONLY reaches Redis (ADR-010); cache.set swallows Redis outages
        // (NFR-09 — a failed cache write costs latency, never correctness).
        await cache.set(freshKey, publicValue, cacheTtlSeconds);
        await cache.set(staleKey, publicValue, staleTtlSeconds);
        const result = { ...publicValue, degraded: false, source: 'live' };
        if (includeExtra) Object.assign(result, extra);
        return result;
      },
      {
        name: operation,
        timeoutMs: null, // per-attempt timeout is enforced inside httpClient.request
        retries,
        backoff: { baseMs: backoffBaseMs },
        log,
        onFallback: async (err) => {
          // Definitive answers are not outages: no-results and bad input pass through.
          if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
          if (!bypassCache) {
            const stale = await cache.get(staleKey);
            if (stale !== undefined) {
              log.warn(
                { event: 'maps_degraded_cache_serve', operation, code: err && err.code },
                `${operation}: provider unavailable — serving cached area (degraded)`
              );
              return { ...stale, degraded: true, source: 'cache-degraded' };
            }
          }
          throw new ServiceUnavailableError(
            `${operation}: provider unavailable and no cached result to serve`,
            { code: 'MAPS_UNAVAILABLE', cause: err }
          );
        },
      }
    );
  }

  // ---- live provider loads -------------------------------------------------------------------

  async function liveGeocode(address, operation) {
    const body = await callProvider(GEOCODE_ENDPOINT, { address }, operation);
    const top = Array.isArray(body.results) ? body.results[0] : undefined;
    if (body.status === 'ZERO_RESULTS' || !top) {
      throw providerStatusError('ZERO_RESULTS', undefined, operation);
    }
    const location = top.geometry && top.geometry.location;
    const lat = location && location.lat;
    const lng = location && location.lng;
    assertFiniteCoords(lat, lng, operation);
    const areaLabel = areaLabelFromComponents(top.address_components);
    return {
      publicValue: coarsen(lat, lng, { areaLabel }),
      extra: { precise: { lat, lng } },
    };
  }

  async function liveSearchArea(query, operation) {
    const body = await callProvider(PLACES_TEXT_SEARCH_ENDPOINT, { query }, operation);
    const results = Array.isArray(body.results) ? body.results : [];
    const areas = [];
    for (const place of results.slice(0, MAX_SEARCH_AREAS)) {
      const location = place && place.geometry && place.geometry.location;
      if (!location) continue;
      assertFiniteCoords(location.lat, location.lng, operation);
      areas.push(coarsen(location.lat, location.lng, { areaLabel: areaLabelFromPlace(place) }));
    }
    // ZERO_RESULTS is a legitimate search answer, cached like any other (negative caching).
    return { publicValue: { areas }, extra: {} };
  }

  // ---- deterministic mock loads (config.maps.mode = 'mock'; dev + automated suite) -----------

  async function mockGeocode(normalized) {
    const { lat, lng, token } = mockLocation(normalized);
    return {
      publicValue: coarsen(lat, lng, { areaLabel: `Mock Area ${token}` }),
      extra: { precise: { lat, lng } },
    };
  }

  async function mockSearchArea(normalized) {
    const areas = [];
    for (let i = 0; i < 3; i += 1) {
      const { lat, lng, token } = mockLocation(`${normalized}#${i}`);
      areas.push(coarsen(lat, lng, { areaLabel: `Mock Area ${token}` }));
    }
    return { publicValue: { areas }, extra: {} };
  }

  // ---- public surface ------------------------------------------------------------------------

  /**
   * Resolve an address to a location (FR-01, ADR-005).
   *
   * Default result is PUBLIC precision: { lat, lng, areaLabel, degraded, source } with lat/lng
   * coarsened per ADR-010 — safe to serialize on any public read path and served from the Redis
   * cache when possible (zero HTTP on a repeat call).
   *
   * { precision: 'exact' } additionally returns `precise: { lat, lng }` for persisting host
   * coordinates to PostgreSQL (the source of truth for the privileged serializer). Exact lookups
   * always call the provider — precise coordinates are NEVER served from or written to Redis —
   * and fail with a typed error instead of degrading to a coarse cached copy.
   *
   * @param {string} address
   * @param {object} [options]
   * @param {'public'|'exact'} [options.precision='public']
   */
  async function geocode(address, { precision = 'public' } = {}) {
    assertLookupInput(address, 'address');
    if (precision !== 'public' && precision !== 'exact') {
      throw new ValidationError("maps adapter: precision must be 'public' or 'exact'");
    }
    const normalized = normalizeInput(address);
    const operation = 'maps.geocode';
    const exact = precision === 'exact';
    return cachedLookup({
      operation,
      kind: 'geocode',
      normalized,
      // Exact lookups never read the cache (it holds public precision only) and never
      // degrade to a coarse cached copy — persisting precise coordinates needs the provider.
      bypassCache: exact,
      includeExtra: exact,
      loadLive: () =>
        mode === 'live' ? liveGeocode(address.trim(), operation) : mockGeocode(normalized),
    });
  }

  /**
   * Resolve a free-text location query ("La Jolla", "downtown san diego") to candidate areas
   * for location search (FR-01). Result: { areas: [{ lat, lng, areaLabel }], degraded, source }
   * — every area is public precision (ADR-010); `areas` may be empty (a real answer, cached).
   *
   * @param {string} query
   */
  async function searchArea(query) {
    assertLookupInput(query, 'query');
    const normalized = normalizeInput(query);
    const operation = 'maps.searchArea';
    return cachedLookup({
      operation,
      kind: 'search',
      normalized,
      bypassCache: false,
      includeExtra: false,
      loadLive: () =>
        mode === 'live' ? liveSearchArea(query.trim(), operation) : mockSearchArea(normalized),
    });
  }

  return { geocode, searchArea };
}

// Default instance wired from config: mock in dev/test, live in production (config fails fast
// on live without MAPS_API_KEY). Sibling units import these two functions directly.
const defaultAdapter = createMapsAdapter();

module.exports = {
  geocode: defaultAdapter.geocode,
  searchArea: defaultAdapter.searchArea,
  createMapsAdapter,
};
