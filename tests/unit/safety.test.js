// tests/unit/safety.test.js — U4-SAFETY implementer tests: the FR-07 alert service and
// repository — participant gate, ONE-transaction persistence (alert row + outbox row, no dual
// writes), the ADR-003 IDs-only payload, the NFR-13 response allowlists, the Moderator-role
// gate on the queue, and the delivery-status transitions the worker drives (including the
// "never walk a delivered alert backwards" guard).
//
// U4-SAFETY-COMPLETE adds: the AB-04 moderator escalation service (escalateAlert — role gate,
// booking existence, same one-transaction persist-and-defer, 'safety.alert_escalated' audit)
// and the unified-4A-queue write model (migration 0006 'safety_alert' content type;
// fileUnifiedQueueEntry idempotent filing; the unifiedQueueSupported gate that follows the
// published U4-MODERATION CONTENT_TYPES contract — see the deviation note in that describe).
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
  try {
    // Net for the unified-queue tests below: no 'safety_alert' moderation_queue row may
    // outlive this suite while the 4A read model cannot serve the type (an unfiltered
    // GET /api/moderation/queue page containing one would 500 in a sibling suite).
    await query(`DELETE FROM moderation_queue WHERE content_type = 'safety_alert'`);
  } finally {
    await closeDb();
    await closeTestRedis();
  }
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

// ---- FR-07 / NFR-09: a failed moderator notice must RETRY, not be swallowed ------------------
//
// Deliberate cover for the handler's moderator-notice failure throw. That branch used to be
// executed only by ACCIDENT — a residue test's unscoped outbox drain delivered a foreign safety
// job — so the 2026-08-21 consolidation dropped its coverage. It is asserted on purpose here
// because the behaviour is load-bearing: if the handler swallowed a failed moderator notice and
// returned success, the outbox would mark the job delivered and NOBODY would be told about a
// safety alert. Throwing is what keeps the retry/backoff/dead-letter budget engaged (NFR-09),
// while the alert itself stays visible in the moderator queue either way.
describe('safetyAlert handler — a failed moderator notice throws so the outbox retries', () => {
  const handler = require('../../src/outbox/handlers/safetyAlert');
  const transport = require('../../src/modules/notifications/transport');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('moderator delivery not "sent" → throws SAFETY_ALERT_MODERATOR_NOTICE_FAILED', async () => {
    await makeUser({ roles: ['user', 'moderator'] });
    const raiser = await makeUser({ emergency_contact_email_enc: null });
    const booking = await makeBooking({ listing_id: listing.id, guest_id: raiser.id });
    const alert = await service.raiseAlert(raiser.id, booking.id);

    // The provider is down for every leg: the transport reports a non-'sent' outcome rather
    // than throwing, which is exactly the case the handler has to notice for itself.
    jest.spyOn(transport, 'send').mockResolvedValue({ status: 'failed', attemptId: null });

    // The count is deliberately NOT pinned: moderator rows are shared state, so asserting
    // "1 of 1" would couple this test to whatever other suites left behind — the exact
    // failure class the 2026-08-21 hygiene sweep removed. The shape is what matters: every
    // moderator failed, and the message says so.
    await expect(handler.handle({ alertId: alert.id })).rejects.toThrow(
      /moderator notification failed for (\d+) of \1 moderators/
    );
    await expect(handler.handle({ alertId: alert.id })).rejects.toMatchObject({
      code: 'SAFETY_ALERT_MODERATOR_NOTICE_FAILED',
    });
  });
});

// ---- AB-04 moderator escalation (U4-SAFETY-COMPLETE) -----------------------------------------

describe('service.escalateAlert — AB-04: a moderator raises an alert on the booking behind flagged content', () => {
  /** Minimal recording logger: captures every audit line for NFR-08 assertions. */
  const recorder = () => {
    const lines = [];
    return { lines, log: { info: (fields, msg) => lines.push({ ...fields, msg }) } };
  };

  test('a non-moderator session is refused before any write, and the refusal is audited', async () => {
    const booking = await newBooking();
    const before = await countRows('safety_alerts');
    const { lines, log } = recorder();

    await expect(
      service.escalateAlert(
        { userId: stranger.id, roles: ['user'] },
        { bookingId: booking.id },
        { log }
      )
    ).rejects.toMatchObject({ code: 'NOT_MODERATOR', status: 403 });

    expect(await countRows('safety_alerts')).toBe(before);
    const audits = lines.filter((l) => l.audit === true && l.event === 'safety.alert_escalated');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: 'failure',
      reason: 'NOT_MODERATOR',
      actorUserId: stranger.id,
      entityType: 'booking',
      entityId: booking.id,
    });
  });

  test('an unknown booking is a 404, audited as a failure — no row written', async () => {
    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const before = await countRows('safety_alerts');
    const { lines, log } = recorder();

    await expect(
      service.escalateAlert(
        { userId: moderator.id, roles: moderator.roles },
        { bookingId: UNKNOWN_UUID },
        { log }
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await countRows('safety_alerts')).toBe(before);
    const audits = lines.filter((l) => l.audit === true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: 'failure', reason: 'BOOKING_NOT_FOUND' });
  });

  test('a moderator who is NO participant escalates: alert + outbox row commit together; audited with IDs only', async () => {
    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const booking = await newBooking();
    const { lines, log } = recorder();

    const alert = await service.escalateAlert(
      { userId: moderator.id, roles: moderator.roles },
      { bookingId: booking.id },
      { log }
    );
    expect(alert).toMatchObject({
      bookingId: booking.id,
      raisedByUserId: moderator.id, // a REAL booking-bound alert raised by the moderator
      deliveryStatus: 'pending',
      deliveredAt: null,
    });

    // The normal delivery path (AB-04 "follows the normal delivery path"): same job type,
    // same IDs-only payload, same per-alert dedupe key as a participant's alert.
    const { rows } = await query(
      `SELECT type, payload, dedupe_key FROM outbox_jobs WHERE payload->>'alertId' = $1`,
      [alert.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(service.JOB_TYPE);
    expect(rows[0].payload).toEqual({ alertId: alert.id, bookingId: booking.id });
    expect(rows[0].dedupe_key).toBe(`${service.JOB_TYPE}:${alert.id}`);
    expect(() => outbox.assertIdOnlyPayload(rows[0].payload)).not.toThrow();

    // NFR-08: ONE success audit record, IDs only.
    const audits = lines.filter((l) => l.audit === true && l.outcome === 'success');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event: 'safety.alert_escalated',
      actorUserId: moderator.id,
      entityType: 'safety_alert',
      entityId: alert.id,
      bookingId: booking.id,
      listingId: listing.id,
    });
    expect(JSON.stringify(audits[0])).not.toMatch(/@|street|address/i);
  });

  test('ADR-001/003: a failed enqueue rolls the escalated alert back too — no dual write', async () => {
    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const booking = await newBooking();
    const before = await countRows('safety_alerts');
    jest.spyOn(outbox, 'enqueue').mockRejectedValue(new Error('injected outbox failure'));

    await expect(
      service.escalateAlert(
        { userId: moderator.id, roles: moderator.roles },
        { bookingId: booking.id }
      )
    ).rejects.toThrow(/injected outbox/);

    expect(await countRows('safety_alerts')).toBe(before);
  });
});

// ---- unified 4A queue (U4-SAFETY-COMPLETE) ---------------------------------------------------
//
// Repaired by U-V4R-SAFETY-QUEUE: 4A's read model (src/modules/moderation/repo.js) now
// DECLARES 'safety_alert' in its published CONTENT_TYPES contract — loadContentForQueuePage
// serves an IDs-only excerpt for the type and setModerationStatus is a recorded no-op — so
// repo.unifiedQueueSupported() is TRUE on the real tree and the worker files one
// moderation_queue row per drained alert. These tests prove both sides of the gate: filing
// is active on the published contract, and NARROWING the contract (simulated via
// jest.replaceProperty) switches filing back off with no safety-module change. The
// route-level acceptance (queue page + decision) lives in tc08 and IT-04.

describe('unified 4A queue — migration 0006 and the contract-gated moderation_queue write model', () => {
  const moderationRepo = require('../../src/modules/moderation/repo');
  const handler = require('../../src/outbox/handlers/safetyAlert');
  const transport = require('../../src/modules/notifications/transport');

  /** Simulate a WITHDRAWN 4A contract: CONTENT_TYPES without 'safety_alert'. */
  const narrow = () =>
    jest.replaceProperty(
      moderationRepo,
      'CONTENT_TYPES',
      Object.freeze(
        moderationRepo.CONTENT_TYPES.filter((t) => t !== repo.UNIFIED_QUEUE_CONTENT_TYPE)
      )
    );

  async function queueRowsFor(alertId) {
    const { rows } = await query(
      `SELECT id, content_type, content_id, reason, status FROM moderation_queue
        WHERE content_type = 'safety_alert' AND content_id = $1
        ORDER BY created_at ASC, id ASC`,
      [alertId]
    );
    return rows;
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    // The read model serves the type now, so a leftover row can no longer 500 anything —
    // but every test still cleans what it filed into the SHARED moderation_queue table, so
    // sibling suites' queue pages stay predictable (helpers/env.js CONCURRENCY RULE).
    await query(`DELETE FROM moderation_queue WHERE content_type = 'safety_alert'`);
  });

  test("migration 0006: 'safety_alert' is APPENDED to moderation_content_type (ADD VALUE, append-only)", async () => {
    const { rows } = await query(
      `SELECT e.enumlabel FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'moderation_content_type'
        ORDER BY e.enumsortorder`
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(['listing', 'review', 'message', 'safety_alert']);
  });

  test('unifiedQueueSupported follows the PUBLISHED 4A contract in both directions', () => {
    // Since U-V4R-SAFETY-QUEUE, 4A declares 'safety_alert' — filing is ACTIVE on this tree.
    expect(moderationRepo.CONTENT_TYPES.includes(repo.UNIFIED_QUEUE_CONTENT_TYPE)).toBe(true);
    expect(repo.unifiedQueueSupported()).toBe(true);
    // If the read model ever withdrew the type, filing would switch back off — with no
    // safety-module change (the gate re-reads the contract per delivery).
    narrow();
    expect(repo.unifiedQueueSupported()).toBe(false);
  });

  test('fileUnifiedQueueEntry: one open row per alert, idempotent, refileable after resolve (RT-02)', async () => {
    const alert = await service.raiseAlert(guest.id, (await newBooking()).id);

    const first = await repo.fileUnifiedQueueEntry(alert.id);
    expect(first.created).toBe(true);
    expect(first.item).toMatchObject({
      content_type: 'safety_alert',
      content_id: alert.id,
      reason: repo.UNIFIED_QUEUE_REASON,
      status: 'open',
    });

    // Redelivery cannot duplicate the open item (0002 moderation_queue_open_content_key).
    const again = await repo.fileUnifiedQueueEntry(alert.id);
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
    expect(await queueRowsFor(alert.id)).toHaveLength(1);

    // A RESOLVED entry no longer blocks a fresh filing — same semantics as 4A's writer.
    await query(
      `UPDATE moderation_queue SET status = 'resolved', resolved_at = now() WHERE id = $1`,
      [first.item.id]
    );
    const refiled = await repo.fileUnifiedQueueEntry(alert.id);
    expect(refiled.created).toBe(true);
    expect(refiled.item.id).not.toBe(first.item.id);
  });

  test('handler + declared support (the REAL contract): the entry is filed BEFORE the delivery legs, so a failing delivery keeps it', async () => {
    const raiser = await makeUser(); // no emergency contact on file
    const booking = await makeBooking({ listing_id: listing.id, guest_id: raiser.id });
    const alert = await service.raiseAlert(raiser.id, booking.id);

    // Every transport leg fails — the queue entry must already exist (FR-07 visibility).
    jest.spyOn(transport, 'send').mockResolvedValue({ status: 'failed', attemptId: null });
    await expect(handler.handle({ alertId: alert.id })).rejects.toMatchObject({
      code: 'SAFETY_ALERT_MODERATOR_NOTICE_FAILED',
    });

    const rows = await queueRowsFor(alert.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect((await repo.findById(alert.id)).delivery_status).toBe('retrying'); // FR-07 honest marking
  });

  test('handler + WITHDRAWN support (simulated): NO moderation_queue row is filed, and the FR-07 alerts queue still lists the alert', async () => {
    narrow();
    const raiser = await makeUser();
    const booking = await makeBooking({ listing_id: listing.id, guest_id: raiser.id });
    const alert = await service.raiseAlert(raiser.id, booking.id);

    jest.spyOn(transport, 'send').mockResolvedValue({ status: 'sent', attemptId: null });
    await handler.handle({ alertId: alert.id });

    expect(await queueRowsFor(alert.id)).toEqual([]); // gate held — nothing 4A cannot serve
    const page = await service.listAlertsForModerator(
      { userId: 'irrelevant', roles: ['moderator'] },
      { page: 1, pageSize: 100 }
    );
    expect(page.alerts.some((a) => a.id === alert.id)).toBe(true); // FR-07 queue intact
  });
});
