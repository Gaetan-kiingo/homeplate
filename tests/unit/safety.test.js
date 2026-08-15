// tests/unit/safety.test.js — U4-SAFETY implementer tests: the FR-07 alert service and
// repository — participant gate, ONE-transaction persistence (alert row + outbox row, no dual
// writes), the ADR-003 IDs-only payload, the NFR-13 response allowlists, the Moderator-role
// gate on the queue, and the delivery-status transitions the worker drives (including the
// "never walk a delivered alert backwards" guard).
//
// The HTTP acceptance lives in tests/tc-core/tc07-safety.test.js and the worker delivery legs
// in tests/it-adapters/it04-safety-delivery.test.js.
'use strict';

const { query, makeUser, makeListing, makeBooking, countRows, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const { ForbiddenError, NotFoundError } = require('../../src/lib/errors');
const outbox = require('../../src/outbox/outbox');
const service = require('../../src/modules/safety/service');
const repo = require('../../src/modules/safety/repo');

const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000007fe';

let host;
let guest;
let stranger;
let listing;

beforeAll(async () => {
  host = await makeUser({ can_publish_listing: true });
  guest = await makeUser();
  stranger = await makeUser();
  listing = await makeListing({ host_id: host.id, moderation_status: 'approved' });
});

afterAll(async () => {
  await closeDb();
  await closeTestRedis();
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function newBooking(overrides = {}) {
  return makeBooking({ listing_id: listing.id, guest_id: guest.id, ...overrides });
}

async function alertsFor(bookingId) {
  const { rows } = await query('SELECT * FROM safety_alerts WHERE booking_id = $1', [bookingId]);
  return rows;
}

// ---- raiseAlert ------------------------------------------------------------------------------

describe('service.raiseAlert — FR-07 persistence and the participant gate', () => {
  test('either participant may raise an alert; the row starts pending', async () => {
    const booking = await newBooking();
    const byGuest = await service.raiseAlert(guest.id, booking.id);
    expect(byGuest).toMatchObject({
      bookingId: booking.id,
      raisedByUserId: guest.id,
      deliveryStatus: 'pending',
      deliveredAt: null,
    });

    const byHost = await service.raiseAlert(host.id, booking.id);
    expect(byHost.raisedByUserId).toBe(host.id);

    const rows = await alertsFor(booking.id);
    expect(rows).toHaveLength(2); // a second incident is a second alert, never swallowed
    expect(rows.every((r) => r.delivery_status === 'pending')).toBe(true);
  });

  test('a non-participant is refused and an unknown booking is a 404 — no row either way', async () => {
    const booking = await newBooking();
    const before = await countRows('safety_alerts');

    await expect(service.raiseAlert(stranger.id, booking.id)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(service.raiseAlert(guest.id, UNKNOWN_UUID)).rejects.toBeInstanceOf(NotFoundError);

    expect(await countRows('safety_alerts')).toBe(before);
  });

  test('ADR-001/003: the alert row and its outbox row commit together — or neither does', async () => {
    const booking = await newBooking();
    const before = await countRows('safety_alerts');
    jest
      .spyOn(outbox, 'enqueue')
      .mockRejectedValue(new Error('injected outbox failure inside the transaction'));

    await expect(service.raiseAlert(guest.id, booking.id)).rejects.toThrow(/injected outbox/);

    // The alert must NOT survive an enqueue that failed: that would be a dual write, and a
    // persisted alert nobody ever delivers is exactly the FR-07 failure mode to avoid.
    expect(await countRows('safety_alerts')).toBe(before);
    expect(await alertsFor(booking.id)).toEqual([]);
  });

  test('the enqueued payload is IDs only and its dedupe key is per-alert (ADR-003, RT-02)', async () => {
    const booking = await newBooking();
    const alert = await service.raiseAlert(guest.id, booking.id);
    const { rows } = await query(
      `SELECT type, payload, dedupe_key FROM outbox_jobs WHERE payload->>'alertId' = $1`,
      [alert.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(service.JOB_TYPE);
    expect(rows[0].dedupe_key).toBe(`${service.JOB_TYPE}:${alert.id}`);
    // The ADR-003 guard accepts it because it carries nothing but identifiers.
    expect(() => outbox.assertIdOnlyPayload(rows[0].payload)).not.toThrow();
    expect(Object.keys(rows[0].payload).sort()).toEqual(['alertId', 'bookingId']);
  });
});

// ---- serializers -----------------------------------------------------------------------------

describe('NFR-13 — the serializers are explicit allowlists', () => {
  test('an alert and a queue entry expose IDs, delivery state and timestamps only', () => {
    const row = {
      id: 'a',
      booking_id: 'b',
      raised_by: 'c',
      delivery_status: 'pending',
      delivered_at: null,
      created_at: 'then',
      updated_at: 'now',
      booking_status: 'in_progress',
      listing_id: 'l',
      host_id: 'h',
      // Fields a naive row-spread would leak:
      emergency_contact_email_enc: 'enc:v1:secret',
      full_name: 'Alex Example',
    };
    expect(Object.keys(service.serializeAlert(row)).sort()).toEqual([
      'bookingId',
      'createdAt',
      'deliveredAt',
      'deliveryStatus',
      'id',
      'raisedByUserId',
    ]);
    expect(Object.keys(service.serializeQueueEntry(row)).sort()).toEqual([
      'bookingId',
      'bookingStatus',
      'createdAt',
      'deliveredAt',
      'deliveryStatus',
      'hostId',
      'id',
      'listingId',
      'raisedByUserId',
      'updatedAt',
    ]);
    const rendered = JSON.stringify([
      service.serializeAlert(row),
      service.serializeQueueEntry(row),
    ]);
    expect(rendered).not.toContain('enc:v1:');
    expect(rendered).not.toContain('Alex Example');
  });
});

// ---- moderator queue -------------------------------------------------------------------------

describe('service.listAlertsForModerator — SRS §2.3 role gate', () => {
  test('a session without the moderator role is refused before any read', async () => {
    const spy = jest.spyOn(repo, 'listForModerators');
    await expect(
      service.listAlertsForModerator(
        { userId: guest.id, roles: ['user'] },
        { page: 1, pageSize: 20 }
      )
    ).rejects.toMatchObject({ code: 'NOT_MODERATOR', status: 403 });
    await expect(
      service.listAlertsForModerator({ userId: guest.id }, { page: 1, pageSize: 20 })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a moderator gets the paginated queue with a total count', async () => {
    const booking = await newBooking();
    const alert = await service.raiseAlert(guest.id, booking.id);
    const page = await service.listAlertsForModerator(
      { userId: 'irrelevant', roles: ['user', 'moderator'] },
      { page: 1, pageSize: 100 }
    );
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.alerts.some((a) => a.id === alert.id)).toBe(true);
    const entry = page.alerts.find((a) => a.id === alert.id);
    expect(entry).toMatchObject({ listingId: listing.id, hostId: host.id, bookingId: booking.id });
  });
});

// ---- delivery-status transitions --------------------------------------------------------------

describe('repo — delivery-status transitions the worker drives (FR-07)', () => {
  test('pending → retrying → delivered, and a delivered alert can never be walked back', async () => {
    const booking = await newBooking();
    const alert = await service.raiseAlert(guest.id, booking.id);

    expect((await repo.markRetrying(alert.id)).delivery_status).toBe('retrying');
    const delivered = await repo.markDelivered(alert.id);
    expect(delivered.delivery_status).toBe('delivered');
    expect(delivered.delivered_at).not.toBeNull();

    // Every later mark is conditional on "not already delivered" (RT-02 redelivery safety).
    expect(await repo.markRetrying(alert.id)).toBeNull();
    expect(await repo.markFailed(alert.id)).toBeNull();
    expect(await repo.markNoChannel(alert.id)).toBeNull();
    expect(await repo.markDelivered(alert.id)).toBeNull(); // no re-stamped delivered_at
    expect((await repo.findById(alert.id)).delivery_status).toBe('delivered');
  });

  test('no_channel and failed are reachable terminal states (§3.4 alert_delivery_status)', async () => {
    const a = await service.raiseAlert(guest.id, (await newBooking()).id);
    expect((await repo.markNoChannel(a.id)).delivery_status).toBe('no_channel');
    const b = await service.raiseAlert(guest.id, (await newBooking()).id);
    expect((await repo.markFailed(b.id)).delivery_status).toBe('failed');
  });

  test('listModeratorIds returns moderators only, and never a deleted account', async () => {
    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const deleted = await makeUser({ roles: ['user', 'moderator'], deleted_at: new Date() });
    const ids = await repo.listModeratorIds();
    expect(ids).toContain(moderator.id);
    expect(ids).not.toContain(deleted.id);
    expect(ids).not.toContain(guest.id);
  });

  test('loadForDelivery returns the contact address as CIPHERTEXT, never plaintext', async () => {
    const { encrypt } = require('../../src/db/fieldCrypto');
    const raiser = await makeUser({
      emergency_contact_email_enc: encrypt('unit-contact@relative.invalid'),
    });
    const booking = await makeBooking({ listing_id: listing.id, guest_id: raiser.id });
    const alert = await service.raiseAlert(raiser.id, booking.id);

    const loaded = await repo.loadForDelivery(alert.id);
    expect(loaded.booking_id).toBe(booking.id);
    expect(loaded.listing_id).toBe(listing.id);
    expect(loaded.emergency_contact_email_enc).toMatch(/^enc:v1:/);
    expect(JSON.stringify(loaded)).not.toContain('unit-contact@relative.invalid');
    expect(await repo.loadForDelivery(UNKNOWN_UUID)).toBeNull();
  });
});
