// tests/rt-lt-resilience/wave3.js — wave-3 shared fixtures for the rt-lt-resilience lane
// (RT-01, RT-02, LT-01, LT-02). Lane-owned; no application source is modified.
//
// What lives here:
//   cookieFor(user)          — mint a real Redis session (src/modules/auth/sessions) and
//                              return the request Cookie header value. Avoids the Argon2
//                              register/login round-trip so load/race tests can hold many
//                              distinct authenticated identities cheaply.
//   makeGuest / makeHost     — users that PASS the ADR-006 eligibility policy (email
//                              verified + full name + phone attribute present; hosts add a
//                              complete host profile with an accepted agreement).
//   makeApprovedListing      — an approved, active, future listing (search/booking-visible).
//   patchFn(obj, name, impl) — monkey-patch one exported function on a shared module object
//                              (the RT-01 outage lever for adapter modules resolved through
//                              the require cache); returns a restore().
//   neutralizePendingJobs()  — mark every currently-pending outbox job delivered so a
//                              drill's pollOnce counters are deterministic.
'use strict';

const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');
const dbh = require('../helpers/db');

/** Mint a real Redis-backed session for a users row; returns the Cookie header value. */
async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${config.auth.sessionCookieName}=${token}`;
}

/**
 * A guest who passes canReserveSeat (FR-09/NFR-06: email_verified + full_name + phone
 * attribute non-empty). The phone ciphertext is an inert fixture value — eligibility only
 * checks presence, and no lane test decrypts it.
 */
async function makeGuest(overrides = {}) {
  return dbh.makeUser({
    phone_enc: 'rtlt-fixture-phone-ciphertext',
    ...overrides,
  });
}

/** A host who passes canPublishListing (guest attributes + complete profile + agreement). */
async function makeHost(overrides = {}) {
  const host = await dbh.makeUser({
    can_publish_listing: true,
    phone_enc: 'rtlt-fixture-phone-ciphertext',
    ...overrides,
  });
  await dbh.makeHostProfile({ user_id: host.id });
  return host;
}

/** An approved active future listing — visible to search and bookable (FR-01/FR-12). */
async function makeApprovedListing(overrides = {}) {
  return dbh.makeListing({
    moderation_status: 'approved',
    status: 'active',
    ...overrides,
  });
}

/**
 * Replace one function-valued export on a module object resolved via the require cache.
 * Everything that requires the same module (even at call time, like the search service's
 * ADR-005 read-path require) sees the patched function until restore() runs.
 * @returns {function} restore
 */
function patchFn(obj, name, impl) {
  const original = obj[name];
  if (typeof original !== 'function') {
    throw new TypeError(`patchFn: ${name} is not a function on the target module`);
  }
  obj[name] = impl;
  return function restore() {
    obj[name] = original;
  };
}

/** Mark every pending outbox job delivered so subsequent pollOnce stats are deterministic. */
async function neutralizePendingJobs() {
  await dbh.query(
    `UPDATE outbox_jobs SET status = 'delivered', delivered_at = now() WHERE status = 'pending'`
  );
}

module.exports = {
  cookieFor,
  makeGuest,
  makeHost,
  makeApprovedListing,
  patchFn,
  neutralizePendingJobs,
};
