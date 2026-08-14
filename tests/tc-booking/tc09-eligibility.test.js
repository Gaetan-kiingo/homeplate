// tests/tc-booking/tc09-eligibility.test.js — VERIFIER lane "tc-booking", TC-09 (FR-09, NFR-06).
//
// FR-09 acceptance: STATE-DRIVEN, BOTH STATES ASSERTED.
//  Restricted: a user missing email verification / full name / phone is denied
//  reserve_seat with machine-readable reason codes; a user missing a completed host
//  profile or agreement is denied publish_listing. Permitted: once the missing
//  attributes are set, the IDENTICAL check succeeds. Both checks served by the single
//  policy module (ADR-006).
//
// Waves 3-4 are not built, so POST /api/bookings and POST /api/listings do not exist yet;
// this file asserts the policy + requireEligibility() gate end-to-end over real DB state
// and real HTTP profile mutations, and documents the route absence explicitly.
'use strict';

const express = require('express');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { query, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const config = require('../../src/config');
const authService = require('../../src/modules/auth/service');
const policy = require('../../src/modules/eligibility/policy');
const { requireEligibility } = require('../../src/modules/eligibility/middleware');
const errorHandler = require('../../src/middleware/errorHandler');

const COOKIE_NAME = config.auth.sessionCookieName;
const PASSWORD = 'Tc09-strong-pw!42';

let app;
let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `tc09-u${emailSeq}-${process.pid}-${Date.now()}@tcbooking.homeplate.invalid`;
}

function cookieFrom(res) {
  const setCookies = res.headers['set-cookie'] || [];
  const raw = setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return raw ? raw.split(';')[0] : null;
}

/** Register (no name/phone), verify email optionally, login; returns {userId, cookie, email}. */
async function makeSessionUser({ verify = true, fullName, phone } = {}) {
  const email = uniqueEmail();
  const { user, verification } = await authService.register({
    email,
    password: PASSWORD,
    fullName,
    phone,
  });
  if (verify) {
    await request(app)
      .post('/api/auth/verify-email')
      .send({ token: verification.rawToken })
      .expect(200);
  }
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return { userId: user.id, cookie: cookieFrom(login), email };
}

/** Test app mounting the REAL eligibility gate behind a stubbed session (auth is TC-10's job). */
function gateApp(userId, action) {
  const a = express();
  a.use((req, _res, next) => {
    if (userId) req.auth = { userId, sessionId: 'tc09-session' };
    next();
  });
  a.post('/gated', requireEligibility(action), (_req, res) => res.status(200).json({ ok: true }));
  a.use(errorHandler);
  return a;
}

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await closeDb();
  await closeTestRedis();
});

describe('FR-09 / TC-09 — eligibility policy is state-driven (restricted AND permitted)', () => {
  test('reserve_seat RESTRICTED: unverified user with no name/phone -> 403 with all three reason codes', async () => {
    const { userId } = await makeSessionUser({ verify: false });
    const res = await request(gateApp(userId, policy.ACTIONS.RESERVE_SEAT)).post('/gated');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect(res.body.error.details.action).toBe('reserve_seat');
    expect(res.body.error.details.reasons).toEqual([
      'EMAIL_UNVERIFIED',
      'NAME_MISSING',
      'PHONE_MISSING',
    ]);
  });

  test('reserve_seat PERMITTED: the identical request succeeds after verifying email + setting name and phone via PATCH /api/users/me', async () => {
    const { userId, cookie } = await makeSessionUser({ verify: true });

    // Still restricted: name and phone missing.
    const denied = await request(gateApp(userId, policy.ACTIONS.RESERVE_SEAT)).post('/gated');
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.reasons).toEqual(['NAME_MISSING', 'PHONE_MISSING']);

    // Set the missing attributes through the real HTTP profile update.
    const patch = await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ fullName: 'Tc Nine Guest', phone: '+16195550109' });
    expect(patch.status).toBe(200);
    expect(patch.body.user.canReserveSeat).toBe(true);

    // Identical gated request now succeeds (permitted state).
    const allowed = await request(gateApp(userId, policy.ACTIONS.RESERVE_SEAT)).post('/gated');
    expect(allowed.status).toBe(200);

    const verdict = await policy.evaluate(userId, policy.ACTIONS.RESERVE_SEAT);
    expect(verdict).toEqual({ allowed: true, reasons: [] });
  });

  test('publish_listing RESTRICTED -> PERMITTED: host profile + agreement flip the verdict', async () => {
    const { userId, cookie } = await makeSessionUser({ verify: true });
    await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ fullName: 'Tc Nine Host', phone: '+16195550108' })
      .expect(200);

    // Restricted: reserve-eligible but no host profile / agreement.
    const denied = await request(gateApp(userId, policy.ACTIONS.PUBLISH_LISTING)).post('/gated');
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.reasons).toEqual([
      'HOST_PROFILE_INCOMPLETE',
      'HOST_AGREEMENT_MISSING',
    ]);

    // Complete the host profile through the real HTTP path.
    const patch = await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({
        hostProfile: { bio: 'I cook family recipes from Oaxaca.', acceptHostAgreement: true },
      });
    expect(patch.status).toBe(200);
    expect(patch.body.user.canPublishListing).toBe(true);

    const allowed = await request(gateApp(userId, policy.ACTIONS.PUBLISH_LISTING)).post('/gated');
    expect(allowed.status).toBe(200);
  });

  test('unauthenticated gated request -> 401 (AB-08), nonexistent user -> USER_NOT_FOUND', async () => {
    const unauth = await request(gateApp(null, policy.ACTIONS.RESERVE_SEAT)).post('/gated');
    expect(unauth.status).toBe(401);

    const ghost = await policy.evaluate(
      '00000000-0000-4000-8000-00000000tc09'.replace(/tc09/, '0009'),
      policy.ACTIONS.RESERVE_SEAT
    );
    expect(ghost).toEqual({ allowed: false, reasons: ['USER_NOT_FOUND'] });
  });

  test('DB truth matches policy: eligibility flips are persisted on the users row (NFR-06)', async () => {
    const { userId, cookie } = await makeSessionUser({ verify: true });
    let { rows } = await query(
      'SELECT can_reserve_seat, can_publish_listing FROM users WHERE id = $1',
      [userId]
    );
    expect(rows[0].can_reserve_seat).toBe(false);

    await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ fullName: 'Flip Check', phone: '+16195550107' })
      .expect(200);

    ({ rows } = await query(
      'SELECT can_reserve_seat, can_publish_listing FROM users WHERE id = $1',
      [userId]
    ));
    expect(rows[0].can_reserve_seat).toBe(true);
    expect(rows[0].can_publish_listing).toBe(false);
  });

  test('FR-09 over the REAL routes (wave 3 built): restricted 403 with reason codes, then the identical request succeeds', async () => {
    const { makeListing } = require('../helpers/db');
    const listing = await makeListing({ moderation_status: 'approved' });

    // RESTRICTED: verified user, no name/phone → POST /api/bookings is 403 with reasons.
    const { cookie } = await makeSessionUser({ verify: true });
    const denied = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId: listing.id });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('NOT_ELIGIBLE');
    expect(denied.body.error.details.reasons).toEqual(['NAME_MISSING', 'PHONE_MISSING']);

    // PERMITTED: set the missing attributes; the IDENTICAL request now succeeds (201).
    await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ fullName: 'Tc Nine Route Guest', phone: '+16195550110' })
      .expect(200);
    const allowed = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId: listing.id });
    expect(allowed.status).toBe(201);

    // RESTRICTED: same user cannot publish a listing without a host profile → 403.
    const listingDenied = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send({
        title: 'FR-09 route test meal',
        description: 'Route-level publish_listing gate test.',
        ingredients: ['rice'],
        scheduledStart: '2029-11-05T20:00:00.000Z',
        durationMinutes: 60,
        seatCapacity: 2,
        addressLine1: '1 Gate St',
        city: 'San Diego',
        region: 'CA',
      });
    expect(listingDenied.status).toBe(403);
    expect(listingDenied.body.error.details.reasons).toEqual([
      'HOST_PROFILE_INCOMPLETE',
      'HOST_AGREEMENT_MISSING',
    ]);

    // PERMITTED: complete the host profile; the identical create now succeeds.
    await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ hostProfile: { bio: 'Route-level test host.', acceptHostAgreement: true } })
      .expect(200);
    const listingAllowed = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send({
        title: 'FR-09 route test meal',
        description: 'Route-level publish_listing gate test.',
        ingredients: ['rice'],
        scheduledStart: '2029-11-05T20:00:00.000Z',
        durationMinutes: 60,
        seatCapacity: 2,
        addressLine1: '1 Gate St',
        city: 'San Diego',
        region: 'CA',
      });
    expect(listingAllowed.status).toBe(201);
  });

  test('ADR-006: no module outside eligibility/ re-implements canReserveSeat/canPublishListing', () => {
    const fs = require('fs');
    const path = require('path');
    const src = path.join(__dirname, '..', '..', 'src');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          if (full.includes(path.join('modules', 'eligibility'))) continue;
          const text = fs.readFileSync(full, 'utf8');
          // A re-implementation would DEFINE the predicate, not merely consume the flag.
          if (/function\s+(canReserveSeat|canPublishListing)\s*\(/.test(text)) {
            offenders.push(path.relative(src, full));
          }
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  test('WAVE-3 status (state-aware): POST /api/bookings and POST /api/listings mount with their units', async () => {
    // Scaffold reconciliation for the wave-3 run: while a unit's routes.js is absent the
    // endpoint 404s (FR-09's route-level acceptance unverifiable — the documented gap); once
    // it lands the route must be mounted (any non-404 — the 403-for-ineligible acceptance is
    // asserted by the unit's tests and this run's verifier extensions, build-plan §7).
    const fs = require('fs');
    const path = require('path');
    const routesOnDisk = (name) =>
      fs.existsSync(path.join(__dirname, '..', '..', 'src', 'modules', name, 'routes.js'));

    const bookings = await request(app).post('/api/bookings').send({});
    if (routesOnDisk('bookings')) expect(bookings.status).not.toBe(404);
    else expect(bookings.status).toBe(404);

    const listings = await request(app).post('/api/listings').send({});
    if (routesOnDisk('listings')) expect(listings.status).not.toBe(404);
    else expect(listings.status).toBe(404);
  });
});
