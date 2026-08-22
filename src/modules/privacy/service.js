// src/modules/privacy/service.js — U4-PRIVACY: the NFR-12/NFR-13 data-lifecycle service —
// account deletion + scheduled erasure, CCPA export, 24-month inactivity sweep (SPMP WA-6).
//
// Requirement traceability (SRS Appendix B):
//   NFR-12 (ST-05) — requestDeletion marks deleted_at, kills the user's sessions, writes a
//            data_requests row (kind 'erasure') and enqueues 'account.erasure' with
//            available_at = now + config.privacy.erasureDays IN THE SAME TRANSACTION as the
//            deletion mark (ADR-001/003 — no dual write). processErasure — run by the
//            worker at the due instant, CLOCK-INJECTED via `now` so the 30-day window is
//            verifiable without waiting — empties every §3.4 PII column, deletes every
//            owned media object BY KEY through the injected ADR-004 primitive
//            (mediaService.deleteForUser — injected by the handler, so this module never
//            touches an adapter), rewrites reviews/messages/safety alerts/moderation
//            records to anonymized references while retaining them, scrubs listing content
//            incl. location, and stamps anonymized_at. runInactivitySweep flags accounts
//            inactive for config.privacy.inactivityMonths, records the notice (worker-sent,
//            through the ADR-011 transport → NOTIFICATION_ATTEMPT row) and erases after the
//            notice window — cancelling if the user became active again.
//   NFR-13 (ST-06) — requestExport writes a data_requests row (kind 'export') with
//            due_at = now + config.privacy.erasureDays (the 30-day CCPA SLA) and enqueues
//            'data.export' immediately; processExport stores the machine-readable §3.4
//            register copy on the request row — NEVER in an outbox payload (ADR-003:
//            payloads carry IDs only); getExportForUser serves it to its OWNER only.
//   FR-13 / ADR-011 — the inactivity notice rides the one notification transport, injected
//            by the worker handler; dev/test resolve the mock that records the attempt row.
//   NFR-08 (MT-01) — every mutation here emits ONE structured audit record through the
//            request/job-scoped logger (correlation ID included); IDs and dates only, never
//            a name, email, phone or address (§3.4 PII register).
//   NFR-04 — the erased password sentinel can never authenticate (see repo.eraseUserRow).
//   AB-05 / AB-08 / ADR-006 — sessions die through the ONE auth session store; every read
//            here is keyed on the authenticated user id, so no cross-user access exists.
//   ADR-009-style config discipline — every window (erasure days, inactivity months) is
//            read from src/config; no policy number appears in this module.
'use strict';

const config = require('../../config');
const { withTransaction } = require('../../db/tx');
const { redis, key } = require('../../db/redis');
const { NotFoundError, ServiceUnavailableError } = require('../../lib/errors');
const { logger, audit } = require('../../lib/logger');
const outbox = require('../../outbox/outbox');
const sessions = require('../auth/sessions');
const repo = require('./repo');

/** Outbox job types this unit publishes (build-plan §4D public interface). */
const ERASURE_JOB_TYPE = 'account.erasure';
const EXPORT_JOB_TYPE = 'data.export';

const DAY_MS = 24 * 3600 * 1000;

/** `days` days after `from` — ONE value reused for due_at AND available_at so the
 *  "erasure job due exactly at now + erasureDays" acceptance is assertable as equality. */
function addDays(from, days) {
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * Destroy EVERY live session belonging to `userId` (AB-05: a deleted account's cookies are
 * unusable immediately). The current request's token dies first; the SCAN sweep then walks
 * the session namespace — sessions are keyed by token digest, not user, so a bounded scan
 * is the only complete revocation. Redis stays sessions-only (SRS §2.4).
 * @returns {Promise<number>} sessions destroyed
 */
async function destroySessionsForUser(userId, { currentToken = null } = {}) {
  let destroyed = 0;
  if (currentToken && (await sessions.destroySession(currentToken))) destroyed += 1;
  const pattern = key('session', '*');
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    for (const sessionKey of keys) {
      const raw = await redis.get(sessionKey);
      if (!raw) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch (_corruptRecord) {
        continue; // unusable record — auth middleware fails it closed on its own
      }
      if (record && record.userId === userId) {
        destroyed += await redis.del(sessionKey);
      }
    }
  } while (cursor !== '0');
  return destroyed;
}

/**
 * DELETE /api/users/me (NFR-12): mark deleted, schedule erasure at now + erasureDays, kill
 * the sessions. Idempotent: a repeat request (another device's still-open session) reuses
 * the open erasure request and the deduped outbox job instead of scheduling a second one.
 *
 * @param {string} userId  the SESSION identity (never a caller-supplied id — AB-08)
 * @param {{sessionToken?: string|null, now?: Date, log?: object}} [opts]  `now` is the
 *   clock-injection seam (tests pass a simulated instant; production omits it)
 * @returns {Promise<{request: object, erasureAt: Date}>}
 */
async function requestDeletion(
  userId,
  { sessionToken = null, now = new Date(), log = logger } = {}
) {
  const erasureAt = addDays(now, config.privacy.erasureDays);

  const { request, reused } = await withTransaction(async (client) => {
    const user = await repo.getUser(userId, client);
    if (!user || user.anonymized_at !== null) {
      throw new NotFoundError('User not found');
    }

    await repo.markDeleted(client, userId, now);

    let row = await repo.findOpenRequest(userId, 'erasure', client);
    const alreadyRequested = row !== null;
    if (!row) {
      row = await repo.createRequest(client, {
        userId,
        kind: 'erasure',
        dueAt: erasureAt,
        detail: { requestedAt: now.toISOString() },
      });
    }

    // SAME transaction as the deletion mark (ADR-001/003). Payload carries IDs only; the
    // dedupe key makes a repeat DELETE a no-op instead of a second erasure.
    await outbox.enqueue(client, {
      type: ERASURE_JOB_TYPE,
      payload: { userId, dataRequestId: row.id, reason: 'deletion' },
      dedupeKey: `${ERASURE_JOB_TYPE}:deletion:${userId}`,
      availableAt: row.due_at,
    });

    return { request: row, reused: alreadyRequested };
  });

  // After commit: no session of this account survives (AB-05). A failure here would leave
  // the deletion committed and the erasure scheduled — the cookie then dies at its TTL.
  const sessionsDestroyed = await destroySessionsForUser(userId, { currentToken: sessionToken });

  audit(log, {
    event: 'privacy.deletion_requested',
    outcome: reused ? 'noop' : 'success',
    actorUserId: userId,
    entityType: 'data_request',
    entityId: request.id,
    dueAt: request.due_at,
    sessionsDestroyed,
  });

  return { request: repo.serializeRequest(request), erasureAt: request.due_at };
}

/**
 * The 'account.erasure' job body (WORKER-ONLY callers). Behaviour by `reason`:
 *   'deletion'   — erase now (the job only became available at the scheduled instant).
 *   'inactivity' — two-phase: first delivery sends the NFR-12 notice through the injected
 *                  transport seam and schedules the real erasure one notice window later;
 *                  the second delivery erases — unless the user was active again since
 *                  being flagged, which cancels the erasure.
 *
 * Clock injection (build-plan §4D): `now` is the simulated instant tests run the job at;
 * every timestamp written here (anonymized_at, completed_at) derives from it.
 *
 * @param {{userId: string, dataRequestId: string, reason?: 'deletion'|'inactivity'}} payload
 * @param {{deleteMedia: Function, sendNotice?: Function, now?: Date, log?: object}} deps
 *   `deleteMedia` MUST be the media service's ADR-004 delete-by-key erasure hook — one
 *   deleteByKey call per owned key — injected by src/outbox/handlers/accountErasure.js so
 *   this module never imports worker-only code; `sendNotice` is the ADR-011 transport seam.
 */
async function processErasure(
  payload,
  { deleteMedia, sendNotice, now = new Date(), log = logger }
) {
  const { userId, dataRequestId, reason = 'deletion' } = payload;
  if (typeof deleteMedia !== 'function') {
    throw new TypeError('processErasure: deleteMedia (ADR-004 delete-by-key hook) is required');
  }

  const request = await repo.findRequestById(dataRequestId);
  if (!request) {
    throw new NotFoundError(`data request ${dataRequestId} not found`);
  }
  if (request.status === 'completed' || request.status === 'failed') {
    return { phase: 'already_done', requestStatus: request.status }; // idempotent redelivery
  }

  const user = await repo.getUser(userId);
  if (!user || user.anonymized_at !== null) {
    // Already erased (e.g. the deletion-flow job ran before this inactivity one) — record
    // completion so the request does not dangle, and do nothing else.
    await withTransaction(async (client) => {
      await repo.completeRequest(client, dataRequestId, {
        completedAt: now,
        detail: { alreadyAnonymized: true },
      });
    });
    return { phase: 'already_anonymized' };
  }

  if (reason === 'inactivity') {
    const detail = request.detail || {};
    if (!detail.noticeSentAt) {
      // ---- phase 1: the notice must precede any erasure (NFR-12 "after notice") --------
      if (typeof sendNotice !== 'function') {
        throw new TypeError('processErasure: sendNotice is required for inactivity requests');
      }
      const result = await sendNotice({ userId, dataRequestId });
      if (!result || result.status !== 'sent') {
        // Recorded as a failed NOTIFICATION_ATTEMPT by the transport; retry via the worker
        // budget — erasing without a delivered notice would violate NFR-12.
        throw new ServiceUnavailableError('inactivity notice not delivered; will retry', {
          code: 'INACTIVITY_NOTICE_UNDELIVERED',
          retryable: true,
        });
      }
      const erasureAt = addDays(now, config.privacy.erasureDays);
      await repo.mergeRequestDetail(dataRequestId, {
        noticeSentAt: now.toISOString(),
        noticeAttemptId: result.attemptId,
        erasureScheduledAt: erasureAt.toISOString(),
      });
      await withTransaction(async (client) => {
        await outbox.enqueue(client, {
          type: ERASURE_JOB_TYPE,
          payload: { userId, dataRequestId, reason: 'inactivity' },
          dedupeKey: `${ERASURE_JOB_TYPE}:final:${dataRequestId}`,
          availableAt: erasureAt,
        });
      });
      audit(log, {
        event: 'privacy.inactivity_notice_sent',
        outcome: 'success',
        actorUserId: userId,
        entityType: 'data_request',
        entityId: dataRequestId,
        erasureScheduledAt: erasureAt,
      });
      return { phase: 'notice_sent', erasureAt };
    }

    // ---- phase 2 guard: activity since the flag cancels the erasure ---------------------
    if (new Date(user.last_active_at) > new Date(request.created_at)) {
      await withTransaction(async (client) => {
        await repo.completeRequest(client, dataRequestId, {
          completedAt: now,
          detail: { cancelled: 'user_active_again' },
        });
      });
      audit(log, {
        event: 'privacy.erasure_cancelled',
        outcome: 'noop',
        actorUserId: userId,
        entityType: 'data_request',
        entityId: dataRequestId,
        reason: 'user_active_again',
      });
      return { phase: 'cancelled' };
    }
  }

  // ---- the erasure itself (NFR-12, ST-05) ----------------------------------------------------
  await repo.markRequestProcessing(dataRequestId);

  // Media FIRST, outside the transaction: deleteForUser calls deleteByKey once per owned
  // key and throws a retryable error on partial failure, so a crash between storage and
  // database work re-runs safely (both sides are idempotent — ADR-004).
  const media = await deleteMedia(userId);

  await withTransaction(async (client) => {
    await repo.eraseUserRow(client, userId, now);
    const rewritten = await repo.severAuthorReferences(client, userId);
    const listingsScrubbed = await repo.scrubListings(client, userId);
    await repo.clearHostProfile(client, userId);
    await repo.deleteVerificationTokens(client, userId);
    await repo.wipeExportDetails(client, userId);
    await repo.completeRequest(client, dataRequestId, {
      completedAt: now,
      detail: {
        erased: true,
        mediaObjectsDeleted: media.deletedObjects,
        rewritten,
        listingsScrubbed,
      },
    });
  });

  // Any session that survived the deletion request (or that an inactivity-erased user still
  // held) dies with the account (AB-05).
  await destroySessionsForUser(userId);

  audit(log, {
    event: 'privacy.account_erased',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'user',
    entityId: userId,
    initiatedBy: reason === 'inactivity' ? 'inactivity_sweep' : 'user_request',
    dataRequestId,
    mediaObjectsDeleted: media.deletedObjects,
  });

  return { phase: 'erased', mediaObjectsDeleted: media.deletedObjects };
}

/**
 * POST /api/users/me/export (NFR-13 CCPA): create the export request with the 30-day SLA
 * due date and enqueue the worker job IMMEDIATELY, in one transaction.
 * @returns {Promise<{request: object}>}
 */
async function requestExport(userId, { now = new Date(), log = logger } = {}) {
  const dueAt = addDays(now, config.privacy.erasureDays);

  const request = await withTransaction(async (client) => {
    const user = await repo.getUser(userId, client);
    if (!user || user.deleted_at !== null) {
      throw new NotFoundError('User not found');
    }
    const row = await repo.createRequest(client, {
      userId,
      kind: 'export',
      dueAt,
      detail: { requestedAt: now.toISOString() },
    });
    // IDs only (ADR-003) — the export CONTENT never rides an outbox payload; the worker
    // stores it on the data_requests row and the owner fetches it over the API.
    await outbox.enqueue(client, {
      type: EXPORT_JOB_TYPE,
      payload: { userId, dataRequestId: row.id },
      dedupeKey: `${EXPORT_JOB_TYPE}:${row.id}`,
    });
    return row;
  });

  audit(log, {
    event: 'privacy.export_requested',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'data_request',
    entityId: request.id,
    dueAt: request.due_at,
  });

  return { request: repo.serializeRequest(request) };
}

/**
 * The 'data.export' job body (WORKER-ONLY callers): assemble the §3.4 register copy for the
 * requesting user only and store it on the request row (NFR-13).
 */
async function processExport(payload, { now = new Date(), log = logger } = {}) {
  const { userId, dataRequestId } = payload;

  const request = await repo.findRequestById(dataRequestId);
  if (!request) {
    throw new NotFoundError(`data request ${dataRequestId} not found`);
  }
  if (request.kind !== 'export') {
    throw new TypeError(`data request ${dataRequestId} is '${request.kind}', not 'export'`);
  }
  if (request.status === 'completed' || request.status === 'failed') {
    return { alreadyDone: true, requestStatus: request.status }; // idempotent redelivery
  }

  const user = await repo.getUser(userId);
  if (!user || user.anonymized_at !== null) {
    // Erased in the meantime: there is no personal data left to copy — NFR-12 wins.
    await repo.failRequest(dataRequestId, 'user_erased');
    audit(log, {
      event: 'privacy.export_failed',
      outcome: 'failure',
      actorUserId: userId,
      entityType: 'data_request',
      entityId: dataRequestId,
      reason: 'user_erased',
    });
    return { failed: 'user_erased' };
  }

  await repo.markRequestProcessing(dataRequestId);
  const exportData = await repo.collectExport(userId);

  await withTransaction(async (client) => {
    await repo.completeRequest(client, dataRequestId, {
      completedAt: now,
      detail: { export: exportData, generatedAt: now.toISOString() },
    });
  });

  audit(log, {
    event: 'privacy.export_completed',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'data_request',
    entityId: dataRequestId,
    initiatedBy: 'worker',
  });

  return { completedAt: now };
}

/**
 * GET /api/users/me/export/:id — the OWNER's view of one export request. A foreign or
 * non-export id is a plain 404 (existence is not disclosed — AB-08).
 */
async function getExportForUser(userId, requestId) {
  const row = await repo.findRequestForUser(requestId, userId);
  if (!row || row.kind !== 'export') {
    throw new NotFoundError('Export request not found');
  }
  return {
    ...repo.serializeRequest(row),
    data: row.detail && row.detail.export ? row.detail.export : null,
  };
}

/**
 * The 24-month inactivity sweep (NFR-12): flag every account stale at the (clock-injected)
 * instant, writing the data_requests row and the phase-1 'account.erasure' job atomically
 * per user. The worker then sends the notice and schedules the erasure one notice window
 * later (see processErasure). Run from operations tooling (scripts/backup.js
 * --sweep-inactivity) or tests; safe to re-run — flagged users are excluded until their
 * request resolves.
 * @returns {Promise<{flagged: Array<{userId: string, dataRequestId: string}>}>}
 */
async function runInactivitySweep({ now = new Date(), log = logger, limit = 100 } = {}) {
  const stale = await repo.findInactiveUsers({
    now,
    months: config.privacy.inactivityMonths,
    limit,
  });

  const flagged = [];
  for (const { id: userId } of stale) {
    const request = await withTransaction(async (client) => {
      const row = await repo.createRequest(client, {
        userId,
        kind: 'inactivity_notice',
        dueAt: addDays(now, config.privacy.erasureDays),
        detail: { flaggedAt: now.toISOString() },
      });
      await outbox.enqueue(client, {
        type: ERASURE_JOB_TYPE,
        payload: { userId, dataRequestId: row.id, reason: 'inactivity' },
        dedupeKey: `${ERASURE_JOB_TYPE}:notice:${row.id}`,
        availableAt: now,
      });
      return row;
    });
    audit(log, {
      event: 'privacy.inactivity_flagged',
      outcome: 'success',
      actorUserId: userId,
      entityType: 'data_request',
      entityId: request.id,
      initiatedBy: 'inactivity_sweep',
      dueAt: request.due_at,
    });
    flagged.push({ userId, dataRequestId: request.id });
  }

  return { flagged };
}

module.exports = {
  ERASURE_JOB_TYPE,
  EXPORT_JOB_TYPE,
  requestDeletion,
  processErasure,
  requestExport,
  processExport,
  getExportForUser,
  runInactivitySweep,
  destroySessionsForUser,
};
