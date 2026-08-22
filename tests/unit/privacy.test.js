// tests/unit/privacy.test.js — U4-PRIVACY: the NFR-12/NFR-13 data-lifecycle module
// (service + repo + handlers + scripts/backup.js), exercised against the real test
// database with the CLOCK-INJECTED now() seam (build-plan §4D: never by waiting).
//
// Asserted here, by execution:
//   - requestDeletion writes the data_requests row AND the 'account.erasure' outbox job in
//     one transaction, with due_at and available_at EXACTLY equal to the injected
//     now + config.privacy.erasureDays; marks deleted_at; kills every session; repeats are
//     idempotent (NFR-12, ADR-001/003, AB-05);
//   - processErasure run at the simulated due instant empties every SRS §3.4 PII column,
//     calls the injected ADR-004 delete-by-key hook once, retains reviews/messages/safety
//     alerts anonymized (neutral author on the hosts read path), scrubs listing content
//     incl. location, wipes stored export copies, stamps anonymized_at with the injected
//     instant, and is idempotent; a media failure leaves the account intact for retry;
//   - requestExport/processExport produce the §3.4 register copy for the requesting user
//     ONLY, due in exactly erasureDays, owner-scoped on read, IDs-only in the payload, and
//     failing safe once the account is erased (NFR-13, ADR-003, AB-08);
//   - runInactivitySweep flags only stale accounts; the two-phase notice→erasure flow
//     records the notice, schedules the final erasure one window later, cancels when the
//     user is active again, and erases when not (NFR-12, FR-13/ADR-011 seam);
//   - the outbox handlers validate their payloads and the dispatch registry serves both
//     job types; scripts/backup.js prunes dumps older than config.backup.retentionDays and
//     keeps newer ones (ST-05 backup expiry, clock-injected); its main() CLI dispatch is
//     run in-process for BOTH modes (ITA4-F2) — the sweep branch forwards --limit and
//     closes pool AND redis in a finally even when the sweep throws.
//
// Requirement traceability: NFR-12 (ST-05), NFR-13 (ST-06), NFR-04, NFR-08, NFR-11, AB-05,
// AB-08, FR-13, ADR-001/003/004/011.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');
const usersRepo = require('../../src/modules/users/repo');
const hostsRepo = require('../../src/modules/hosts/repo');
const hostsSerializers = require('../../src/modules/hosts/serializers');
const privacyService = require('../../src/modules/privacy/service');
const privacyRepo = require('../../src/modules/privacy/repo');
const accountErasureHandler = require('../../src/outbox/handlers/accountErasure');
const dataExportHandler = require('../../src/outbox/handlers/dataExport');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { NotFoundError } = require('../../src/lib/errors');
const backupScript = require('../../scripts/backup');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

const DAY_MS = 24 * 3600 * 1000;
const addDays = (from, days) => new Date(from.getTime() + days * DAY_MS);

afterAll(async () => {
  try {
    // The real dataExport handler run below loads nothing external, but processErasure via
    // the real handler (st05 lane) would; destroy defensively in case a test pulled it in.
    if (require.cache[require.resolve('../../src/adapters/objectStorage')]) {
      require('../../src/adapters/objectStorage').destroy();
    }
  } finally {
    await dbh.closeDb();
    await closeTestRedis();
  }
});

/** The user's own erasure/export outbox rows (scoped — house rule 2: never a global drain). */
async function jobsFor(userId, type) {
  const { rows } = await dbh.query(
    `SELECT * FROM outbox_jobs WHERE type = $1 AND payload->>'userId' = $2 ORDER BY id`,
    [type, userId]
  );
  return rows;
}

/** SQL-exact timestamp equality (µs-safe both ways: both sides came from JS Date ms). */
async function sqlTimestampEq(table, column, id, expected) {
  const { rows } = await dbh.query(
    `SELECT (${column} = $2::timestamptz) AS eq FROM ${table} WHERE id = $1`,
    [id, expected]
  );
  return rows.length > 0 ? rows[0].eq : null;
}

/** A user with every §3.4 PII class populated (phone + emergency contact encrypted). */
async function makeFullPiiUser(marker) {
  const user = await dbh.makeUser({
    full_name: `${marker} Person`,
    can_publish_listing: true,
  });
  await usersRepo.updateProfileFields(null, user.id, {
    phone: '+14155550188',
    emergencyContactName: `${marker} Contact`,
    emergencyContactPhone: '+14155550189',
    emergencyContactEmail: `contact.${marker.toLowerCase()}@privunit.homeplate.invalid`,
  });
  return user;
}

// ---------------------------------------------------------------------------------------------
// NFR-12 — deletion request (the DELETE /api/users/me service path)
// ---------------------------------------------------------------------------------------------
describe('NFR-12 requestDeletion — request row + scheduled job + dead sessions', () => {
  test('writes the erasure request and job due EXACTLY at now + erasureDays; marks deleted_at', async () => {
    const user = await dbh.makeUser();
    const now = new Date('2026-08-21T10:00:00.000Z');
    const expectedDue = addDays(now, config.privacy.erasureDays);

    const { request, erasureAt } = await privacyService.requestDeletion(user.id, {
      now,
      log: quietLog,
    });

    expect(request.kind).toBe('erasure');
    expect(request.status).toBe('pending');
    expect(new Date(erasureAt).getTime()).toBe(expectedDue.getTime());
    // due_at equals the injected now + config window, verified IN PostgreSQL (clock injection,
    // never waiting — build-plan §4D).
    expect(await sqlTimestampEq('data_requests', 'due_at', request.id, expectedDue)).toBe(true);

    // The deletion mark is set to the injected instant.
    const { rows: userRows } = await dbh.query(`SELECT deleted_at FROM users WHERE id = $1`, [
      user.id,
    ]);
    expect(userRows[0].deleted_at).not.toBeNull();

    // Exactly one 'account.erasure' job, available_at == due_at (same value, same tx).
    const jobs = await jobsFor(user.id, 'account.erasure');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    const { rows: eq } = await dbh.query(
      `SELECT (o.available_at = d.due_at) AS eq
         FROM outbox_jobs o, data_requests d WHERE o.id = $1 AND d.id = $2`,
      [jobs[0].id, request.id]
    );
    expect(eq[0].eq).toBe(true);
    // ADR-003: IDs only — the payload's exact key set.
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['dataRequestId', 'reason', 'userId']);
    expect(jobs[0].payload).toMatchObject({
      userId: user.id,
      dataRequestId: request.id,
      reason: 'deletion',
    });
  });

  test('kills the current session AND every other session of the account (AB-05)', async () => {
    const user = await dbh.makeUser();
    const s1 = await sessions.createSession({ id: user.id, roles: ['user'] });
    const s2 = await sessions.createSession({ id: user.id, roles: ['user'] }); // second device
    const bystander = await dbh.makeUser();
    const s3 = await sessions.createSession({ id: bystander.id, roles: ['user'] });

    await privacyService.requestDeletion(user.id, { sessionToken: s1.token, log: quietLog });

    expect(await sessions.getSession(s1.token)).toBeNull();
    expect(await sessions.getSession(s2.token)).toBeNull();
    // Another account's session survives untouched.
    expect(await sessions.getSession(s3.token)).not.toBeNull();
    await sessions.destroySession(s3.token);
  });

  test('repeat deletion is idempotent: same request, still exactly one erasure job', async () => {
    const user = await dbh.makeUser();
    const first = await privacyService.requestDeletion(user.id, { log: quietLog });
    const second = await privacyService.requestDeletion(user.id, { log: quietLog });
    expect(second.request.id).toBe(first.request.id);
    expect(await jobsFor(user.id, 'account.erasure')).toHaveLength(1);
  });

  test('unknown and already-erased users are 404-shaped (NotFoundError)', async () => {
    await expect(
      privacyService.requestDeletion(crypto.randomUUID(), { log: quietLog })
    ).rejects.toBeInstanceOf(NotFoundError);

    const erased = await dbh.makeUser();
    await dbh.query(`UPDATE users SET deleted_at = now(), anonymized_at = now() WHERE id = $1`, [
      erased.id,
    ]);
    await expect(
      privacyService.requestDeletion(erased.id, { log: quietLog })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------------------------
// NFR-12 — the erasure job at the clock-injected due instant
// ---------------------------------------------------------------------------------------------
describe('NFR-12 processErasure — §3.4 columns empty at the simulated instant', () => {
  /** Deletion-requested user with authored content everywhere the §3.4 register reaches. */
  async function seedDeletedUserWithFootprint(marker) {
    const user = await makeFullPiiUser(marker);
    // Their own listing (host role) with a street address (ADR-010 precise location).
    const listing = await dbh.makeListing({
      host_id: user.id,
      title: `${marker} Dinner`,
      description: `${marker} home cooking`,
      address_line1: `12 ${marker} St`,
      lat: 32.71,
      lng: -117.16,
    });
    await dbh.makeHostProfile({ user_id: user.id, bio: `${marker} host bio` });
    // A booking they made as guest on someone else's listing, with review/message/alert.
    const otherListing = await dbh.makeListing({});
    const booking = await dbh.makeBooking({
      listing_id: otherListing.id,
      guest_id: user.id,
      status: 'completed',
      host_confirmed_completion: true,
      guest_confirmed_completion: true,
    });
    const review = await dbh.insertRow('reviews', {
      booking_id: booking.id,
      author_id: user.id,
      target_user_id: otherListing.host_id,
      rating: 5,
      body: `${marker} was a lovely meal`,
      moderation_status: 'approved',
    });
    const message = await dbh.insertRow('messages', {
      booking_id: booking.id,
      sender_id: user.id,
      body: `${marker} says hi`,
      moderation_status: 'approved',
    });
    const alert = await dbh.insertRow('safety_alerts', {
      booking_id: booking.id,
      raised_by: user.id,
    });
    const media = await dbh.insertRow('media_objects', {
      owner_user_id: user.id,
      entity_type: 'listing',
      entity_id: listing.id,
      storage_key: `listing/${user.id}/privunit-${Date.now()}.jpg`,
    });
    const { request } = await privacyService.requestDeletion(user.id, { log: quietLog });
    return { user, listing, otherListing, booking, review, message, alert, media, request };
  }

  test('erases every §3.4 PII column, severs authorship, scrubs listings, calls delete-by-key', async () => {
    const marker = `PrivUnitA${Date.now()}`;
    const seeded = await seedDeletedUserWithFootprint(marker);
    const dueInstant = addDays(new Date(), config.privacy.erasureDays);
    const deleteMediaCalls = [];

    const result = await privacyService.processErasure(
      { userId: seeded.user.id, dataRequestId: seeded.request.id, reason: 'deletion' },
      {
        deleteMedia: async (ownerId) => {
          deleteMediaCalls.push(ownerId);
          // Mirror the real primitive's outcome shape (unit seam; the real MinIO path is
          // proven in tests/st-security/st05-st06-privacy.test.js and the ADR-004 lane).
          await dbh.query(`DELETE FROM media_objects WHERE owner_user_id = $1`, [ownerId]);
          return { deletedObjects: 1, deletedRows: 1, total: 1 };
        },
        now: dueInstant,
        log: quietLog,
      }
    );
    expect(result.phase).toBe('erased');
    expect(deleteMediaCalls).toEqual([seeded.user.id]); // ADR-004 hook: once, for this owner

    // USER row: every §3.4 PII column is empty; anonymized_at IS the simulated instant.
    const { rows: u } = await dbh.query(`SELECT * FROM users WHERE id = $1`, [seeded.user.id]);
    expect(u[0].email).toBe(`erased:${seeded.user.id}`);
    expect(u[0].full_name).toBeNull();
    expect(u[0].phone_enc).toBeNull();
    expect(u[0].emergency_contact_name_enc).toBeNull();
    expect(u[0].emergency_contact_phone_enc).toBeNull();
    expect(u[0].emergency_contact_email_enc).toBeNull();
    expect(u[0].password_hash).toBe('erased'); // NFR-04: can never authenticate
    expect(u[0].can_reserve_seat).toBe(false);
    expect(u[0].can_publish_listing).toBe(false);
    expect(await sqlTimestampEq('users', 'anonymized_at', seeded.user.id, dueInstant)).toBe(true);

    // Review RETAINED anonymized (NFR-12): row survives, authorship severed, and the hosts
    // read path renders the neutral author display.
    const { rows: r } = await dbh.query(`SELECT * FROM reviews WHERE id = $1`, [seeded.review.id]);
    expect(r).toHaveLength(1);
    expect(r[0].author_id).toBeNull();
    expect(r[0].rating).toBe(5);
    const reviews = await hostsRepo.listApprovedReviews(seeded.otherListing.host_id, {
      limit: 50,
    });
    const mine = reviews.find((row) => row.id === seeded.review.id);
    expect(mine).toBeDefined();
    expect(hostsSerializers.publicReview(mine).authorDisplayName).toBe(
      hostsSerializers.ANONYMIZED_AUTHOR
    );

    // Message: reference severed AND content removed (§3.4 register: messages are deleted
    // with the account; the anonymized shell keeps the thread resolvable). Safety alert
    // retained with a severed reference.
    const { rows: m } = await dbh.query(`SELECT sender_id, body FROM messages WHERE id = $1`, [
      seeded.message.id,
    ]);
    expect(m[0].sender_id).toBeNull();
    expect(m[0].body).not.toContain(marker);
    const { rows: a } = await dbh.query(`SELECT raised_by FROM safety_alerts WHERE id = $1`, [
      seeded.alert.id,
    ]);
    expect(a[0].raised_by).toBeNull();

    // Booking retained; its guest reference resolves to the erased shell (no PII behind it).
    const { rows: b } = await dbh.query(`SELECT guest_id, status FROM bookings WHERE id = $1`, [
      seeded.booking.id,
    ]);
    expect(b[0].guest_id).toBe(seeded.user.id);
    expect(b[0].status).toBe('completed');

    // Listing content incl. location scrubbed; row retained, out of the active set.
    const { rows: l } = await dbh.query(`SELECT * FROM listings WHERE id = $1`, [
      seeded.listing.id,
    ]);
    expect(l[0].address_line1).toBeNull();
    expect(l[0].lat).toBeNull();
    expect(l[0].lng).toBeNull();
    expect(l[0].coarse_lat).toBeNull();
    expect(l[0].area_label).toBeNull();
    expect(l[0].status).toBe('cancelled');
    expect(JSON.stringify(l[0])).not.toContain(marker);

    // Host-profile text cleared; the request row is completed AT the simulated instant.
    const { rows: hp } = await dbh.query(`SELECT bio FROM host_profiles WHERE user_id = $1`, [
      seeded.user.id,
    ]);
    expect(hp[0].bio).toBeNull();
    const { rows: dr } = await dbh.query(`SELECT status FROM data_requests WHERE id = $1`, [
      seeded.request.id,
    ]);
    expect(dr[0].status).toBe('completed');
    expect(
      await sqlTimestampEq('data_requests', 'completed_at', seeded.request.id, dueInstant)
    ).toBe(true);

    // No row related to this user still carries the marker strings (scoped ST-05 shape;
    // the full-database sweep lives in the st-security lane).
    for (const table of ['users', 'listings', 'host_profiles']) {
      const { rows } = await dbh.query(
        // eslint-disable-next-line no-useless-concat
        `SELECT count(*)::int AS c FROM ${table} WHERE ${table}::text LIKE '%' || $1 || '%'`,
        [marker]
      );
      expect(rows[0].c).toBe(0);
    }
  });

  test('is idempotent: a redelivered job after completion is a no-op', async () => {
    const seeded = await seedDeletedUserWithFootprint(`PrivUnitB${Date.now()}`);
    const deps = {
      deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
      now: addDays(new Date(), config.privacy.erasureDays),
      log: quietLog,
    };
    const first = await privacyService.processErasure(
      { userId: seeded.user.id, dataRequestId: seeded.request.id, reason: 'deletion' },
      deps
    );
    expect(first.phase).toBe('erased');
    const second = await privacyService.processErasure(
      { userId: seeded.user.id, dataRequestId: seeded.request.id, reason: 'deletion' },
      deps
    );
    expect(second.phase).toBe('already_done');
  });

  test('a media-store failure leaves the account intact for the worker retry (NFR-09)', async () => {
    const user = await dbh.makeUser({ full_name: 'PrivUnit RetryMe' });
    const { request } = await privacyService.requestDeletion(user.id, { log: quietLog });
    const boom = new Error('storage down');

    await expect(
      privacyService.processErasure(
        { userId: user.id, dataRequestId: request.id, reason: 'deletion' },
        { deleteMedia: async () => Promise.reject(boom), now: new Date(), log: quietLog }
      )
    ).rejects.toBe(boom);

    // Nothing was anonymized — the retryable failure defers the whole erasure.
    const { rows } = await dbh.query(`SELECT full_name, anonymized_at FROM users WHERE id = $1`, [
      user.id,
    ]);
    expect(rows[0].full_name).toBe('PrivUnit RetryMe');
    expect(rows[0].anonymized_at).toBeNull();
    const { rows: dr } = await dbh.query(`SELECT status FROM data_requests WHERE id = $1`, [
      request.id,
    ]);
    expect(dr[0].status).toBe('processing'); // picked up, not completed — retry proceeds

    // The retry (same job, redelivered) finishes the erasure.
    const done = await privacyService.processErasure(
      { userId: user.id, dataRequestId: request.id, reason: 'deletion' },
      {
        deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
        now: new Date(),
        log: quietLog,
      }
    );
    expect(done.phase).toBe('erased');
  });
});

// ---------------------------------------------------------------------------------------------
// NFR-13 — CCPA export
// ---------------------------------------------------------------------------------------------
describe('NFR-13 export — 30-day SLA, full register, requesting user only', () => {
  test('requestExport: due EXACTLY at now + erasureDays; job enqueued immediately, IDs only', async () => {
    const user = await dbh.makeUser();
    const now = new Date('2026-08-21T12:00:00.000Z');
    const { request } = await privacyService.requestExport(user.id, { now, log: quietLog });

    expect(request.kind).toBe('export');
    expect(
      await sqlTimestampEq(
        'data_requests',
        'due_at',
        request.id,
        addDays(now, config.privacy.erasureDays)
      )
    ).toBe(true);

    const jobs = await jobsFor(user.id, 'data.export');
    expect(jobs).toHaveLength(1);
    // Enqueued for NOW (the SLA due date is the deadline, not the execution time).
    const { rows } = await dbh.query(
      `SELECT (available_at <= now()) AS due FROM outbox_jobs WHERE id = $1`,
      [jobs[0].id]
    );
    expect(rows[0].due).toBe(true);
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['dataRequestId', 'userId']);
  });

  test('processExport captures every §3.4 register class for the requester and nobody else', async () => {
    const marker = `PrivUnitX${Date.now()}`;
    const user = await makeFullPiiUser(marker);
    const listing = await dbh.makeListing({ host_id: user.id, title: `${marker} Table` });
    const otherListing = await dbh.makeListing({});
    const booking = await dbh.makeBooking({
      listing_id: otherListing.id,
      guest_id: user.id,
      status: 'completed',
      host_confirmed_completion: true,
      guest_confirmed_completion: true,
    });
    const review = await dbh.insertRow('reviews', {
      booking_id: booking.id,
      author_id: user.id,
      target_user_id: otherListing.host_id,
      rating: 4,
      body: `${marker} review body`,
      moderation_status: 'pending',
    });
    await dbh.insertRow('messages', {
      booking_id: booking.id,
      sender_id: user.id,
      body: `${marker} message body`,
    });
    await dbh.insertRow('safety_alerts', { booking_id: booking.id, raised_by: user.id });
    await dbh.insertRow('media_objects', {
      owner_user_id: user.id,
      entity_type: 'listing',
      entity_id: listing.id,
      storage_key: `listing/${user.id}/privunit-x-${Date.now()}.jpg`,
    });
    await dbh.insertRow('moderation_decisions', {
      content_type: 'review',
      content_id: review.id,
      category: 'benign',
      outcome: 'approved',
      decided_by: 'llm',
    });
    await dbh.insertRow('notification_attempts', {
      recipient_user_id: user.id,
      channel: 'email',
      template: 'email.verification',
      status: 'sent',
    });
    await dbh.insertRow('access_log', {
      actor_user_id: otherListing.host_id,
      subject_user_id: user.id,
      purpose: 'moderation_review',
      resource: `listing:${listing.id}`,
    });
    // A bystander whose data must NOT enter the export.
    const bystander = await dbh.makeUser({ full_name: `Bystander ${marker}` });

    const now = new Date('2026-08-21T13:00:00.000Z');
    const { request } = await privacyService.requestExport(user.id, { now, log: quietLog });
    await privacyService.processExport(
      { userId: user.id, dataRequestId: request.id },
      { now, log: quietLog }
    );

    const view = await privacyService.getExportForUser(user.id, request.id);
    expect(view.status).toBe('completed');
    const data = view.data;
    // Every §3.4 register class is present, keyed for machine reading.
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
    expect(data.account.email).toBe(user.email);
    expect(data.account.phone).toBe('+14155550188'); // decrypted for the owner (NFR-13)
    expect(data.account.emergencyContact.name).toBe(`${marker} Contact`);
    expect(data.listings.map((l) => l.id)).toContain(listing.id);
    expect(data.bookings.map((b) => b.id)).toEqual([booking.id]);
    expect(data.reviews).toHaveLength(1);
    expect(data.messages).toHaveLength(1);
    expect(data.safetyAlerts).toHaveLength(1);
    expect(data.media).toHaveLength(1);
    expect(data.moderationDecisions.map((d) => d.contentId)).toEqual([review.id]);
    expect(data.notificationAttempts).toHaveLength(1);
    expect(data.dataRequests.map((d) => d.id)).toContain(request.id);
    expect(data.accessLog).toHaveLength(1);

    // Requesting user ONLY: no other user's identity appears anywhere in the copy.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(bystander.email);
    expect(serialized).not.toContain(`Bystander ${marker}`);
    expect(serialized).not.toContain(otherListing.host_id); // not even the other party's id

    // ADR-003: the export CONTENT never rode an outbox payload.
    const jobs = await jobsFor(user.id, 'data.export');
    for (const job of jobs) {
      expect(JSON.stringify(job.payload)).not.toContain(marker);
      expect(JSON.stringify(job.payload)).not.toContain('@');
    }
  });

  test('the export is owner-scoped: a foreign id and a foreign owner both read as 404', async () => {
    const owner = await dbh.makeUser();
    const outsider = await dbh.makeUser();
    const { request } = await privacyService.requestExport(owner.id, { log: quietLog });
    await expect(privacyService.getExportForUser(outsider.id, request.id)).rejects.toBeInstanceOf(
      NotFoundError
    );
    await expect(
      privacyService.getExportForUser(owner.id, crypto.randomUUID())
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('an export overtaken by erasure fails safe (no data), and erasure wipes stored copies', async () => {
    const user = await dbh.makeUser({ full_name: 'PrivUnit ExportThenErase' });
    const { request: exportRequest } = await privacyService.requestExport(user.id, {
      log: quietLog,
    });
    await privacyService.processExport(
      { userId: user.id, dataRequestId: exportRequest.id },
      { now: new Date(), log: quietLog }
    );
    // The stored copy exists…
    let row = await privacyRepo.findRequestById(exportRequest.id);
    expect(row.detail.export.account.fullName).toBe('PrivUnit ExportThenErase');

    // …then the account is deleted and erased: the copy must not survive (ST-05).
    const { request: erasure } = await privacyService.requestDeletion(user.id, { log: quietLog });
    await privacyService.processErasure(
      { userId: user.id, dataRequestId: erasure.id, reason: 'deletion' },
      {
        deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
        now: addDays(new Date(), config.privacy.erasureDays),
        log: quietLog,
      }
    );
    row = await privacyRepo.findRequestById(exportRequest.id);
    expect(row.detail).toEqual({});

    // A NEW export job arriving after erasure fails safe instead of exporting a shell.
    const requestRow = await dbh.insertRow('data_requests', {
      user_id: user.id,
      kind: 'export',
      due_at: addDays(new Date(), config.privacy.erasureDays),
    });
    const result = await privacyService.processExport(
      { userId: user.id, dataRequestId: requestRow.id },
      { now: new Date(), log: quietLog }
    );
    expect(result.failed).toBe('user_erased');
    const failed = await privacyRepo.findRequestById(requestRow.id);
    expect(failed.status).toBe('failed');
    expect(failed.detail.export).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// NFR-12 — 24-month inactivity sweep (notice, then erasure; clock-injected throughout)
// ---------------------------------------------------------------------------------------------
describe('NFR-12 inactivity sweep — flag → notice → erase (or cancel)', () => {
  /** A user whose last activity is `months` months before `now` (directly backdated). */
  async function makeStaleUser(now, months, overrides = {}) {
    const user = await dbh.makeUser(overrides);
    await dbh.query(
      `UPDATE users SET last_active_at = $2::timestamptz - make_interval(months => $3)
        WHERE id = $1`,
      [user.id, now, months]
    );
    return user;
  }

  test('flags only accounts past the window; re-running does not double-flag', async () => {
    const now = new Date('2026-08-21T09:00:00.000Z');
    const stale = await makeStaleUser(now, config.privacy.inactivityMonths + 1);
    const fresh = await dbh.makeUser();

    const { flagged } = await privacyService.runInactivitySweep({ now, log: quietLog });
    const mine = flagged.filter((f) => f.userId === stale.id);
    expect(mine).toHaveLength(1);
    expect(flagged.some((f) => f.userId === fresh.id)).toBe(false);

    // The phase-1 job exists with an IDs-only payload naming the notice request.
    const jobs = await jobsFor(stale.id, 'account.erasure');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      userId: stale.id,
      dataRequestId: mine[0].dataRequestId,
      reason: 'inactivity',
    });

    // Idempotent: the open notice request excludes the user from the next sweep.
    const again = await privacyService.runInactivitySweep({ now, log: quietLog });
    expect(again.flagged.some((f) => f.userId === stale.id)).toBe(false);
  });

  test('phase 1 records the notice and schedules the erasure EXACTLY one window later', async () => {
    const now = new Date('2026-08-21T09:30:00.000Z');
    const stale = await makeStaleUser(now, config.privacy.inactivityMonths + 2);
    const { flagged } = await privacyService.runInactivitySweep({ now, log: quietLog });
    const { dataRequestId } = flagged.find((f) => f.userId === stale.id);

    const notices = [];
    const result = await privacyService.processErasure(
      { userId: stale.id, dataRequestId, reason: 'inactivity' },
      {
        deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
        sendNotice: async (args) => {
          notices.push(args);
          return { status: 'sent', attemptId: crypto.randomUUID() };
        },
        now,
        log: quietLog,
      }
    );
    expect(result.phase).toBe('notice_sent');
    expect(notices).toEqual([{ userId: stale.id, dataRequestId }]);

    // Evidence on the request row; the FINAL erasure job sits exactly one window out.
    const row = await privacyRepo.findRequestById(dataRequestId);
    expect(row.detail.noticeSentAt).toBe(now.toISOString());
    const jobs = await jobsFor(stale.id, 'account.erasure');
    expect(jobs).toHaveLength(2); // phase-1 (delivered) + scheduled final
    const finalJob = jobs.find((j) => j.dedupe_key === `account.erasure:final:${dataRequestId}`);
    expect(finalJob).toBeDefined();
    const { rows: eq } = await dbh.query(
      `SELECT (available_at = $2::timestamptz) AS eq FROM outbox_jobs WHERE id = $1`,
      [finalJob.id, addDays(now, config.privacy.erasureDays)]
    );
    expect(eq[0].eq).toBe(true);

    // Phase 2 at the simulated final instant: still inactive → erased.
    const finalInstant = addDays(now, config.privacy.erasureDays);
    const erased = await privacyService.processErasure(
      { userId: stale.id, dataRequestId, reason: 'inactivity' },
      {
        deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
        now: finalInstant,
        log: quietLog,
      }
    );
    expect(erased.phase).toBe('erased');
    expect(await sqlTimestampEq('users', 'anonymized_at', stale.id, finalInstant)).toBe(true);
  });

  test('an undelivered notice defers the flow (retryable) and schedules NO erasure', async () => {
    const now = new Date('2026-08-21T09:45:00.000Z');
    const stale = await makeStaleUser(now, config.privacy.inactivityMonths + 1);
    const { flagged } = await privacyService.runInactivitySweep({ now, log: quietLog });
    const { dataRequestId } = flagged.find((f) => f.userId === stale.id);

    await expect(
      privacyService.processErasure(
        { userId: stale.id, dataRequestId, reason: 'inactivity' },
        {
          deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
          sendNotice: async () => ({ status: 'failed', attemptId: crypto.randomUUID() }),
          now,
          log: quietLog,
        }
      )
    ).rejects.toMatchObject({ code: 'INACTIVITY_NOTICE_UNDELIVERED', retryable: true });

    const jobs = await jobsFor(stale.id, 'account.erasure');
    expect(jobs.filter((j) => j.dedupe_key === `account.erasure:final:${dataRequestId}`)).toEqual(
      []
    );
    const row = await privacyRepo.findRequestById(dataRequestId);
    expect(row.status).toBe('pending');
    expect(row.detail.noticeSentAt).toBeUndefined();
  });

  test('a user active again after the notice is NOT erased (cancelled, recorded)', async () => {
    const now = new Date('2026-08-21T10:15:00.000Z');
    const stale = await makeStaleUser(now, config.privacy.inactivityMonths + 1, {
      full_name: 'PrivUnit CameBack',
    });
    const { flagged } = await privacyService.runInactivitySweep({ now, log: quietLog });
    const { dataRequestId } = flagged.find((f) => f.userId === stale.id);
    await privacyService.processErasure(
      { userId: stale.id, dataRequestId, reason: 'inactivity' },
      {
        deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
        sendNotice: async () => ({ status: 'sent', attemptId: crypto.randomUUID() }),
        now,
        log: quietLog,
      }
    );

    // The user logs back in during the notice window (login touches last_active_at).
    await usersRepo.touchLastActive(stale.id);

    const result = await privacyService.processErasure(
      { userId: stale.id, dataRequestId, reason: 'inactivity' },
      {
        deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
        now: addDays(now, config.privacy.erasureDays),
        log: quietLog,
      }
    );
    expect(result.phase).toBe('cancelled');
    const { rows } = await dbh.query(
      `SELECT full_name, anonymized_at, deleted_at FROM users WHERE id = $1`,
      [stale.id]
    );
    expect(rows[0].full_name).toBe('PrivUnit CameBack');
    expect(rows[0].anonymized_at).toBeNull();
    expect(rows[0].deleted_at).toBeNull();
    const row = await privacyRepo.findRequestById(dataRequestId);
    expect(row.status).toBe('completed');
    expect(row.detail.cancelled).toBe('user_active_again');
  });
});

// ---------------------------------------------------------------------------------------------
// Failure-shape guards (worker misuse and cross-flow races fail loudly, never half-erase)
// ---------------------------------------------------------------------------------------------
describe('processErasure / processExport failure shapes', () => {
  test('missing dependency seams and unknown requests are typed failures', async () => {
    const user = await dbh.makeUser();
    const { request } = await privacyService.requestDeletion(user.id, { log: quietLog });
    // No deleteMedia hook: refuse before touching anything (a handler bug, not a retry).
    await expect(
      privacyService.processErasure(
        { userId: user.id, dataRequestId: request.id, reason: 'deletion' },
        { now: new Date(), log: quietLog }
      )
    ).rejects.toThrow(/deleteMedia/);
    // Unknown request id: NotFound (dead-letters after the retry budget — a caller bug).
    await expect(
      privacyService.processErasure(
        { userId: user.id, dataRequestId: crypto.randomUUID(), reason: 'deletion' },
        {
          deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
          now: new Date(),
          log: quietLog,
        }
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    // Inactivity phase 1 without the notice seam: refuse — erasing unnoticed is NFR-12 breach.
    const noticeRow = await dbh.insertRow('data_requests', {
      user_id: user.id,
      kind: 'inactivity_notice',
      due_at: addDays(new Date(), config.privacy.erasureDays),
    });
    await expect(
      privacyService.processErasure(
        { userId: user.id, dataRequestId: noticeRow.id, reason: 'inactivity' },
        {
          deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
          now: new Date(),
          log: quietLog,
        }
      )
    ).rejects.toThrow(/sendNotice/);

    // processExport: unknown request → NotFound; non-export kind → TypeError.
    await expect(
      privacyService.processExport(
        { userId: user.id, dataRequestId: crypto.randomUUID() },
        { now: new Date(), log: quietLog }
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      privacyService.processExport(
        { userId: user.id, dataRequestId: request.id }, // an 'erasure' request, not 'export'
        { now: new Date(), log: quietLog }
      )
    ).rejects.toThrow(/not 'export'/);
  });

  test('an inactivity erasure arriving AFTER the deletion-flow erasure is a recorded no-op', async () => {
    const user = await dbh.makeUser();
    const { request } = await privacyService.requestDeletion(user.id, { log: quietLog });
    await privacyService.processErasure(
      { userId: user.id, dataRequestId: request.id, reason: 'deletion' },
      {
        deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
        now: addDays(new Date(), config.privacy.erasureDays),
        log: quietLog,
      }
    );
    // A racing inactivity request (flagged before the deletion completed) now resolves
    // cleanly instead of double-erasing.
    const noticeRow = await dbh.insertRow('data_requests', {
      user_id: user.id,
      kind: 'inactivity_notice',
      due_at: addDays(new Date(), config.privacy.erasureDays),
    });
    const result = await privacyService.processErasure(
      { userId: user.id, dataRequestId: noticeRow.id, reason: 'inactivity' },
      {
        deleteMedia: async () => ({ deletedObjects: 0, deletedRows: 0, total: 0 }),
        now: new Date(),
        log: quietLog,
      }
    );
    expect(result.phase).toBe('already_anonymized');
    const row = await privacyRepo.findRequestById(noticeRow.id);
    expect(row.status).toBe('completed');
    expect(row.detail.alreadyAnonymized).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Outbox handlers — contract validation + registry discovery
// ---------------------------------------------------------------------------------------------
describe('outbox handlers account.erasure / data.export', () => {
  test('both types are discovered by the dispatch registry (build-plan §4D interface)', () => {
    const registry = loadHandlers({ log: quietLog });
    expect(registry.has('account.erasure')).toBe(true);
    expect(registry.has('data.export')).toBe(true);
    expect(registry.get('account.erasure')).toBe(accountErasureHandler);
    expect(registry.get('data.export')).toBe(dataExportHandler);
  });

  test('accountErasure rejects malformed payloads before touching anything', async () => {
    await expect(accountErasureHandler.handle(null, {})).rejects.toThrow(TypeError);
    await expect(
      accountErasureHandler.handle({ userId: 'nope', dataRequestId: crypto.randomUUID() }, {})
    ).rejects.toThrow(/userId/);
    await expect(
      accountErasureHandler.handle({ userId: crypto.randomUUID(), dataRequestId: 'nope' }, {})
    ).rejects.toThrow(/dataRequestId/);
    await expect(
      accountErasureHandler.handle(
        { userId: crypto.randomUUID(), dataRequestId: crypto.randomUUID(), reason: 'whim' },
        {}
      )
    ).rejects.toThrow(/reason/);
  });

  test('dataExport rejects malformed payloads and completes a real request via ctx.now', async () => {
    await expect(dataExportHandler.handle(null, {})).rejects.toThrow(TypeError);
    await expect(
      dataExportHandler.handle({ userId: 'nope', dataRequestId: crypto.randomUUID() }, {})
    ).rejects.toThrow(/userId/);

    const user = await dbh.makeUser();
    const { request } = await privacyService.requestExport(user.id, { log: quietLog });
    const simulated = new Date('2026-08-22T08:00:00.000Z');
    await dataExportHandler.handle(
      { userId: user.id, dataRequestId: request.id },
      { log: quietLog, now: simulated }
    );
    expect(await sqlTimestampEq('data_requests', 'completed_at', request.id, simulated)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// scripts/backup.js — ST-05 backup expiry (clock-injected)
// ---------------------------------------------------------------------------------------------
describe('scripts/backup.js — NFR-12 backup expiry is executable', () => {
  function makeBackupDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-backup-test-'));
    return dir;
  }

  function writeDump(dir, name, ageDays, now) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `-- fixture dump ${name}\n`);
    const mtime = new Date(now.getTime() - ageDays * DAY_MS);
    fs.utimesSync(file, mtime, mtime);
    return file;
  }

  test('prunes dumps older than config.backup.retentionDays and keeps newer ones', () => {
    const now = new Date('2026-08-21T00:00:00.000Z');
    const dir = makeBackupDir();
    try {
      const retention = config.backup.retentionDays;
      writeDump(dir, 'old.dump', retention + 5, now);
      writeDump(dir, 'fresh.dump', retention - 5, now);

      const { pruned, kept } = backupScript.pruneBackups({
        dir,
        retentionDays: retention,
        now,
      });
      expect(pruned).toEqual(['old.dump']);
      expect(kept).toEqual(['fresh.dump']);
      expect(fs.existsSync(path.join(dir, 'old.dump'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'fresh.dump'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--dry-run reports without deleting; input validation fails fast', () => {
    const now = new Date('2026-08-21T00:00:00.000Z');
    const dir = makeBackupDir();
    try {
      writeDump(dir, 'old.dump', config.backup.retentionDays + 1, now);
      const { pruned } = backupScript.pruneBackups({
        dir,
        retentionDays: config.backup.retentionDays,
        now,
        dryRun: true,
      });
      expect(pruned).toEqual(['old.dump']);
      expect(fs.existsSync(path.join(dir, 'old.dump'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    expect(() => backupScript.pruneBackups({ dir: '', retentionDays: 1 })).toThrow(/dir/);
    expect(() => backupScript.pruneBackups({ dir: '/tmp', retentionDays: 0 })).toThrow(
      /retentionDays/
    );
    expect(() =>
      backupScript.pruneBackups({
        dir: path.join(os.tmpdir(), `hp-none-${Date.now()}`),
        retentionDays: 1,
      })
    ).toThrow(/not a directory/);
  });

  test('parseArgs: prune mode needs --dir; sweep mode stands alone; unknown args throw', () => {
    expect(backupScript.parseArgs(['--dir', '/var/backups'])).toMatchObject({
      dir: '/var/backups',
      sweepInactivity: false,
    });
    expect(backupScript.parseArgs(['--dir=/b', '--dry-run'])).toMatchObject({
      dir: '/b',
      dryRun: true,
    });
    expect(backupScript.parseArgs(['--sweep-inactivity', '--limit', '5'])).toMatchObject({
      sweepInactivity: true,
      limit: 5,
    });
    expect(backupScript.parseArgs(['--sweep-inactivity', '--limit=9'])).toMatchObject({
      sweepInactivity: true,
      limit: 9,
    });
    expect(() => backupScript.parseArgs([])).toThrow(/--dir/);
    expect(() => backupScript.parseArgs(['--wat'])).toThrow(/unknown argument/);
    expect(() => backupScript.parseArgs(['--sweep-inactivity', '--limit', '0'])).toThrow(/--limit/);
  });

  test('the policy knob is validated config, documented in .env.example (ST-05)', () => {
    expect(config.backup.retentionDays).toBe(config.privacy.erasureDays); // one 30-day window
    const envExample = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
    expect(envExample).toMatch(/^BACKUP_RETENTION_DAYS=30$/m);
  });

  // -------------------------------------------------------------------------------------------
  // main() — the CLI dispatch itself, in-process (ITA4-F2). Only the pool/redis closers are
  // injected (the suite must not close its own shared handles); everything else is the real
  // code path: real parseArgs, real config.backup wiring, real privacyService on success.
  // -------------------------------------------------------------------------------------------
  test('main --sweep-inactivity flags via the REAL service, reports ids, closes pool AND redis', async () => {
    const stale = await dbh.makeUser();
    await dbh.query(
      `UPDATE users SET last_active_at = now() - make_interval(months => $2) WHERE id = $1`,
      [stale.id, config.privacy.inactivityMonths + 1]
    );

    const lines = [];
    const closes = { pool: 0, redis: 0 };
    const result = await backupScript.main(
      ['--sweep-inactivity'],
      { log: (line) => lines.push(line) },
      {
        closePool: async () => {
          closes.pool += 1;
        },
        closeRedis: async () => {
          closes.redis += 1;
        },
      }
    );

    // The real sweep flagged the backdated account (scoped assertion — shared database).
    expect(result.flagged.some((f) => f.userId === stale.id)).toBe(true);
    const jobs = await jobsFor(stale.id, 'account.erasure');
    expect(jobs).toHaveLength(1);

    // NFR-08: the structured summary line names the run and the flagged ids, nothing more.
    const done = lines.map((l) => JSON.parse(l)).find((e) => e.event === 'inactivity_sweep_done');
    expect(done).toBeDefined();
    expect(done.userIds).toContain(stale.id);
    expect(done.flagged).toBe(done.userIds.length);

    // Resource-close logic: both closers ran exactly once on the success path.
    expect(closes).toEqual({ pool: 1, redis: 1 });
  });

  test('main --sweep-inactivity forwards --limit and closes pool AND redis even when the sweep throws', async () => {
    const sweepCalls = [];
    const closes = [];
    await expect(
      backupScript.main(
        ['--sweep-inactivity', '--limit', '7'],
        { log: () => {} },
        {
          privacyService: {
            runInactivitySweep: async (opts) => {
              sweepCalls.push(opts);
              throw new Error('sweep exploded');
            },
          },
          closePool: async () => closes.push('pool'),
          closeRedis: async () => closes.push('redis'),
        }
      )
    ).rejects.toThrow('sweep exploded');

    // The parsed --limit reached the service call unmangled…
    expect(sweepCalls).toHaveLength(1);
    expect(sweepCalls[0]).toMatchObject({ limit: 7 });
    // …and the finally still closed BOTH handles, in order (a dropped closeRedis() or a
    // close skipped on failure would hang the lifecycle cron — the ITA4-F2 regression).
    expect(closes).toEqual(['pool', 'redis']);
  });

  test('main --dir prunes through config.backup.retentionDays and reports the summary line', async () => {
    const now = new Date(); // main() uses the real clock; fixtures are backdated against it
    const dir = makeBackupDir();
    try {
      const retention = config.backup.retentionDays;
      writeDump(dir, 'ancient.dump', retention + 5, now);
      writeDump(dir, 'recent.dump', 1, now);

      const lines = [];
      const result = await backupScript.main(['--dir', dir], { log: (line) => lines.push(line) });

      expect(result.pruned).toEqual(['ancient.dump']);
      expect(result.kept).toEqual(['recent.dump']);
      expect(fs.existsSync(path.join(dir, 'ancient.dump'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'recent.dump'))).toBe(true);

      const events = lines.map((l) => JSON.parse(l));
      expect(events.find((e) => e.event === 'backup_pruned')).toMatchObject({
        file: 'ancient.dump',
        dryRun: false,
      });
      // The policy number in the report is the config value — never an inline constant.
      expect(events.find((e) => e.event === 'backup_prune_done')).toMatchObject({
        dir,
        retentionDays: retention,
        pruned: 1,
        kept: 1,
        dryRun: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
