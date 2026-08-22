// tests/unit/messaging.test.js — U4-MESSAGING implementer tests: the FR-06 messaging
// service, repository and schema — the participant/state truth table (guest and host on
// pending/in_progress/completed; 409 cancelled; 403 third party; 404 unknown booking),
// immediate delivery with the ONE-transaction moderation.scan enqueue (xmin-proven,
// ADR-003 IDs-only payload), the read-side hiding of rejected messages (AB-04), the
// NFR-13 response allowlist, the NFR-08 audit records (never the message text), and the
// request-path adapter purity (ADR-001/003 — zero LLM adapter loads).
//
// The HTTP acceptance lives in tests/tc-core/tc06-messaging.test.js (canonical TC-06).
'use strict';

const path = require('path');

const {
  query,
  makeUser,
  makeListing,
  makeBooking,
  withTransaction,
  closeDb,
} = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const { ConflictError, ForbiddenError, NotFoundError } = require('../../src/lib/errors');
const service = require('../../src/modules/messaging/service');
const repo = require('../../src/modules/messaging/repo');
const messagingSchemas = require('../../src/schemas/messaging');

const UNKNOWN_UUID = '00000000-0000-4000-8000-00000000ff06';

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
    await closeDb();
  } finally {
    await closeTestRedis();
  }
});

/** A booking on the shared listing in the given thread-open (or cancelled) state. */
async function bookingIn(status, overrides = {}) {
  const completionFlags =
    status === 'completed'
      ? { host_confirmed_completion: true, guest_confirmed_completion: true }
      : {};
  return makeBooking({
    listing_id: listing.id,
    guest_id: guest.id,
    status,
    ...completionFlags,
    ...overrides,
  });
}

async function messageRows(bookingId) {
  const { rows } = await query(
    `SELECT *, xmin::text AS xid FROM messages WHERE booking_id = $1 ORDER BY created_at, id`,
    [bookingId]
  );
  return rows;
}

async function scanJobsFor(messageId) {
  const { rows } = await query(
    `SELECT id, type, payload, status, xmin::text AS xid FROM outbox_jobs
      WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
    [messageId]
  );
  return rows;
}

/** Capturing logger for NFR-08 audit assertions (audit() writes through log.info). */
function captureLog() {
  const records = [];
  return {
    records,
    info: (fields) => records.push(fields),
    warn: () => {},
    error: () => {},
    child() {
      return this;
    },
  };
}

// ---- postMessage: FR-06 immediate delivery + the one-transaction proof -----------------------

describe('service.postMessage — delivered immediately, scan row in the SAME transaction', () => {
  test('guest posts: persisted pending, returned at once, scan job shares the xmin, IDs-only payload', async () => {
    const booking = await bookingIn('pending');
    const log = captureLog();
    const bodyText = 'Is the meal vegetarian, and can I bring a friend?';
    const message = await service.postMessage(guest.id, booking.id, { body: bodyText }, { log });

    // NFR-13 allowlist: exactly these keys, nothing else (no email, no address, no spread,
    // no moderation internals — the recipient sees a delivered message, full stop).
    expect(Object.keys(message).sort()).toEqual(
      ['id', 'bookingId', 'senderId', 'body', 'createdAt'].sort()
    );
    expect(message).toMatchObject({
      bookingId: booking.id,
      senderId: guest.id,
      body: bodyText,
    });

    // Persisted, born 'pending' — which for a message means DELIVERED with the scan
    // outstanding (ADR-002): the return above happened regardless of any scan.
    const rows = await messageRows(booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].moderation_status).toBe('pending');

    // ONE transaction (ADR-001/003): message row and its moderation.scan row share an
    // xmin; the payload carries IDs only — never the text (§3.4).
    const jobs = await scanJobsFor(message.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ contentType: 'message', contentId: message.id });
    expect(jobs[0].xid).toBe(rows[0].xid);
    expect(JSON.stringify(jobs[0].payload)).not.toContain('vegetarian');

    // NFR-08: exactly one success audit record — IDs and the role, NEVER the message text.
    const audits = log.records.filter((r) => r.audit === true && r.event === 'message.sent');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: 'success',
      actorUserId: guest.id,
      entityType: 'message',
      entityId: message.id,
      bookingId: booking.id,
      role: 'guest',
    });
    expect(JSON.stringify(log.records)).not.toContain('vegetarian');
  });

  test('the host posts into the same thread (role host); both directions coexist', async () => {
    const booking = await bookingIn('in_progress');
    const log = captureLog();
    const fromGuest = await service.postMessage(
      guest.id,
      booking.id,
      { body: 'What time should I arrive?' },
      { log }
    );
    const fromHost = await service.postMessage(
      host.id,
      booking.id,
      { body: 'Six o clock sharp, please.' },
      { log }
    );
    expect(fromGuest.senderId).toBe(guest.id);
    expect(fromHost.senderId).toBe(host.id);
    const hostAudit = log.records.find((r) => r.entityId === fromHost.id);
    expect(hostAudit.role).toBe('host');
    expect(await repo.countVisibleForBooking(booking.id)).toBe(2);
  });

  test('every thread-open status accepts a post: pending, in_progress AND completed (FR-06)', async () => {
    for (const status of ['pending', 'in_progress', 'completed']) {
      const booking = await bookingIn(status);
      const message = await service.postMessage(
        guest.id,
        booking.id,
        { body: `status probe on a ${status} booking` },
        { log: captureLog() }
      );
      expect(message.bookingId).toBe(booking.id);
    }
  });
});

// ---- the refusal truth table (FR-06) — refusals write nothing and audit the reason -----------

describe('service.postMessage — the participant/state truth table refuses and audits', () => {
  test('404 unknown booking; 403 third party; 409 cancelled — and no row is ever written', async () => {
    const log = captureLog();
    await expect(
      service.postMessage(guest.id, UNKNOWN_UUID, { body: 'ghost thread' }, { log })
    ).rejects.toBeInstanceOf(NotFoundError);

    const booking = await bookingIn('pending');
    const asStranger = service.postMessage(stranger.id, booking.id, { body: 'let me in' }, { log });
    await expect(asStranger).rejects.toBeInstanceOf(ForbiddenError);
    await expect(asStranger).rejects.toMatchObject({ code: 'NOT_PARTICIPANT' });

    const cancelled = await bookingIn('cancelled', { cancelled_at: new Date() });
    const onCancelled = service.postMessage(guest.id, cancelled.id, { body: 'too late' }, { log });
    await expect(onCancelled).rejects.toBeInstanceOf(ConflictError);
    await expect(onCancelled).rejects.toMatchObject({ code: 'BOOKING_CANCELLED' });

    expect(await messageRows(booking.id)).toEqual([]);
    expect(await messageRows(cancelled.id)).toEqual([]);

    // NFR-08: each refusal audited with its reason code — IDs only, never the text.
    const reasons = log.records
      .filter((r) => r.audit === true && r.outcome === 'failure')
      .map((r) => r.reason);
    expect(reasons).toEqual(['BOOKING_NOT_FOUND', 'NOT_PARTICIPANT', 'BOOKING_CANCELLED']);
    expect(JSON.stringify(log.records)).not.toContain('let me in');
  });

  test('a moderator who is not a participant is 403 like any third party (NFR-13 minimization)', async () => {
    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const booking = await bookingIn('pending');
    await expect(
      service.postMessage(
        moderator.id,
        booking.id,
        { body: 'moderator drive-by' },
        {
          log: captureLog(),
        }
      )
    ).rejects.toMatchObject({ code: 'NOT_PARTICIPANT' });
    await expect(
      service.listMessages(moderator.id, booking.id, {}, { log: captureLog() })
    ).rejects.toMatchObject({ code: 'NOT_PARTICIPANT' });
  });
});

// ---- listMessages: the visible thread (FR-06 read side; AB-04 hiding) ------------------------

describe('service.listMessages — participants read at once; rejected messages disappear', () => {
  test('the OTHER participant reads a message immediately while its scan is still pending', async () => {
    const booking = await bookingIn('pending');
    const posted = await service.postMessage(
      guest.id,
      booking.id,
      { body: 'delivered before any scan ran' },
      { log: captureLog() }
    );
    // The scan job has NOT run (status pending in outbox) — the host reads it anyway.
    const jobs = await scanJobsFor(posted.id);
    expect(jobs[0].status).toBe('pending');
    const thread = await service.listMessages(host.id, booking.id, {}, { log: captureLog() });
    expect(thread.items.map((m) => m.id)).toContain(posted.id);
    expect(thread.total).toBe(1);
  });

  test('oldest first, paginated; a REJECTED message vanishes from the thread (AB-04)', async () => {
    const booking = await bookingIn('in_progress');
    const log = captureLog();
    const first = await service.postMessage(guest.id, booking.id, { body: 'first' }, { log });
    const second = await service.postMessage(host.id, booking.id, { body: 'second' }, { log });
    const third = await service.postMessage(guest.id, booking.id, { body: 'third' }, { log });

    let thread = await service.listMessages(guest.id, booking.id, {}, { log });
    expect(thread.items.map((m) => m.id)).toEqual([first.id, second.id, third.id]);
    expect(thread.total).toBe(3);

    // The moderation pipeline (sole moderation_status writer) rejects the middle message —
    // simulated here at the row level; the full pipeline drive is tc06's acceptance.
    await query(`UPDATE messages SET moderation_status = 'rejected' WHERE id = $1`, [second.id]);
    thread = await service.listMessages(host.id, booking.id, {}, { log });
    expect(thread.items.map((m) => m.id)).toEqual([first.id, third.id]);
    expect(thread.total).toBe(2);

    // An APPROVED message stays visible (only rejection hides).
    await query(`UPDATE messages SET moderation_status = 'approved' WHERE id = $1`, [first.id]);
    thread = await service.listMessages(guest.id, booking.id, { page: 1, pageSize: 1 }, { log });
    expect(thread.items.map((m) => m.id)).toEqual([first.id]);
    expect(thread).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    const page2 = await service.listMessages(
      guest.id,
      booking.id,
      { page: 2, pageSize: 1 },
      {
        log,
      }
    );
    expect(page2.items.map((m) => m.id)).toEqual([third.id]);
  });

  test('the read gate mirrors the post gate: 404 / 403 / 409, audited as thread_read failures', async () => {
    const log = captureLog();
    await expect(service.listMessages(guest.id, UNKNOWN_UUID, {}, { log })).rejects.toBeInstanceOf(
      NotFoundError
    );
    const booking = await bookingIn('pending');
    await expect(service.listMessages(stranger.id, booking.id, {}, { log })).rejects.toMatchObject({
      code: 'NOT_PARTICIPANT',
    });
    const cancelled = await bookingIn('cancelled', { cancelled_at: new Date() });
    await expect(service.listMessages(guest.id, cancelled.id, {}, { log })).rejects.toMatchObject({
      code: 'BOOKING_CANCELLED',
    });
    const reads = log.records.filter((r) => r.event === 'message.thread_read');
    expect(reads.map((r) => r.reason)).toEqual([
      'BOOKING_NOT_FOUND',
      'NOT_PARTICIPANT',
      'BOOKING_CANCELLED',
    ]);
  });

  test('an anonymized sender (NFR-12 shape: sender_id NULL) still reads back, senderId null', async () => {
    const booking = await bookingIn('completed');
    const posted = await service.postMessage(
      guest.id,
      booking.id,
      { body: 'author later anonymized' },
      { log: captureLog() }
    );
    await query(`UPDATE messages SET sender_id = NULL WHERE id = $1`, [posted.id]);
    const thread = await service.listMessages(host.id, booking.id, {}, { log: captureLog() });
    const row = thread.items.find((m) => m.id === posted.id);
    expect(row.senderId).toBeNull();
    expect(row.body).toBe('author later anonymized'); // retained, attribution severed
  });
});

// ---- schemas: the FR-06 validation boundary (NFR-11 / AB-06 / ST-04) -------------------------

describe('schemas/messaging — the FR-06 validation boundary', () => {
  const { messageParams, postMessageBody, listMessagesQuery, MAX_BODY_CHARS } = messagingSchemas;

  test('body is required, bounded and sanitized — markup cannot survive (ST-04)', () => {
    expect(postMessageBody.safeParse({}).success).toBe(false);
    expect(postMessageBody.safeParse({ body: '' }).success).toBe(false);
    expect(postMessageBody.safeParse({ body: '   ' }).success).toBe(false);
    expect(postMessageBody.safeParse({ body: 'x'.repeat(MAX_BODY_CHARS + 1) }).success).toBe(false);
    expect(postMessageBody.safeParse({ body: 42 }).success).toBe(false);

    const hostile = postMessageBody.parse({ body: 'hi <script>alert(1)</script> there' });
    expect(hostile.body).not.toContain('<script');
    const sqli = postMessageBody.parse({ body: "'; DROP TABLE messages; --" });
    expect(typeof sqli.body).toBe('string'); // inert data — parameterized SQL is the wall

    // Unknown keys are stripped: nothing but the message text enters the messaging path.
    const stripped = postMessageBody.parse({ body: 'hello', role: 'admin', senderId: 'forged' });
    expect(Object.keys(stripped)).toEqual(['body']);
  });

  test('the :id path param must be a UUID; pagination is capped (NFR-02)', () => {
    expect(messageParams.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
    expect(messageParams.safeParse({ id: UNKNOWN_UUID }).success).toBe(true);

    expect(listMessagesQuery.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(listMessagesQuery.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(listMessagesQuery.safeParse({ page: 0 }).success).toBe(false);
  });
});

// ---- repo contract + ADR-001/003 request-path purity -----------------------------------------

describe('messaging repo + adapter purity', () => {
  test('MESSAGE_COLS is the full §3.4 MESSAGE projection and nothing more', () => {
    expect(repo.MESSAGE_COLS.split(/,\s*/).sort()).toEqual(
      ['id', 'booking_id', 'sender_id', 'body', 'moderation_status', 'created_at'].sort()
    );
  });

  test('countVisibleForBooking counts non-rejected only; empty thread counts zero', async () => {
    const booking = await bookingIn('pending');
    expect(await repo.countVisibleForBooking(booking.id)).toBe(0);
    expect(await repo.listVisibleForBooking(booking.id)).toEqual([]);
  });

  test('defaults hold without a ctx: silent base logger, default pagination, client pass-through', async () => {
    // The optional-argument branches: no ctx (base logger — silent under NODE_ENV=test),
    // no query object, and the repo read functions composed onto an explicit client.
    const booking = await bookingIn('pending');
    const posted = await service.postMessage(guest.id, booking.id, { body: 'no ctx supplied' });
    expect(posted.bookingId).toBe(booking.id);
    const thread = await service.listMessages(host.id, booking.id);
    expect(thread).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    await withTransaction(async (client) => {
      expect(await repo.countVisibleForBooking(booking.id, client)).toBe(1);
      const rows = await repo.listVisibleForBooking(booking.id, {}, client);
      expect(rows.map((r) => r.id)).toEqual([posted.id]);
    });
    // Bypassing the validation layer entirely (no input object at all) still cannot
    // produce a bodyless message row: the NOT NULL wall throws and the tx rolls back.
    await expect(service.postMessage(guest.id, booking.id)).rejects.toThrow();
    expect(await repo.countVisibleForBooking(booking.id)).toBe(1);
  });

  test('ADR-001/003: after every service call above, NO adapter module is loaded (zero LLM loads)', () => {
    // This suite exercised the full messaging request path (post + read + refusals) via the
    // service layer. If any of it had touched src/adapters/* — the LLM classifier included —
    // the module would sit in require.cache now. The scan runs ONLY in the worker.
    const loadedAdapters = Object.keys(require.cache).filter((p) =>
      p.includes(`${path.sep}src${path.sep}adapters${path.sep}`)
    );
    expect(loadedAdapters).toEqual([]);
  });
});
