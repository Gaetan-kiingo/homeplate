// tests/tc-booking/tc11-listing-caps.test.js — VERIFIER lane "tc-booking", TC-11 (FR-11, ADR-009).
//
// The listings module (wave 3) is NOT built in this run, so the FR-11 API acceptance
// (POST /api/listings, 409 MEHKO_DAILY_LISTING_LIMIT, 422 on seatCapacity > cap, weekly
// window, moderation reset on edit) is NOT yet verifiable. What IS in scope now:
//  - the DB-level backstop the acceptance mandates: unique partial index
//    listings_host_local_date_key ON (host_id, local_date) WHERE status <> 'cancelled',
//    including the concurrent-duplicate-cannot-both-commit property;
//  - ADR-009: caps live in src/config only (1/30/60, America/Los_Angeles), never in DDL.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { query, getClient, makeUser, makeListing, closeDb } = require('../helpers/db');
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

describe('FR-11 / TC-11 — MEHKO caps and one-listing-per-host-per-day', () => {
  test('ADR-009: caps are configuration — 1 listing/day, 30 meals/day, 60 meals/week, America/Los_Angeles', () => {
    expect(config.mehko.listingsPerHostPerDay).toBe(1);
    expect(config.mehko.maxMealsPerDay).toBe(30);
    expect(config.mehko.maxMealsPerWeek).toBe(60);
    expect(config.mehko.timezone).toBe('America/Los_Angeles');
    expect(Object.isFrozen(config.mehko)).toBe(true);
  });

  test('DB backstop: second non-cancelled listing for the same (host, local_date) violates listings_host_local_date_key', async () => {
    const host = await makeUser({ can_publish_listing: true });
    const first = await makeListing({ host_id: host.id });
    await expect(
      makeListing({
        host_id: host.id,
        scheduled_start: first.scheduled_start,
        local_date: first.local_date,
      })
    ).rejects.toMatchObject({ code: '23505', constraint: 'listings_host_local_date_key' });
  });

  test('DB backstop: a CANCELLED listing does not block a new listing on the same day (FR-11 re-create path)', async () => {
    const host = await makeUser({ can_publish_listing: true });
    const first = await makeListing({ host_id: host.id, status: 'cancelled' });
    const second = await makeListing({
      host_id: host.id,
      scheduled_start: first.scheduled_start,
      local_date: first.local_date,
    });
    expect(second.id).toBeDefined();
    expect(second.local_date).toEqual(first.local_date);
  });

  test('concurrent duplicate creations cannot both commit (unique index under two open transactions)', async () => {
    const host = await makeUser({ can_publish_listing: true });
    const template = await makeListing({ host_id: host.id, status: 'cancelled' }); // reserve a day
    const day = template.local_date;
    const start = template.scheduled_start;

    const c1 = await getClient();
    const c2 = await getClient();
    const insertSql = `
      INSERT INTO listings (host_id, title, description, ingredients, allergens, cuisine,
        scheduled_start, local_date, duration_minutes, city, region, country,
        coarse_lat, coarse_lng, area_label, seat_capacity, seats_remaining)
      VALUES ($1, $2, 'race', '{"rice"}', '{"none"}', 'test', $3, $4, 60,
        'San Diego', 'CA', 'US', 32.75, -117.15, 'San Diego', 4, 4)
      RETURNING id`;
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await c1.query(insertSql, [host.id, 'race-a', start, day]);
      // The second insert must block on the index entry, then fail once c1 commits.
      const second = c2.query(insertSql, [host.id, 'race-b', start, day]);
      await new Promise((r) => setTimeout(r, 100));
      await c1.query('COMMIT');
      await expect(second).rejects.toMatchObject({ code: '23505' });
      await c2.query('ROLLBACK');
    } finally {
      c1.release();
      c2.release();
    }

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM listings
        WHERE host_id = $1 AND local_date = $2 AND status <> 'cancelled'`,
      [host.id, day]
    );
    expect(rows[0].c).toBe(1);
  });

  test('ADR-009: no cap literal is baked into the DDL — caps stay config-only', async () => {
    const { rows } = await query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'listings'::regclass AND contype = 'c'`
    );
    const defs = rows.map((r) => r.def).join('\n');
    // seat_capacity > 0 and seats bounds are structural; 30/60 must NOT appear.
    expect(defs).not.toMatch(/\b30\b/);
    expect(defs).not.toMatch(/\b60\b/);
  });

  test('WAVE-3 GAP (documented): POST /api/listings does not exist yet — server-side cap enforcement point unverifiable', async () => {
    const res = await request(app).post('/api/listings').send({ title: 'x' });
    expect(res.status).toBe(404);
  });
});
