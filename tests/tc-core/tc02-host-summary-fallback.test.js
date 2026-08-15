// tests/tc-core/tc02-host-summary-fallback.test.js — TC-02 / FR-02 regression guard for the
// degraded host-summary paths (finding TCC-01).
//
// FR-02 acceptance: the listing detail response carries the host summary (display name, bio,
// average rating, review count) IN THE SAME response. hostsRepo.findHost requires BOTH a
// host_profiles join AND users.deleted_at IS NULL, so two states used to make
// src/modules/listings/service.js hostContextFor answer `host: null` on a listing that is
// itself visible — breaking that acceptance with no display name at all:
//   (a) the host account is soft-deleted (reachable the moment the wave-4 U4-PRIVACY erasure
//       endpoint ships), and
//   (b) the host has no host_profiles row.
// Both now degrade to a display identity plus the review aggregates. NFR-12 direction: (a)
// must render the anonymized display name — the fallback must never resurface an erased name.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { query, makeUser, makeHostProfile, makeListing, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');
const hostSerializers = require('../../src/modules/hosts/serializers');
const listingSerializers = require('../../src/modules/listings/serializers');

const COOKIE = config.auth.sessionCookieName;
let app;

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await closeDb();
  await closeTestRedis();
});

async function cookieFor(user) {
  const { token } = await sessions.createSession(user);
  return `${COOKIE}=${token}`;
}

function detail(listingId, cookie) {
  return request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
}

describe('TC-02 / FR-02 — the host summary survives a deleted or profile-less host (TCC-01)', () => {
  test('a SOFT-DELETED host yields the ANONYMIZED summary, never host: null and never the erased name', async () => {
    const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tcc01a' });
    await makeHostProfile({ user_id: host.id });
    const listing = await makeListing({ host_id: host.id, moderation_status: 'approved' });
    await query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [host.id]);

    const viewer = await makeUser({ phone_enc: 'enc:v1:tcc01av' });
    const res = await detail(listing.id, await cookieFor(viewer));

    expect(res.status).toBe(200);
    expect(res.body.listing.host).not.toBeNull();
    // The degraded summary is still the exact FR-02/NFR-13 allowlist — no widened surface.
    expect(Object.keys(res.body.listing.host).sort()).toEqual(
      [...listingSerializers.HOST_SUMMARY_KEYS].sort()
    );
    expect(res.body.listing.host.displayName).toBe(hostSerializers.ANONYMIZED_AUTHOR);
    expect(res.body.listing.host.bio).toBeNull();
    // NFR-12: the erasure is not undone by the fallback.
    expect(JSON.stringify(res.body)).not.toContain(host.full_name);
  });

  test('a host with NO host_profiles row still yields a NAMED summary with the review aggregates', async () => {
    const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tcc01b' });
    const listing = await makeListing({ host_id: host.id, moderation_status: 'approved' });

    const viewer = await makeUser({ phone_enc: 'enc:v1:tcc01bv' });
    const res = await detail(listing.id, await cookieFor(viewer));

    expect(res.status).toBe(200);
    expect(res.body.listing.host).not.toBeNull();
    expect(res.body.listing.host.displayName).toBe(host.full_name);
    expect(res.body.listing.host.bio).toBeNull();
    expect(res.body.listing.host.reviewCount).toBe(0);
    expect(res.body.listing.host.averageRating).toBeNull();
    expect(Array.isArray(res.body.listing.reviews)).toBe(true);
  });
});
