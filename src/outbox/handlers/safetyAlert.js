// src/outbox/handlers/safetyAlert.js — U4-SAFETY: worker-side delivery of every 'safety.alert'
// job (FR-07 end to end), discovered by src/outbox/dispatch.js. Follows the wave-2/3 precedent
// (emailVerification.js, bookingNotifications.js): the feature unit owns its handler file, so
// no shared registry is ever edited by two units.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-07 (TC-07, IT-04) — the deferred half of "persist the alert, notify the moderator, and
//            attempt delivery to the user's approved emergency-contact channel":
//              (0) U4-SAFETY-COMPLETE: the alert's UNIFIED-queue entry — a moderation_queue
//                  row of content_type 'safety_alert' (migration 0006) — is filed FIRST,
//                  before any delivery leg, so it exists and remains however delivery ends,
//                  including after the job dead-letters. Filing is idempotent per open item
//                  (RT-02) and gated on the 4A read model declaring support for the type
//                  (safetyRepo.unifiedQueueSupported — see the rationale there); until then
//                  the safety_alerts row itself, at GET /api/moderation/alerts, is the
//                  complete FR-07 queue and nothing is lost;
//              (a) every Moderator (SRS §2.3) is emailed 'safety-alert-moderator'; the alert
//                  row itself is the queue entry they act on (GET /api/moderation/alerts),
//                  which exists from the moment the request committed — so an alert is
//                  reviewable even while this delivery is still failing;
//              (b) the raising user's approved emergency contact is emailed
//                  'safety-alert-emergency'. No contact on file (or an erased raiser) is NOT
//                  a failure: the attempt row and the alert are both recorded 'no_channel'
//                  and never retried (§3.4 notification_status / alert_delivery_status);
//              (c) success sets the alert to 'delivered'.
//            ANY failed leg marks the alert 'retrying' and THROWS, so the outbox retry/backoff
//            budget applies (attempts increment, exponentially spaced) and the job finally
//            dead-letters with its reason — with the alert left 'failed' on that last attempt
//            and STILL LISTED in the moderator queue ("failed delivery shall be retried and
//            remain visible for review"). The alert is never left silently 'pending'.
//   ADR-011 — delivery is EMAIL through the ONE transport contract, which persists a §3.4
//            NOTIFICATION_ATTEMPT row per send: the mock transport in dev and the whole
//            automated suite, SendGrid only when configured. Tests assert on those rows,
//            never on a third party's behaviour.
//   ADR-001/003 — this file is the ONLY place FR-07 touches a transport: it runs exclusively
//            under the outbox worker, never on a request path. The payload carries IDs only
//            ({alertId, bookingId}); the emergency-contact address is read as ciphertext,
//            decrypted HERE at send time and handed straight to the transport — it never
//            enters an outbox payload, a notification row or a log line (§3.4 PII register).
//   RT-02   — ctx.idempotencyKey is the enqueue-side dedupe key; each leg derives its own
//            stable transport idempotency key from the alert id, so a job redelivered after a
//            worker crash reuses its NOTIFICATION_ATTEMPT rows and can never double-send.
//            The alert mark* statements are all conditional on "not already delivered".
//   NFR-08 (MT-01) — ctx.log is the worker's job-scoped child logger carrying the originating
//            request's correlationId into these lines; events are IDs only.
//   NFR-09  — a provider outage is absorbed by the outbox (defer + bounded retry), never by
//            the user raising the alert.
//
// Handler contract (build-plan §1 convention 3): { type, handle(payload, ctx) } with ctx
// = { jobId, type, attempt, correlationId, idempotencyKey, log } (src/outbox/dispatch.js).
'use strict';

const config = require('../../config');
const { decrypt } = require('../../db/fieldCrypto');
const { logger, audit } = require('../../lib/logger');
// Worker-only import (ADR-001/003): the transport reaches src/adapters/*.
const transport = require('../../modules/notifications/transport');
const notifRepo = require('../../modules/notifications/repo');
const safetyRepo = require('../../modules/safety/repo');
const { JOB_TYPE } = require('../../modules/safety/service');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SendGrid template registry keys (src/adapters/sendgrid.js EMAIL_SUBJECTS). */
const MODERATOR_TEMPLATE = 'safety-alert-moderator';
const EMERGENCY_TEMPLATE = 'safety-alert-emergency';

/** Stable per-leg transport idempotency keys (RT-02 — redelivery reuses the same rows). */
const moderatorKey = (alertId, moderatorId) => `${JOB_TYPE}:${alertId}:moderator:${moderatorId}`;
const emergencyKey = (alertId) => `${JOB_TYPE}:${alertId}:emergency`;

/**
 * Record a failed delivery on the alert itself so the moderator queue never shows a stale
 * 'pending' for an alert the worker is already fighting with. On the LAST attempt of the
 * configured outbox budget the alert is marked 'failed' (terminal, honest next to the
 * dead-lettered job) instead of 'retrying'.
 * @returns {Promise<void>}
 */
async function markDeliveryFailure({ alertId, attempt, terminalReason, log }) {
  const maxAttempts = config.outbox.maxAttempts;
  const terminal = Number.isInteger(attempt) && attempt >= maxAttempts;
  if (terminal) await safetyRepo.markFailed(alertId);
  else await safetyRepo.markRetrying(alertId);
  log.warn(
    {
      event: 'safety_alert_delivery_failed',
      alertId,
      attempt,
      maxAttempts,
      deliveryStatus: terminal ? 'failed' : 'retrying',
      reason: terminalReason,
    },
    'safety_alert_delivery_failed'
  );
}

/** A coded delivery error; handle()'s catch records it on the alert before rethrowing. */
function deliveryError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * The one failure that must NOT be re-marked by handle()'s catch: the contact ciphertext is
 * unreadable, which deliverToEmergencyContact() already recorded as terminally 'failed'
 * (retrying cannot fix it, and re-marking would downgrade it back to 'retrying').
 */
const ALREADY_MARKED_TERMINAL = 'SAFETY_ALERT_CONTACT_UNREADABLE';

/**
 * (a) FR-07 "notify the moderator": one email per Moderator account. The durable queue entry
 * is the safety_alerts row itself (GET /api/moderation/alerts), which already exists — this
 * leg is the push notice on top of it.
 * @returns {Promise<number>} how many moderators were notified
 */
async function notifyModerators({ alert, alertId, log }) {
  const moderatorIds = await safetyRepo.listModeratorIds();
  if (moderatorIds.length === 0) {
    // No moderator account exists yet (fresh deployment): the alert still sits in the queue
    // at GET /api/moderation/alerts, so review is possible — but say so loudly.
    log.warn(
      { event: 'safety_alert_no_moderator_recipient', alertId },
      'safety_alert_no_moderator_recipient'
    );
    return 0;
  }
  const failed = [];
  for (const moderatorId of moderatorIds) {
    const result = await transport.send(
      {
        userId: moderatorId,
        channel: 'email',
        template: MODERATOR_TEMPLATE,
        params: { alertId, bookingId: alert.booking_id },
        idempotencyKey: moderatorKey(alertId, moderatorId),
      },
      { log }
    );
    if (result.status !== 'sent') failed.push(moderatorId);
  }
  if (failed.length > 0) {
    throw deliveryError(
      `${JOB_TYPE}: moderator notification failed for ${failed.length} of ` +
        `${moderatorIds.length} moderators (alert ${alertId}); outbox will retry`,
      'SAFETY_ALERT_MODERATOR_NOTICE_FAILED'
    );
  }
  return moderatorIds.length;
}

/**
 * (b)+(c) FR-07 emergency-contact attempt. Resolves the approved channel, records
 * 'no_channel' when there is none, otherwise delivers and marks the alert 'delivered'.
 * @returns {Promise<{status: 'delivered'|'no_channel', attemptId?: string}>}
 */
async function deliverToEmergencyContact({ alert, alertId, moderatorsNotified, log }) {
  let emergencyEmail = null;
  try {
    emergencyEmail = decrypt(alert.emergency_contact_email_enc);
  } catch (err) {
    // Unreadable ciphertext (corrupted or written under a rotated key): retrying cannot fix
    // it, so record a terminal failure the moderator can see rather than looping silently.
    await safetyRepo.markFailed(alertId);
    log.error(
      { event: 'safety_alert_contact_unreadable', alertId, err },
      'safety_alert_contact_unreadable'
    );
    throw deliveryError(
      `${JOB_TYPE}: the stored emergency-contact address for alert ${alertId} could not be ` +
        'decrypted; the alert stays in the moderator queue as failed',
      'SAFETY_ALERT_CONTACT_UNREADABLE'
    );
  }

  if (!emergencyEmail) {
    // FR-07 with no approved channel: recorded, never retried. The attempt row keeps the
    // audit trail ("we had nothing to deliver to"), which is distinct from a failure.
    if (alert.raised_by) {
      const { attempt } = await notifRepo.createAttempt({
        recipientUserId: alert.raised_by,
        channel: 'email',
        template: EMERGENCY_TEMPLATE,
        params: { alertId, bookingId: alert.booking_id },
        idempotencyKey: emergencyKey(alertId),
      });
      await notifRepo.markNoChannel(attempt.id);
    }
    await safetyRepo.markNoChannel(alertId);
    audit(log, {
      event: 'safety.alert_no_channel',
      outcome: 'success',
      actorUserId: alert.raised_by,
      entityType: 'safety_alert',
      entityId: alertId,
      bookingId: alert.booking_id,
    });
    return { status: 'no_channel' };
  }

  // The address is resolved HERE and handed straight to the transport: it is never written
  // to the notification row (recipient_user_id only) or to any log line (§3.4 PII register).
  const result = await transport.send(
    {
      userId: alert.raised_by,
      channel: 'email',
      template: EMERGENCY_TEMPLATE,
      params: { alertId, bookingId: alert.booking_id },
      idempotencyKey: emergencyKey(alertId),
      recipientEmail: emergencyEmail,
    },
    { log }
  );
  if (result.status !== 'sent') {
    throw deliveryError(
      `${JOB_TYPE}: emergency-contact delivery failed for alert ${alertId} ` +
        `(attempt row ${result.attemptId}); outbox will retry`,
      'SAFETY_ALERT_EMERGENCY_DELIVERY_FAILED'
    );
  }

  await safetyRepo.markDelivered(alertId);
  audit(log, {
    event: 'safety.alert_delivered',
    outcome: 'success',
    actorUserId: alert.raised_by,
    entityType: 'safety_alert',
    entityId: alertId,
    bookingId: alert.booking_id,
    moderatorsNotified,
  });
  return { status: 'delivered', attemptId: result.attemptId };
}

module.exports = {
  type: JOB_TYPE,

  /**
   * Deliver one safety alert (FR-07).
   * @param {{alertId: string, bookingId?: string}} payload  IDs only
   * @param {{attempt?: number, log?: object}} [ctx]  worker job context
   * @returns {Promise<{status: 'delivered'|'no_channel'|'noop', attemptId?: string}>}
   * @throws on a malformed payload (a caller bug — retries then dead-letters) and on any
   *   failed delivery leg (so the worker retries with backoff and eventually dead-letters,
   *   keeping the alert visible in the moderator queue — NFR-09)
   */
  async handle(payload, ctx = {}) {
    const log = ctx.log || logger;
    if (!payload || typeof payload !== 'object') {
      throw new TypeError(`${JOB_TYPE}: payload must be { alertId, bookingId }`);
    }
    const { alertId } = payload;
    if (typeof alertId !== 'string' || !UUID_RE.test(alertId)) {
      throw new TypeError(`${JOB_TYPE}: payload.alertId must be a UUID`);
    }

    const alert = await safetyRepo.loadForDelivery(alertId);
    if (!alert) {
      // The alert (or its booking) was erased under NFR-12 before delivery — nothing to do.
      log.info({ event: 'safety_alert_noop', alertId, reason: 'missing' }, 'safety_alert_noop');
      return { status: 'noop' };
    }

    if (alert.delivery_status === 'delivered' || alert.delivery_status === 'no_channel') {
      // Terminal already: a redelivered job must not send twice (RT-02).
      log.info(
        { event: 'safety_alert_noop', alertId, reason: alert.delivery_status },
        'safety_alert_noop'
      );
      return { status: 'noop' };
    }

    try {
      // (0) Unified 4A queue (U4-SAFETY-COMPLETE): file the moderation_queue entry BEFORE
      // any delivery leg, so the entry exists — and survives — however delivery ends, dead
      // letter included (every non-terminal attempt refiles it, idempotent per open item,
      // RT-02). Inside this try on purpose: a filing failure marks the alert
      // retrying/failed below instead of leaving it silently 'pending'. Gated on the
      // published 4A contract: while the unified read model cannot serve 'safety_alert'
      // rows, filing one would 500 every unfiltered GET /api/moderation/queue page
      // containing it, so until 4A declares support the alert stays queued solely via
      // GET /api/moderation/alerts (which lists it either way — nothing is lost).
      if (safetyRepo.unifiedQueueSupported()) {
        const { item, created } = await safetyRepo.fileUnifiedQueueEntry(alertId);
        log.info(
          {
            event: 'safety_alert_unified_queue_entry',
            alertId,
            queueItemId: item ? item.id : null,
            created,
          },
          'safety_alert_unified_queue_entry'
        );
      } else {
        log.info(
          { event: 'safety_alert_unified_queue_unsupported', alertId },
          'safety_alert_unified_queue_unsupported'
        );
      }

      const moderatorsNotified = await notifyModerators({ alert, alertId, log });
      return await deliverToEmergencyContact({ alert, alertId, moderatorsNotified, log });
    } catch (err) {
      // Every failure — a refused leg above OR an unexpected fault (a transport validation
      // error, a database blip) — leaves the alert honestly marked before the throw reaches
      // the worker's retry/dead-letter machinery. It must never stay silently 'pending'.
      const code = (err && err.code) || null;
      if (code !== ALREADY_MARKED_TERMINAL) {
        await markDeliveryFailure({
          alertId,
          attempt: ctx.attempt,
          terminalReason: code || 'SAFETY_ALERT_DELIVERY_ERROR',
          log,
        });
      }
      throw err;
    }
  },
};
