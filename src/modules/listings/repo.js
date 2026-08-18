// src/modules/listings/repo.js — U3-LISTINGS: data access for listings (§3.4 LISTING; build-plan
// wave 3A; SPMP WA-2).
//
// Requirement traceability (SRS Appendix B):
//   FR-11  — insert/update/cancel primitives for the listing lifecycle; cancelActiveBookings
//            is the FR-11 "cancel cascades to bookings" write, run on the SAME transaction
//            client as the listing cancel and the notify.booking enqueues (ADR-001/003).
//   FR-02  — findById + listMediaForListing supply the detail payload (media referenced by
//            storage key per ADR-004; URL derivation is src/lib/mediaUrls.js).
//   FR-08  — moderation_status transitions ('pending' on create and on material edit) are
//            persisted here; public visibility filtering belongs to the read paths.
//   NFR-11 (ST-04) — every statement is parameterized ($n placeholders); no caller value is
//            ever interpolated into SQL text. Update columns come from a fixed allowlist map.
//   ADR-010 — rows carry BOTH precise (lat/lng, street address) and public-precision
//            (coarse_*, area_label) location; what leaves the API is decided EXCLUSIVELY by
//            src/modules/listings/serializers.js — this repo returns full rows to services.
//   NFR-12 (TCC-02 / TCC-RV-02) — the ERASURE direction. See ERASURE SEMANTICS below: every
//            DISCOVERY read in this file carries the live-host predicate (findApprovedByHost);
//            findById is deliberately visibility-neutral, because the FR-02 detail read is a
//            RETENTION surface, not a discovery one.
//
// ERASURE SEMANTICS (NFR-12) — the one reading wave 3 implements, recorded here because this
// module is where the wave-4 U4-PRIVACY cascade will land. A soft-deleted account
// (users.deleted_at IS NOT NULL) makes its listings UNDISCOVERABLE and its identity ANONYMOUS,
// but does not retroactively delete the meal record a guest may already hold a booking against:
//   • discovery MUST NOT surface them — FR-01 search (src/modules/search/repo.js
//     VISIBLE_PREDICATES), FR-03 host page (404 at hosts/repo.findHost) and the FR-03 example
//     dishes (findApprovedByHost, below) all answer "gone";
//   • retention MAY still answer — GET /api/listings/:id stays 200 with the ANONYMIZED host
//     summary so an existing booking's meal page does not evaporate. This is the SRS §3.4
//     "retained anonymized after account deletion" direction, and it is PINNED by
//     tests/tc-core/tc02-host-summary-fallback.test.js (TCC-01): the payload must carry a
//     display summary and must never contain the erased full_name. It is why findById below
//     carries NO deleted_at predicate — adding one is not a hardening, it is the opposite
//     decision, and it would fail that test.
// ONE GAP REMAINS, AND IT IS NOT IN THIS FILE (TCC-RV-02): a listing whose host is soft-deleted
// is still RESERVABLE by known id, because src/modules/bookings/repo.selectListing classifies
// bookability from listings.status / moderation_status / scheduled_start only. Under the
// semantics above the fix is not another read predicate but the erasure cascade itself: the
// deletion transaction must cancel the host's active listings (status → 'cancelled'), which
// bookings/service already refuses with LISTING_NOT_BOOKABLE and search already hides. That
// cascade is wave-4 U4-PRIVACY work (NFR-12 has no v1.0 deletion endpoint, so nothing is
// exposed today); it is specified here so it is written, not rediscovered.
//
// Row-shape contract (COV-W3-02): findApprovedByHost — the read-surface path whose rows go
// straight to serializers — returns the canonical camelCase toListing projection. The
// transactional/decision reads (findById, findByIdForUpdate, insertListing, updateListing,
// cancelListing) return RAW snake_case rows because their consumers (listings/service.js
// ownership + moderation checks, media/routes.js attach guard) read DB-shape columns
// directly; the serializers accept either shape.
//
// All functions accept an optional pg client so callers compose them into withTransaction
// units of work (ADR-001 — one transaction, no dual writes).
'use strict';

const { query } = require('../../db/pool');

/**
 * Canonical camelCase projection of a listings row (full row — serializers choose what
 * leaves). Production path: findApprovedByHost (FR-03 host-page example dishes) maps every
 * returned row through here, so a column added to the table but forgotten in this mapper
 * surfaces immediately in the host-page tests instead of rotting silently (COV-W3-02).
 * Null-safe: toListing(null) → null, so `toListing(rows[0] || null)` composes with
 * single-row reads.
 */
function toListing(row) {
  if (!row) return null;
  return {
    id: row.id,
    hostId: row.host_id,
    title: row.title,
    description: row.description,
    ingredients: row.ingredients,
    allergens: row.allergens,
    cuisine: row.cuisine,
    scheduledStart: row.scheduled_start,
    durationMinutes: row.duration_minutes,
    localDate: row.local_date,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    lat: row.lat,
    lng: row.lng,
    coarseLat: row.coarse_lat,
    coarseLng: row.coarse_lng,
    areaLabel: row.area_label,
    seatCapacity: row.seat_capacity,
    seatsRemaining: row.seats_remaining,
    moderationStatus: row.moderation_status,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function run(text, params, client) {
  return client ? client.query(text, params) : query(text, params);
}

/**
 * Insert one listing (FR-11 create). moderation_status defaults 'pending' at the schema
 * (FR-08 — pending until approved); seats_remaining starts at full capacity (FR-12).
 * local_date MUST come from mehko.localDateFor (ADR-009) — never from the caller.
 */
async function insertListing(client, fields) {
  const { rows } = await run(
    `INSERT INTO listings
       (host_id, title, description, ingredients, allergens, cuisine,
        scheduled_start, duration_minutes, local_date,
        address_line1, address_line2, city, region, postal_code, country,
        seat_capacity, seats_remaining)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
     RETURNING *`,
    [
      fields.hostId,
      fields.title,
      fields.description,
      fields.ingredients,
      fields.allergens,
      fields.cuisine ?? null,
      fields.scheduledStart,
      fields.durationMinutes,
      fields.localDate,
      fields.addressLine1 ?? null,
      fields.addressLine2 ?? null,
      fields.city ?? null,
      fields.region ?? null,
      fields.postalCode ?? null,
      fields.country ?? 'US',
      fields.seatCapacity,
    ],
    client
  );
  return rows[0];
}

/**
 * Full row by id (or null). Visibility decisions belong to the service/serializers.
 *
 * NFR-12 (TCC-RV-02): deliberately carries NO users.deleted_at predicate. Its two callers are
 * RETENTION/authorization reads, not discovery: listings/service.getListing (the FR-02 detail
 * page, which must keep answering 200 with the anonymized host summary — see ERASURE SEMANTICS
 * in the module header and tests/tc-core/tc02-host-summary-fallback.test.js) and
 * media/routes.js's owner-only attach guard. Nothing reaches the FR-12 booking path through
 * here — src/modules/bookings loads listings exclusively through its own
 * bookings/repo.selectListing — so hiding rows here would not make a deleted host's meal
 * unbookable; only the U4-PRIVACY cascade does that.
 */
async function findById(id, client = null) {
  const { rows } = await run(`SELECT * FROM listings WHERE id = $1`, [id], client);
  return rows[0] || null;
}

/** Row lock for update/cancel flows (ADR-001 — decide-and-write in one transaction). */
async function findByIdForUpdate(client, id) {
  const { rows } = await client.query(`SELECT * FROM listings WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] || null;
}

/**
 * A host's publicly visible listings: approved + active + upcoming, soonest first
 * (FR-03 "example dishes" — wave-3B hosts module shapes these through publicListing).
 *
 * NFR-12 (TCC-RV-02) — this is a DISCOVERY read, so it carries the same erasure direction the
 * FR-01 search repo does: a soft-deleted host's meals are not offered to anyone. Today
 * hosts/service.getHostPage already 404s first (requireHost → hosts/repo.findHost filters
 * users.deleted_at), so this predicate is defence in depth on the second of the two listing
 * discovery surfaces — it means the erasure direction survives a future caller that reaches
 * example dishes without going through requireHost, instead of depending on a guard one call
 * frame up. Fail-closed: a missing users row yields NULL — i.e. NOT true, so the listing is
 * hidden (listings.host_id is NOT NULL REFERENCES users, so that cannot happen today; the
 * direction still matters if it ever changes).
 *
 * The live-host check is written as a SCALAR SUBQUERY, matching src/modules/search/repo.js
 * VISIBLE_PREDICATES verbatim — deliberately NOT `EXISTS (…)`. PostgreSQL pulls an EXISTS
 * sublink up into a semi-join; an expression sublink is never pulled up and stays a per-row
 * users_pkey lookup applied as a filter after the (host_id, …) index work. Keeping the two
 * discovery predicates textually identical is the point: one form, one plan shape, one place
 * to change if the erasure semantics is ever revised.
 *
 * @returns {Promise<Array<object>>} canonical toListing (camelCase) projections — this is
 *   the read-surface path, so rows go out in the one canonical shape (COV-W3-02); the
 *   ADR-010 disclosure decision still belongs exclusively to the serializers.
 */
async function findApprovedByHost(hostId, { limit = 20 } = {}, client = null) {
  const { rows } = await run(
    `SELECT * FROM listings
     WHERE host_id = $1
       AND moderation_status = 'approved'
       AND status = 'active'
       AND scheduled_start > now()
       AND (SELECT u.deleted_at IS NULL FROM users u WHERE u.id = listings.host_id)
     ORDER BY scheduled_start, id
     LIMIT $2`,
    [hostId, limit],
    client
  );
  return rows.map(toListing);
}

// Fixed patch-key → column allowlist (NFR-11: identifiers never come from the caller).
const UPDATE_COLUMNS = Object.freeze({
  title: 'title',
  description: 'description',
  ingredients: 'ingredients',
  allergens: 'allergens',
  cuisine: 'cuisine',
  scheduledStart: 'scheduled_start',
  durationMinutes: 'duration_minutes',
  localDate: 'local_date',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  region: 'region',
  postalCode: 'postal_code',
  country: 'country',
  lat: 'lat',
  lng: 'lng',
  coarseLat: 'coarse_lat',
  coarseLng: 'coarse_lng',
  areaLabel: 'area_label',
  seatCapacity: 'seat_capacity',
  seatsRemaining: 'seats_remaining',
  moderationStatus: 'moderation_status',
});

/**
 * Apply an allowlisted column patch to one listing on the caller's transaction client.
 * @returns {Promise<object>} the updated row
 */
async function updateListing(client, id, patch) {
  const sets = [];
  const values = [id];
  for (const [key, value] of Object.entries(patch)) {
    const column = UPDATE_COLUMNS[key];
    if (!column) {
      throw new TypeError(`listings repo: unknown update field "${key}"`);
    }
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) {
    throw new TypeError('listings repo: updateListing requires at least one field');
  }
  const { rows } = await client.query(
    `UPDATE listings SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  return rows[0];
}

/** Mark one listing cancelled (FR-11). Idempotence handled by the service's row lock. */
async function cancelListing(client, id) {
  const { rows } = await client.query(
    `UPDATE listings SET status = 'cancelled' WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0];
}

/**
 * Cancel every active (pending / in-progress) booking on a listing (FR-11 cancel cascade,
 * FR-14 semantics: cancelled_at recorded). Returns the affected bookings so the service can
 * enqueue one notify.booking job per guest IN THE SAME TRANSACTION (FR-13, ADR-001/003).
 * @returns {Promise<Array<{id: string, guest_id: string}>>}
 */
async function cancelActiveBookings(client, listingId) {
  const { rows } = await client.query(
    `UPDATE bookings
     SET status = 'cancelled', cancelled_at = now()
     WHERE listing_id = $1 AND status IN ('pending', 'in_progress')
     RETURNING id, guest_id`,
    [listingId]
  );
  return rows;
}

/** Count of seat-holding (pending / in-progress) bookings — capacity re-derivation on
 *  seatCapacity updates (FR-12 consistency). */
async function countActiveBookings(client, listingId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM bookings
     WHERE listing_id = $1 AND status IN ('pending', 'in_progress')`,
    [listingId]
  );
  return rows[0].n;
}

/**
 * Live media rows attached to a listing (ADR-004 — referenced by key), oldest first.
 * Serializers resolve storage keys into URLs via src/lib/mediaUrls.js (FR-02).
 */
async function listMediaForListing(listingId, client = null) {
  const { rows } = await run(
    `SELECT id, storage_key, content_type FROM media_objects
     WHERE entity_type = 'listing' AND entity_id = $1 AND deleted_at IS NULL
     ORDER BY created_at, id`,
    [listingId],
    client
  );
  return rows;
}

/**
 * Worker-side geocode write (src/outbox/handlers/listingGeocode.js): precise coordinates to
 * PostgreSQL (the privileged serializer's source of truth) plus the ADR-010 public-precision
 * projection. Never touches Redis — the cache only ever holds public precision (ADR-005/010).
 */
async function setGeocode(listingId, { lat, lng, coarseLat, coarseLng, areaLabel }, client = null) {
  const { rows } = await run(
    `UPDATE listings
     SET lat = $2, lng = $3, coarse_lat = $4, coarse_lng = $5, area_label = $6
     WHERE id = $1
     RETURNING id`,
    [listingId, lat, lng, coarseLat, coarseLng, areaLabel],
    client
  );
  return rows.length === 1;
}

module.exports = {
  toListing,
  insertListing,
  findById,
  findByIdForUpdate,
  findApprovedByHost,
  updateListing,
  cancelListing,
  cancelActiveBookings,
  countActiveBookings,
  listMediaForListing,
  setGeocode,
};
