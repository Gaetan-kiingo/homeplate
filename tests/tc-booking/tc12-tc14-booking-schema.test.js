// tests/tc-booking/tc12-tc14-booking-schema.test.js — VERIFIER lane "tc-booking",
// TC-12 (FR-12 atomic seat reservation) and TC-14 (FR-14 cancellation restores capacity).
//
// The bookings module (wave 3) is NOT built in this run, so the FR-12/FR-14 API acceptance
// (POST /api/bookings atomic decrement, 50-way race, BOOKING_LIMIT, own-listing 409,
// POST /api/bookings/:id/cancel) is NOT yet verifiable. What IS in scope now:
//  - the schema invariants those flows will rely on: seats_remaining CHECK 0..seat_capacity
//    (overbooking and double-restore are both DB-impossible states);
//  - the FR-12 config knob booking.maxConcurrentPending (default 3, AB-02);
//  - documented absence of the wave-3 endpoints.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { query, makeListing, makeBooking, makeUser, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const config = require('../../src/config');

let app;

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await closeDb();
  await closeTestRedis();
});

describe('FR-12 / TC-12 — atomic booking substrate (schema + config only in waves 1-2)', () => {
  test('config: per-guest concurrent-pending cap defaults to 3 (AB-02)', () => {
    expect(config.booking.maxConcurrentPending).toBe(3);
  });

  test('CHECK constraint: seats_remaining can never go below 0 (overbooking is a DB-impossible state)', async () => {
    const listing = await makeListing({ seat_capacity: 1, seats_remaining: 1 });
    // First conditional decrement (the FR-12 acceptance's mandated statement shape) works…
    const dec = await query(
      `UPDATE listings SET seats_remaining = seats_remaining - 1
        WHERE id = $1 AND seats_remaining > 0 RETURNING seats_remaining`,
      [listing.id]
    );
    expect(dec.rows).toHaveLength(1);
    expect(dec.rows[0].seats_remaining).toBe(0);
    // …the same conditional statement on a full listing matches zero rows (reject path)…
    const again = await query(
      `UPDATE listings SET seats_remaining = seats_remaining - 1
        WHERE id = $1 AND seats_remaining > 0 RETURNING seats_remaining`,
      [listing.id]
    );
    expect(again.rows).toHaveLength(0);
    // …and an UNCONDITIONAL decrement is rejected by the CHECK constraint.
    await expect(
      query('UPDATE listings SET seats_remaining = seats_remaining - 1 WHERE id = $1', [listing.id])
    ).rejects.toMatchObject({ code: '23514' });
    const { rows } = await query('SELECT seats_remaining FROM listings WHERE id = $1', [
      listing.id,
    ]);
    expect(rows[0].seats_remaining).toBe(0); // capacity unchanged by the rejected request
  });

  test('bookings insert works against the schema (row shape wave 3 will use)', async () => {
    const guest = await makeUser();
    const booking = await makeBooking({ guest_id: guest.id });
    expect(booking.status).toBe('pending');
    expect(booking.listing_id).toBeDefined();
  });

  test('WAVE-3 GAP (documented): POST /api/bookings does not exist yet — atomicity/race/limit unverifiable', async () => {
    const res = await request(app).post('/api/bookings').send({ listingId: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('FR-14 / TC-14 — cancellation capacity restore substrate', () => {
  test('CHECK constraint: seats_remaining can never exceed seat_capacity (double-restore is a DB-impossible state)', async () => {
    const listing = await makeListing({ seat_capacity: 2, seats_remaining: 2 });
    await expect(
      query('UPDATE listings SET seats_remaining = seats_remaining + 1 WHERE id = $1', [listing.id])
    ).rejects.toMatchObject({ code: '23514' });
    const { rows } = await query('SELECT seats_remaining FROM listings WHERE id = $1', [
      listing.id,
    ]);
    expect(rows[0].seats_remaining).toBe(2);
  });

  test('WAVE-3 GAP (documented): POST /api/bookings/:id/cancel does not exist yet', async () => {
    const booking = await makeBooking({});
    const res = await request(app).post(`/api/bookings/${booking.id}/cancel`).send({});
    expect(res.status).toBe(404);
  });
});
