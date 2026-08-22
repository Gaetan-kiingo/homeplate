// tests/st-security/st05-st06-privacy.test.js — the canonical ST-05 / ST-06 lane file
// (SRS §4.3): NFR-12 account deletion + 30-day erasure BY CLOCK INJECTION and NFR-13 CCPA
// export, end-to-end over HTTP against the real stores (PostgreSQL, Redis, MinIO), with the
// REAL outbox handlers. Replaces the wave-3 absence probes that lived in st-security.test.js
// (which now points here).
//
// Asserted here, by execution:
//   ST-05 — DELETE /api/users/me → 202 with a data_requests row whose erasure job is due at
//     now + config.privacy.erasureDays (available_at = due_at, same transaction); the
//     session cookie is dead immediately and login is refused; the account vanishes from
//     the host/listing read paths at once. The REAL 'account.erasure' handler, run at the
//     SIMULATED due instant (ctx.now — the injectable now() seam, never waiting), empties
//     every §3.4 PII column, deletes the owned media BY KEY through the real ADR-004
//     adapter (subsequent fetch 404s from MinIO), retains the review anonymized (neutral
//     author on the HTTP read path), and a FULL-DATABASE scan finds none of the user's PII
//     marker strings in any table afterwards. scripts/backup.js prunes a dump older than
//     BACKUP_RETENTION_DAYS and keeps a newer one (the backup-expiry clause, executable).
//   ST-06 — POST /api/users/me/export → 202 with due_at = 30 days (asserted); the worker
//     job produces a machine-readable copy of every §3.4 register class for the REQUESTING
//     user only, readable only by its owner (foreign id → 404, unauthenticated → 401); the
//     export content never appears in any outbox payload (ADR-003 IDs-only holds).
//
// Shared-database discipline (finding MTQ-03 / F-01): fixtures are uniquely keyed, no
// truncation, and the "full-database scan" is scoped to THIS test's unique marker strings —
// deterministic regardless of sibling suites' rows. Handlers run directly (outboxDirect
// pattern) so no worker pass can claim another suite's jobs.
//
// Requirement traceability: NFR-12 (ST-05), NFR-13 (ST-06), NFR-04, NFR-08, NFR-11 (ST-04
// at the new boundary), AB-05, AB-08, FR-13, ADR-001/003/004/011.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const sessions = require('../../src/modules/auth/sessions');
const objectStorage = require('../../src/adapters/objectStorage');
const accountErasureHandler = require('../../src/outbox/handlers/accountErasure');
const dataExportHandler = require('../../src/outbox/handlers/dataExport');
const backupScript = require('../../scripts/backup');
const db = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const { quietLogger, serverBinder } = require('../helpers/httpHarness');

const DAY_MS = 24 * 3600 * 1000;
const addDays = (from, days) => new Date(from.getTime() + days * DAY_MS);

const app = createApp({ config, logger: quietLogger() });
const binder = serverBinder();
const listener = binder.bind(app);
const api = () => request(listener);

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

afterAll(async () => {
  try {
    await binder.closeAll();
    objectStorage.destroy();
  } finally {
    await db.closeDb();
    await closeTestRedis();
  }
});

/** Session cookie for a users row (the lane's standard non-HTTP login shortcut). */
async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles || ['user'] });
  return { cookie: `${config.auth.sessionCookieName}=${token}`, token };
}

// ---------------------------------------------------------------------------------------------
// ST-05 — deletion → scheduled erasure → clock-injected run → nothing left
// ---------------------------------------------------------------------------------------------
describe('ST-05 (NFR-12) — DELETE /api/users/me and the 30-day erasure by clock injection', () => {
  // One rich end-to-end fixture, built once, torn through the whole flow in order.
  const marker = `St05Erase${Date.now()}`;
  const PII_MARKERS = () => [
    `${marker} Target`, // full name
    `${marker} Contact`, // emergency-contact name (third-party PII, NFR-13 scope)
    `${marker} Privacy St`, // listing street address (ADR-010 precise location)
    `st05.${marker.toLowerCase()}`, // email local part
  ];

  let target; // the user who deletes their account
  let targetCookie;
  let host2; // the host the target reviewed (review must survive anonymized)
  let listing; // the target's OWN listing (content + address must be scrubbed)
  let review;
  let storageKey; // the target's media object in MinIO (must 404 after erasure)
  let requestId; // data_requests row id
  let erasureJob; // the scheduled outbox row

  beforeAll(async () => {
    target = await db.makeUser({
      email: `st05.${marker.toLowerCase()}@stsec.homeplate.invalid`,
      full_name: `${marker} Target`,
      can_publish_listing: true,
    });
    ({ cookie: targetCookie } = await cookieFor(target));

    // Full §3.4 surface through the real API where one exists (PATCH /me encrypts at rest).
    const patch = await api()
      .patch('/api/users/me')
      .set('Cookie', targetCookie)
      .send({
        phone: '+14155559171',
        emergencyContact: {
          name: `${marker} Contact`,
          phone: '+14155559172',
          email: `contact.${marker.toLowerCase()}@stsec.homeplate.invalid`,
        },
      });
    expect(patch.status).toBe(200);

    // Their own listing with a precise address, plus a real object in MinIO referenced by key.
    listing = await db.makeListing({
      host_id: target.id,
      title: `${marker} Supper Club`,
      description: `${marker} home cooking`,
      address_line1: `12 ${marker} Privacy St`,
      lat: 32.7101,
      lng: -117.1601,
      moderation_status: 'approved',
    });
    storageKey = `listing/${target.id}/st05-${Date.now()}.jpg`;
    await objectStorage.put(storageKey, Buffer.from('st05-erasure-object'), {
      contentType: 'image/jpeg',
    });
    await db.insertRow('media_objects', {
      owner_user_id: target.id,
      entity_type: 'listing',
      entity_id: listing.id,
      storage_key: storageKey,
      content_type: 'image/jpeg',
    });
    // A retained booking against their listing (other guest — must survive erasure).
    await db.makeBooking({ listing_id: listing.id, status: 'pending' });

    // As a guest elsewhere: completed booking + approved review + a message + safety alert.
    const otherListing = await db.makeListing({ moderation_status: 'approved' });
    const { rows: hostRows } = await db.query(`SELECT * FROM users WHERE id = $1`, [
      otherListing.host_id,
    ]);
    host2 = hostRows[0];
    await db.makeHostProfile({ user_id: host2.id }); // hosts read path needs the profile row
    const booking = await db.makeBooking({
      listing_id: otherListing.id,
      guest_id: target.id,
      status: 'completed',
      host_confirmed_completion: true,
      guest_confirmed_completion: true,
    });
    review = await db.insertRow('reviews', {
      booking_id: booking.id,
      author_id: target.id,
      target_user_id: host2.id,
      rating: 5,
      body: 'A wonderful meal, five stars.', // deliberately marker-free: this text SURVIVES
      moderation_status: 'approved',
    });
    await db.insertRow('messages', {
      booking_id: booking.id,
      sender_id: target.id,
      body: `${marker} Target here, my address is 12 ${marker} Privacy St`,
      moderation_status: 'approved',
    });
    await db.insertRow('safety_alerts', { booking_id: booking.id, raised_by: target.id });
  });

  test('DELETE /api/users/me → 202: request row + erasure job due in erasureDays, same value', async () => {
    const before = Date.now();
    const res = await api().delete('/api/users/me').set('Cookie', targetCookie);
    const after = Date.now();

    expect(res.status).toBe(202);
    expect(res.body.request.kind).toBe('erasure');
    expect(res.body.request.status).toBe('pending');
    requestId = res.body.request.id;

    // due_at = request time + config.privacy.erasureDays (bounded by the HTTP round trip;
    // the EXACT equality under an injected clock is pinned in tests/unit/privacy.test.js).
    const { rows: dr } = await db.query(`SELECT due_at FROM data_requests WHERE id = $1`, [
      requestId,
    ]);
    const due = new Date(dr[0].due_at).getTime();
    expect(due).toBeGreaterThanOrEqual(
      addDays(new Date(before), config.privacy.erasureDays).getTime()
    );
    expect(due).toBeLessThanOrEqual(addDays(new Date(after), config.privacy.erasureDays).getTime());

    // The scheduled job: available_at EQUALS due_at (one value, one transaction — ADR-001/003).
    const { rows: jobs } = await db.query(
      `SELECT o.*, (o.available_at = d.due_at) AS at_due
         FROM outbox_jobs o JOIN data_requests d ON d.id = $2
        WHERE o.type = 'account.erasure' AND o.payload->>'userId' = $1`,
      [target.id, requestId]
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].at_due).toBe(true);
    expect(jobs[0].status).toBe('pending');
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['dataRequestId', 'reason', 'userId']);
    erasureJob = jobs[0];
  });

  test('the session is dead, login is refused, and the account is gone from read paths NOW', async () => {
    // AB-05: the cookie that made the request no longer authenticates anything.
    expect((await api().get('/api/users/me').set('Cookie', targetCookie)).status).toBe(401);

    // NFR-12: deleted user 404s on the host read path. The listing DETAIL page keeps
    // answering by design (TCC-RV-02 erasure semantics: retention read, anonymized host
    // summary) — but the deleted identity must never be on the wire, and FR-01 discovery
    // must not offer the meal.
    const viewer = await db.makeUser();
    const { cookie: viewerCookie } = await cookieFor(viewer);
    expect((await api().get(`/api/hosts/${target.id}`).set('Cookie', viewerCookie)).status).toBe(
      404
    );
    const detail = await api().get(`/api/listings/${listing.id}`).set('Cookie', viewerCookie);
    expect([200, 404]).toContain(detail.status);
    if (detail.status === 200) {
      expect(JSON.stringify(detail.body)).not.toContain(`${marker} Target`); // no identity
      expect(JSON.stringify(detail.body)).not.toContain(target.email);
    }
    const search = await api()
      .get('/api/listings/search')
      .query({ q: marker })
      .set('Cookie', viewerCookie);
    if (search.status === 200) {
      expect(JSON.stringify(search.body)).not.toContain(listing.id); // undiscoverable
    }

    // Login refuses a deleted account outright (indistinguishable from bad credentials).
    const login = await api()
      .post('/api/auth/login')
      .send({ email: target.email, password: 'whatever-it-was-1' });
    expect(login.status).toBeGreaterThanOrEqual(401);
    expect(login.status).toBeLessThanOrEqual(429); // never a session
  });

  test('the REAL erasure handler at the simulated due instant empties everything (§3.4)', async () => {
    const dueInstant = new Date(erasureJob.available_at);
    // Clock injection (build-plan §4D): the real handler, the real media adapter, the
    // simulated instant — never a 30-day wait, and PostgreSQL now() stays coherent.
    const result = await accountErasureHandler.handle(erasureJob.payload, {
      log: quietLog,
      now: dueInstant,
      correlationId: erasureJob.correlation_id,
    });
    expect(result.phase).toBe('erased');

    // Media: deleted BY KEY through the ADR-004 adapter — the object 404s from MinIO.
    await expect(objectStorage.get(storageKey)).rejects.toMatchObject({ status: 404 });
    const { rows: mediaRows } = await db.query(
      `SELECT * FROM media_objects WHERE owner_user_id = $1`,
      [target.id]
    );
    expect(mediaRows).toEqual([]);

    // USER row: §3.4 columns empty, anonymized_at = the simulated instant (SQL-exact).
    const { rows: u } = await db.query(`SELECT * FROM users WHERE id = $1`, [target.id]);
    expect(u[0].email).toBe(`erased:${target.id}`);
    expect(u[0].full_name).toBeNull();
    expect(u[0].phone_enc).toBeNull();
    expect(u[0].emergency_contact_name_enc).toBeNull();
    expect(u[0].emergency_contact_email_enc).toBeNull();
    expect(u[0].password_hash).toBe('erased');
    const { rows: ts } = await db.query(
      `SELECT (anonymized_at = $2::timestamptz) AS eq FROM users WHERE id = $1`,
      [target.id, dueInstant]
    );
    expect(ts[0].eq).toBe(true);

    // The request row closed at the same simulated instant.
    const { rows: dr } = await db.query(
      `SELECT status, (completed_at = $2::timestamptz) AS at_instant
         FROM data_requests WHERE id = $1`,
      [requestId, dueInstant]
    );
    expect(dr[0].status).toBe('completed');
    expect(dr[0].at_instant).toBe(true);
  });

  test('FULL-DATABASE scan: no table row anywhere still carries the user PII markers', async () => {
    // Every application table, discovered dynamically (later waves included). Scoped to THIS
    // test's unique marker strings, so sibling suites' rows cannot make it flaky (F-01).
    const { rows: tables } = await db.query(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
    );
    expect(tables.length).toBeGreaterThanOrEqual(10);
    const offenders = [];
    for (const { tablename } of tables) {
      for (const pii of PII_MARKERS()) {
        const { rows } = await db.query(
          `SELECT count(*)::int AS c FROM "${tablename}" t WHERE t::text ILIKE '%' || $1 || '%'`,
          [pii]
        );
        if (rows[0].c > 0) offenders.push(`${tablename}: "${pii}" (${rows[0].c} row(s))`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the review SURVIVES anonymized: neutral author on the HTTP read path, no name', async () => {
    const reader = await db.makeUser();
    const { cookie } = await cookieFor(reader);
    const res = await api().get(`/api/hosts/${host2.id}/reviews`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    const mine = res.body.reviews.find((r) => r.id === review.id);
    expect(mine).toBeDefined();
    expect(mine.rating).toBe(5);
    expect(mine.body).toBe('A wonderful meal, five stars.');
    expect(mine.authorId).toBeNull();
    expect(typeof mine.authorDisplayName).toBe('string');
    expect(mine.authorDisplayName).not.toContain(marker);
    expect(JSON.stringify(res.body)).not.toContain(marker);
  });

  test('retained records survive with severed references (bookings, alerts, messages)', async () => {
    // The booking a stranger holds on the erased host's listing is retained.
    const { rows: bookings } = await db.query(`SELECT status FROM bookings WHERE listing_id = $1`, [
      listing.id,
    ]);
    expect(bookings.length).toBeGreaterThanOrEqual(1);
    // The listing row survives, scrubbed and cancelled (address gone — checked by the scan).
    const { rows: l } = await db.query(
      `SELECT title, status, address_line1, lat FROM listings WHERE id = $1`,
      [listing.id]
    );
    expect(l[0].status).toBe('cancelled');
    expect(l[0].address_line1).toBeNull();
    expect(l[0].lat).toBeNull();
    // Authored message and raised alert: severed, retained.
    const { rows: msgs } = await db.query(
      `SELECT sender_id, body FROM messages WHERE sender_id IS NULL AND body LIKE '%NFR-12%'`
    );
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const { rows: alerts } = await db.query(
      `SELECT raised_by FROM safety_alerts WHERE raised_by = $1`,
      [target.id]
    );
    expect(alerts).toEqual([]); // no alert still names the erased user
  });

  test('scripts/backup.js: a dump older than BACKUP_RETENTION_DAYS expires, a newer one stays', () => {
    const now = new Date();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-st05-backup-'));
    try {
      const old = path.join(dir, 'homeplate-old.dump');
      const fresh = path.join(dir, 'homeplate-fresh.dump');
      fs.writeFileSync(old, '-- old dump');
      fs.writeFileSync(fresh, '-- fresh dump');
      const oldTime = new Date(now.getTime() - (config.backup.retentionDays + 3) * DAY_MS);
      fs.utimesSync(old, oldTime, oldTime);

      const { pruned, kept } = backupScript.pruneBackups({
        dir,
        retentionDays: config.backup.retentionDays,
        now,
      });
      expect(pruned).toEqual(['homeplate-old.dump']);
      expect(kept).toEqual(['homeplate-fresh.dump']);
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(config.backup.retentionDays).toBe(30); // NFR-12's stated window, validated config
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// ST-06 — CCPA export (NFR-13): 30-day SLA, whole register, owner only
// ---------------------------------------------------------------------------------------------
describe('ST-06 (NFR-13) — POST /api/users/me/export and the owner-scoped copy', () => {
  const marker = `St06Export${Date.now()}`;
  let owner;
  let ownerCookie;
  let bystander;
  let exportId;

  beforeAll(async () => {
    owner = await db.makeUser({
      email: `st06.${marker.toLowerCase()}@stsec.homeplate.invalid`,
      full_name: `${marker} Owner`,
    });
    ({ cookie: ownerCookie } = await cookieFor(owner));
    const patch = await api()
      .patch('/api/users/me')
      .set('Cookie', ownerCookie)
      .send({ phone: '+14155559173' });
    expect(patch.status).toBe(200);
    bystander = await db.makeUser({ full_name: `${marker} Bystander` });
  });

  test('unauthenticated and malformed requests are refused (401 / 422 — ST-04 boundary)', async () => {
    expect((await api().post('/api/users/me/export')).status).toBe(401);
    expect((await api().get(`/api/users/me/export/${crypto.randomUUID()}`)).status).toBe(401);
    expect((await api().delete('/api/users/me')).status).toBe(401);
    const bad = await api()
      .get(`/api/users/me/export/'%20OR%201=1%20--`)
      .set('Cookie', ownerCookie);
    expect(bad.status).toBe(422); // hostile path segment dies at the schema, before SQL
  });

  test('POST → 202 with a data_requests row due in EXACTLY the 30-day SLA window', async () => {
    const before = Date.now();
    const res = await api().post('/api/users/me/export').set('Cookie', ownerCookie);
    const after = Date.now();
    expect(res.status).toBe(202);
    expect(res.body.request.kind).toBe('export');
    exportId = res.body.request.id;

    const due = new Date(res.body.request.dueAt).getTime();
    expect(due).toBeGreaterThanOrEqual(
      addDays(new Date(before), config.privacy.erasureDays).getTime()
    );
    expect(due).toBeLessThanOrEqual(addDays(new Date(after), config.privacy.erasureDays).getTime());

    // The job was created immediately (SLA deadline is a due date, not a start date).
    const { rows: jobs } = await db.query(
      `SELECT payload, (available_at <= now()) AS runnable FROM outbox_jobs
        WHERE type = 'data.export' AND payload->>'dataRequestId' = $1`,
      [exportId]
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].runnable).toBe(true);

    // Before the worker runs: readable by the owner, status pending, no data yet.
    const pending = await api().get(`/api/users/me/export/${exportId}`).set('Cookie', ownerCookie);
    expect(pending.status).toBe(200);
    expect(pending.body.export.status).toBe('pending');
    expect(pending.body.export.data).toBeNull();
  });

  test('the worker-produced copy: every §3.4 register class, the requesting user ONLY', async () => {
    const { rows: jobs } = await db.query(
      `SELECT * FROM outbox_jobs WHERE type = 'data.export' AND payload->>'dataRequestId' = $1`,
      [exportId]
    );
    await dataExportHandler.handle(jobs[0].payload, {
      log: quietLog,
      correlationId: jobs[0].correlation_id,
    });

    const res = await api().get(`/api/users/me/export/${exportId}`).set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.export.status).toBe('completed');
    const data = res.body.export.data;
    // Machine-readable, one key per §3.4 register class.
    expect(Object.keys(data).sort()).toEqual([
      'accessLog',
      'account',
      'bookings',
      'dataRequests',
      'listings',
      'media',
      'messages',
      'moderationDecisions',
      'notificationAttempts',
      'reviews',
      'safetyAlerts',
    ]);
    expect(data.account.email).toBe(owner.email);
    expect(data.account.phone).toBe('+14155559173'); // decrypted for the owner (ST-06)
    expect(data.dataRequests.map((r) => r.id)).toContain(exportId);

    // The requester's data ONLY — the bystander's identity appears nowhere.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(bystander.email);
    expect(serialized).not.toContain(`${marker} Bystander`);
    expect(serialized).not.toContain(bystander.id);
  });

  test('the export content never rides an outbox payload (ADR-003 IDs-only, still true)', async () => {
    // Scan EVERY outbox row that names this user or request: nothing email-shaped, no name.
    const { rows } = await db.query(
      `SELECT payload FROM outbox_jobs
        WHERE payload->>'userId' = $1 OR payload->>'dataRequestId' = $2`,
      [owner.id, exportId]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const { payload } of rows) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain('@');
      expect(text).not.toContain(marker);
      expect(text).not.toContain('+1415');
    }
  });

  test('owner-only read: another authenticated user gets 404 for the same id (AB-08)', async () => {
    const { cookie: bystanderCookie } = await cookieFor(bystander);
    const res = await api().get(`/api/users/me/export/${exportId}`).set('Cookie', bystanderCookie);
    expect(res.status).toBe(404);
  });

  test('a session outliving its erased account gets clean 404s, never a 500', async () => {
    // Race shape: a fresh session could be minted between the deletion request and the
    // erasure sweep by a not-yet-dead device; every privacy verb must fail closed for it.
    const ghost = await db.makeUser();
    const { cookie } = await cookieFor(ghost);
    await db.query(`UPDATE users SET deleted_at = now(), anonymized_at = now() WHERE id = $1`, [
      ghost.id,
    ]);
    expect((await api().delete('/api/users/me').set('Cookie', cookie)).status).toBe(404);
    expect((await api().post('/api/users/me/export').set('Cookie', cookie)).status).toBe(404);
  });
});
