// tests/tc-core/support.js — shared fixtures for the tc-core verifier lane (TC-01..TC-07).
// Not a test file. This lane owns tests/tc-core only; no application source is touched.
'use strict';

const request = require('supertest');

const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');
const dbh = require('../helpers/db');

/** Session cookie for a users row (AB-08 — every wave-3 read path requires a session). */
async function cookieFor(user, roles = null) {
  const { token } = await sessions.createSession({
    id: user.id,
    roles: roles || user.roles || ['user'],
  });
  return `${config.auth.sessionCookieName}=${token}`;
}

/** An approved + active + future listing — the only publicly visible kind (FR-08/AB-01). */
function makeApprovedListing(overrides = {}) {
  return dbh.makeListing({ moderation_status: 'approved', status: 'active', ...overrides });
}

/** Attach a live media_objects row to a listing (ADR-004 — referenced by storage key). */
async function attachListingMedia(listing, ownerId, keySuffix) {
  return dbh.insertRow('media_objects', {
    owner_user_id: ownerId,
    entity_type: 'listing',
    entity_id: listing.id,
    storage_key: `listing/${ownerId}/${keySuffix}`,
    content_type: 'image/jpeg',
  });
}

/** Attach a live kitchen/dining image to a host profile (FR-03). */
async function attachHostProfileMedia(hostId, keySuffix) {
  return dbh.insertRow('media_objects', {
    owner_user_id: hostId,
    entity_type: 'host_profile',
    entity_id: hostId,
    storage_key: `host_profile/${hostId}/${keySuffix}`,
    content_type: 'image/jpeg',
  });
}

/** A completed booking (both flags — the 0001 CHECK demands it) for review fixtures. */
async function makeCompletedBooking(listingId, guestId) {
  return dbh.makeBooking({
    listing_id: listingId,
    guest_id: guestId,
    status: 'completed',
    host_confirmed_completion: true,
    guest_confirmed_completion: true,
  });
}

function get(app, path, cookie) {
  const req = request(app).get(path);
  return cookie ? req.set('Cookie', cookie) : req;
}

function post(app, path, cookie, body = {}) {
  const req = request(app).post(path).send(body);
  return cookie ? req.set('Cookie', cookie) : req;
}

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

module.exports = {
  cookieFor,
  makeApprovedListing,
  attachListingMedia,
  attachHostProfileMedia,
  makeCompletedBooking,
  get,
  post,
  EMAIL_SHAPE,
};
