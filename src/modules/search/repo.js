// src/modules/search/repo.js — U3-SEARCH: parameterized search SQL over listings (build-plan
// wave 3B; SPMP WA-2).
//
// Requirement traceability (SRS Appendix B):
//   FR-01 (TC-01) — one WHERE builder for every filter combination: host, cuisine, time
//            window, and location (radius around one or more resolved public-precision
//            areas). The VISIBILITY INVARIANT is unconditional: only
//            moderation_status='approved' AND status='active' AND scheduled_start > now()
//            rows whose HOST ACCOUNT IS LIVE can ever leave this repo (FR-08
//            pending-until-approved, AB-01; NFR-12 erasure — see VISIBLE_PREDICATES).
//   NFR-12 (TCC-02) — a soft-deleted host (users.deleted_at) disappears from FR-01 discovery
//            in the same request that marks the account deleted: the visibility predicate
//            below carries the live-account check (as a scalar subquery — see the NFR-02 note
//            there), so no listing of a deleted host is browsable here even before the
//            U4-PRIVACY cascade runs. SCOPE: this closes the DISCOVERY surface only.
//            Reserving a seat by a known listing id (src/modules/bookings/service.js) and the
//            FR-02 detail read (src/modules/listings/service.js getListing, which deliberately
//            answers 200 with the anonymized host summary — see
//            tests/tc-core/tc02-host-summary-fallback.test.js) still reach a deleted host's
//            listing; cancelling those listings is the U4-PRIVACY erasure cascade's job.
//   NFR-02 (LT-02) — the SQL is written against the 0002 indexes: the fixed predicates ride
//            listings_public_search_idx / listings_scheduled_start_idx, host filters the
//            partial (host_id, local_date) unique index (status='active' implies
//            status <> 'cancelled'), cuisine rides listings_cuisine_idx, and the geo branch
//            leads with a coarse_lat/coarse_lng bounding box so listings_coarse_geo_idx
//            applies BEFORE the exact haversine refinement. buildSearchQuery is exported so
//            the acceptance test can EXPLAIN the exact production query at volume-seed scale
//            and assert no sequential scan on listings.
//   NFR-11 (ST-04) — every caller value travels as a $n parameter; SQL text is assembled
//            ONLY from fixed fragments in this file, never from input.
//   ADR-010 / NFR-13 — distance filtering compares the request's resolved areas against the
//            listing's COARSE public-precision coordinates (coarse_lat/coarse_lng). The
//            precise lat/lng columns are never referenced in any predicate here, so search
//            behaviour can never observe — let alone leak — an exact location.
'use strict';

const { query } = require('../../db/pool');

// Mean kilometres per degree of latitude (WGS-84) — bounding-box sizing only; the exact
// distance decision is the haversine term below. Matches src/lib/geoPrecision.js (111.32 km).
const KM_PER_DEGREE_LAT = 111.32;

// Mean Earth radius in km for the haversine great-circle distance.
const EARTH_RADIUS_KM = 6371;

/**
 * The FR-08/AB-01 visibility invariant — present in EVERY query this repo builds.
 * Fixed SQL text (no caller data).
 *
 * NFR-12 (TCC-02) — the last predicate is the ERASURE direction of the same invariant: a
 * listing is only discoverable while its host account is live. Without it a soft-deleted host
 * (users.deleted_at set) is simultaneously 404 on GET /api/hosts/:id (hosts/repo.findHost
 * already filters deleted_at) and fully browsable through FR-01 search — their meals, area
 * label and images would stay in the public index after the account was deleted. Deletion is
 * marked on users, so the source of truth alone must refuse to surface the row: this is a
 * predicate on the read path, not a state the U4-PRIVACY cascade has to remember to clean up
 * (defence in depth — the cascade still cancels the listings themselves).
 *
 * ⚠ NFR-02 — the live-host check is deliberately a SCALAR SUBQUERY, not `EXISTS (…)`. Do not
 * "simplify" it back: PostgreSQL pulls an EXISTS sublink up into a SEMI JOIN, and on a freshly
 * bulk-loaded listings table (exactly the LT-02 state: globalSetup resets the schema, the
 * volume seed batch-inserts, autovacuum has not ANALYZEd yet) the planner costs that join as a
 * HASH semi join and stops using listings_scheduled_start_idx — the bare browse page then
 * sequentially scans every listing to satisfy ORDER BY scheduled_start LIMIT 20. Reproduced:
 * with EXISTS, `jest tests/rt-lt-resilience/lt01-lt02-wave3.test.js -t "EXPLAIN ANALYZE"`
 * fails with 'unjustified sequential scan on listings for shape "bare" (page query;
 * matchFraction=1.00)'; with this form all twelve shapes stay index-driven (page + count,
 * 0.02–0.77 ms at volume). An expression sublink is never pulled up, so it stays a per-row
 * users_pkey lookup applied as a filter — the page query evaluates it only for the ~20 rows
 * the LIMIT actually needs, and the plan cannot flip with the statistics.
 *
 * The subquery references the outer `listings` table by name (the FROM clause is unaliased).
 * It yields NULL — i.e. NOT true, so the listing is HIDDEN — if a host row were ever missing:
 * a safety property fails closed (listings.host_id is NOT NULL REFERENCES users ON DELETE
 * CASCADE, so this cannot happen today; the direction still matters if that ever changes).
 */
const VISIBLE_PREDICATES = Object.freeze([
  `moderation_status = 'approved'`,
  `status = 'active'`,
  `scheduled_start > now()`,
  `(SELECT u.deleted_at IS NULL FROM users u WHERE u.id = listings.host_id)`,
]);

/**
 * One location branch: coarse bounding box (index-friendly range predicates on
 * listings_coarse_geo_idx) AND the exact haversine distance over the SAME coarse pair.
 * `least(1, …)` guards asin against floating-point drift above 1.
 * @param {{lat: number, lng: number}} area  public-precision area centre (ADR-010)
 * @param {number} radius  km
 * @param {Array} values   parameter accumulator (mutated)
 * @returns {string} SQL fragment
 */
function areaBranch(area, radius, values) {
  const latDelta = radius / KM_PER_DEGREE_LAT;
  const cosLat = Math.cos((area.lat * Math.PI) / 180);
  // Near the poles cos(lat) → 0: degrade to the whole longitude range rather than divide by ~0.
  const lngDelta = cosLat > 1e-6 ? Math.min(radius / (KM_PER_DEGREE_LAT * cosLat), 180) : 180;

  values.push(area.lat - latDelta);
  const latMin = `$${values.length}`;
  values.push(area.lat + latDelta);
  const latMax = `$${values.length}`;
  values.push(area.lng - lngDelta);
  const lngMin = `$${values.length}`;
  values.push(area.lng + lngDelta);
  const lngMax = `$${values.length}`;
  values.push(area.lat);
  const lat = `$${values.length}`;
  values.push(area.lng);
  const lng = `$${values.length}`;
  values.push(radius);
  const radiusParam = `$${values.length}`;

  return (
    `(coarse_lat BETWEEN ${latMin}::float8 AND ${latMax}::float8` +
    ` AND coarse_lng BETWEEN ${lngMin}::float8 AND ${lngMax}::float8` +
    ` AND 2 * ${EARTH_RADIUS_KM} * asin(least(1, sqrt(` +
    `power(sin(radians(coarse_lat - ${lat}::float8) / 2), 2)` +
    ` + cos(radians(${lat}::float8)) * cos(radians(coarse_lat))` +
    ` * power(sin(radians(coarse_lng - ${lng}::float8) / 2), 2)` +
    `))) <= ${radiusParam}::float8)`
  );
}

/**
 * Shared WHERE builder for the page and count queries.
 * @param {object} filters  { hostId?, cuisine?, from?, to?, areas?: Array<{lat,lng}>,
 *                            radiusKm?: number }
 * @param {Array} values    parameter accumulator (mutated)
 * @returns {string[]} predicate fragments
 */
function buildPredicates(filters, values) {
  const where = [...VISIBLE_PREDICATES];

  if (filters.hostId) {
    values.push(filters.hostId);
    where.push(`host_id = $${values.length}`);
  }
  if (filters.cuisine) {
    values.push(filters.cuisine);
    where.push(`cuisine = $${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    where.push(`scheduled_start >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    where.push(`scheduled_start <= $${values.length}`);
  }
  if (Array.isArray(filters.areas) && filters.areas.length > 0) {
    const radius = filters.radiusKm;
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
      throw new TypeError('search repo: areas require a positive radiusKm');
    }
    const branches = filters.areas.map((area) => areaBranch(area, radius, values));
    where.push(`(${branches.join(' OR ')})`);
  }
  return where;
}

/**
 * Build the result-page query (deterministic ORDER BY scheduled_start, id — soonest meal
 * first, id tiebreak). Exported so the NFR-02 acceptance can EXPLAIN the exact SQL.
 * @param {object} filters  see buildPredicates, plus { limit, offset }
 * @returns {{text: string, values: Array}}
 */
function buildSearchQuery(filters) {
  const values = [];
  const where = buildPredicates(filters, values);
  values.push(filters.limit);
  const limit = `$${values.length}`;
  values.push(filters.offset);
  const offset = `$${values.length}`;
  return {
    text:
      `SELECT * FROM listings WHERE ${where.join(' AND ')}` +
      ` ORDER BY scheduled_start, id LIMIT ${limit} OFFSET ${offset}`,
    values,
  };
}

/**
 * Build the matching total-count query (same predicates, no pagination).
 * @returns {{text: string, values: Array}}
 */
function buildCountQuery(filters) {
  const values = [];
  const where = buildPredicates(filters, values);
  return {
    text: `SELECT count(*)::int AS total FROM listings WHERE ${where.join(' AND ')}`,
    values,
  };
}

/**
 * Run one search: full rows (the service shapes them EXCLUSIVELY through the U3-LISTINGS
 * publicListing serializer — ADR-010) plus the un-paginated total.
 * An EMPTY areas array means the location resolved to nowhere: a real answer — zero results
 * without touching the database.
 * @param {object} filters  { hostId?, cuisine?, from?, to?, areas?, radiusKm?, limit, offset }
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function searchListings(filters) {
  if (Array.isArray(filters.areas) && filters.areas.length === 0) {
    return { rows: [], total: 0 };
  }
  const page = buildSearchQuery(filters);
  const count = buildCountQuery(filters);
  const pageResult = await query(page.text, page.values);
  const countResult = await query(count.text, count.values);
  return { rows: pageResult.rows, total: countResult.rows[0].total };
}

/**
 * Live media rows for a batch of listings in ONE parameterized query (ADR-004 — referenced
 * by storage key; URL derivation happens in the serializer via src/lib/mediaUrls.js).
 * @param {string[]} listingIds
 * @returns {Promise<Map<string, Array<{id: string, storage_key: string, content_type: string}>>>}
 */
async function listMediaForListings(listingIds) {
  const byListing = new Map();
  if (!Array.isArray(listingIds) || listingIds.length === 0) return byListing;
  const { rows } = await query(
    `SELECT id, entity_id, storage_key, content_type FROM media_objects
     WHERE entity_type = 'listing' AND entity_id = ANY($1::uuid[]) AND deleted_at IS NULL
     ORDER BY created_at, id`,
    [listingIds]
  );
  for (const row of rows) {
    if (!byListing.has(row.entity_id)) byListing.set(row.entity_id, []);
    byListing.get(row.entity_id).push(row);
  }
  return byListing;
}

module.exports = {
  buildSearchQuery,
  buildCountQuery,
  searchListings,
  listMediaForListings,
  KM_PER_DEGREE_LAT,
  EARTH_RADIUS_KM,
};
