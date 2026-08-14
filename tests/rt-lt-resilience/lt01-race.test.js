// tests/rt-lt-resilience/lt01-race.test.js — LT-01's concurrent-reservation race component
// (SRS §4.4: "LT-01 also includes a concurrent-reservation race test asserting that FR-12
// never overbooks a listing"; FR-12, AB-02).
//
// Run at the HTTP surface: N authenticated guests fire POST /api/bookings at the same listing
// simultaneously through the real route → eligibility gate → one-transaction service. The
// invariant checked is the FR-12 acceptance: successful bookings == capacity, seats_remaining
// == 0, and capacity minus seats_remaining always equals the count of non-cancelled bookings.
'use strict';

const http = require('http');

const { createApp } = require('../../src/app');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger } = require('./helpers');
const w3 = require('./wave3');

const quiet = quietLogger();

/** Plain http.request POST with a session cookie against the in-process server. */
function post(port, path, cookie, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          cookie,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* non-JSON body — leave null */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

let app;
let server;
let port;

beforeAll(async () => {
  app = createApp({ logger: quiet });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await dbh.closeDb();
  await rh.closeTestRedis();
});

describe('LT-01 race — FR-12 never overbooks under concurrency', () => {
  test('the FR-12 acceptance scenario verbatim: seats_remaining=1, 50 concurrent requests → exactly 1 created', async () => {
    const host = await w3.makeHost();
    const listing = await w3.makeApprovedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 1, // three seats already taken; ONE left
    });
    const cookies = [];
    for (let i = 0; i < 50; i += 1) {
      cookies.push(await w3.cookieFor(await w3.makeGuest()));
    }
    const results = await Promise.all(
      cookies.map((cookie) => post(port, '/api/bookings', cookie, { listingId: listing.id }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(49);
    expect(results.filter((r) => ![201, 409].includes(r.status))).toEqual([]);
    const { rows } = await dbh.query(`SELECT seats_remaining FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].seats_remaining).toBe(0); // capacity honoured, never negative
  }, 60000);

  test('50 distinct guests, 3 seats: exactly 3×201, 47×409 NO_CAPACITY, seats 0, accounting exact', async () => {
    const SEATS = 3;
    const GUESTS = 50;
    const host = await w3.makeHost();
    const listing = await w3.makeApprovedListing({
      host_id: host.id,
      seat_capacity: SEATS,
      seats_remaining: SEATS,
    });

    const cookies = [];
    for (let i = 0; i < GUESTS; i += 1) {
      const guest = await w3.makeGuest();
      cookies.push(await w3.cookieFor(guest));
    }

    const results = await Promise.all(
      cookies.map((cookie) => post(port, '/api/bookings', cookie, { listingId: listing.id }))
    );

    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    const other = results.filter((r) => r.status !== 201 && r.status !== 409);
    expect(other).toEqual([]); // no 5xx, no unexpected statuses under contention
    expect(created).toHaveLength(SEATS); // exactly capacity succeed — never overbooked
    expect(conflicts).toHaveLength(GUESTS - SEATS);
    for (const r of conflicts) {
      expect(r.body.error.code).toBe('NO_CAPACITY');
    }

    const { rows: listingRows } = await dbh.query(
      `SELECT seat_capacity, seats_remaining FROM listings WHERE id = $1`,
      [listing.id]
    );
    expect(listingRows[0].seats_remaining).toBe(0);
    const { rows: bookingRows } = await dbh.query(
      `SELECT count(*)::int AS n FROM bookings WHERE listing_id = $1 AND status <> 'cancelled'`,
      [listing.id]
    );
    // The FR-12 acceptance ledger: capacity − seats_remaining == non-cancelled bookings.
    expect(bookingRows[0].n).toBe(SEATS);
    expect(listingRows[0].seat_capacity - listingRows[0].seats_remaining).toBe(bookingRows[0].n);
  }, 60000);

  test('one guest, 10 listings, concurrent creates: the AB-02 pending cap holds race-free', async () => {
    const config = require('../../src/config');
    const CAP = config.booking.maxConcurrentPending;
    const ATTEMPTS = 10;
    const guest = await w3.makeGuest();
    const cookie = await w3.cookieFor(guest);
    const listings = [];
    for (let i = 0; i < ATTEMPTS; i += 1) {
      listings.push(await w3.makeApprovedListing());
    }

    const results = await Promise.all(
      listings.map((l) => post(port, '/api/bookings', cookie, { listingId: l.id }))
    );
    const created = results.filter((r) => r.status === 201);
    const limited = results.filter(
      (r) => r.status === 409 && r.body.error && r.body.error.code === 'BOOKING_LIMIT'
    );
    expect(created).toHaveLength(CAP); // the advisory lock serializes the cap check (FR-12)
    expect(limited).toHaveLength(ATTEMPTS - CAP);

    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM bookings WHERE guest_id = $1 AND status = 'pending'`,
      [guest.id]
    );
    expect(rows[0].n).toBe(CAP); // never a single booking over the cap
  }, 60000);

  test('concurrent cancels of the same booking restore the seat exactly once (FR-14 under race)', async () => {
    const host = await w3.makeHost();
    const listing = await w3.makeApprovedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await w3.makeGuest();
    const cookie = await w3.cookieFor(guest);
    const create = await post(port, '/api/bookings', cookie, { listingId: listing.id });
    expect(create.status).toBe(201);
    const bookingId = create.body.booking.id;
    const { rows: afterCreate } = await dbh.query(
      `SELECT seats_remaining FROM listings WHERE id = $1`,
      [listing.id]
    );
    expect(afterCreate[0].seats_remaining).toBe(3);

    const hostCookie = await w3.cookieFor(host);
    const cancels = await Promise.all([
      post(port, `/api/bookings/${bookingId}/cancel`, cookie, {}),
      post(port, `/api/bookings/${bookingId}/cancel`, hostCookie, {}),
      post(port, `/api/bookings/${bookingId}/cancel`, cookie, {}),
    ]);
    for (const r of cancels) {
      expect(r.status).toBe(200); // idempotent — repeats/concurrents are clean 200s
      expect(r.body.booking.status).toBe('cancelled');
    }
    const { rows: afterCancel } = await dbh.query(
      `SELECT seats_remaining, seat_capacity FROM listings WHERE id = $1`,
      [listing.id]
    );
    expect(afterCancel[0].seats_remaining).toBe(4); // restored exactly once, never above capacity
  }, 60000);
});
