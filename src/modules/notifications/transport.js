// src/modules/notifications/transport.js — U2-ADAPTERS-COMMS: the ONE notification send
// path (ADR-011). Public contract other units build on (build-plan §3):
//
//   await transport.send({ userId, channel, template, params, idempotencyKey,
//                          recipientEmail? }) → { status }
//
// `recipientEmail` is the optional FR-07 third-party delivery address (the raising user's
// approved emergency contact, who has no account here): when given it is what the adapter
// delivers to, while the attempt row still records the RAISING USER's ID as the recipient.
//
// The second argument carries the caller's job-scoped logger and, for flows that need it, a
// `resolveRenderContext()` callback: per-send SECRET material the adapter needs to compose
// the message (FR-10's single-use verification link) which — exactly like `recipientEmail` —
// goes straight to the adapter and never into a row, a payload or a log line.
//
// Behaviour:
//   * resolves the adapter by config: the deterministic mock in dev/test (asserted by the
//     suite), SendGrid only when NOTIFICATIONS_TRANSPORT=sendgrid, FCM only while
//     notifications.push.enabled=true — a push send while the gate is off (the DEFAULT) is
//     REFUSED and recorded, never delivered (ADR-011);
//   * EVERY send — mock or live — writes a §3.4 NOTIFICATION_ATTEMPT row (recipient user
//     ID, channel, status sent/failed/retrying) via ./repo; the whole automated suite
//     asserts on those rows, never on a third party's behaviour (ADR-011);
//   * a duplicate idempotencyKey reuses the existing row and does NOT send again;
//   * delivery runs under withResilience with config.adapters.timeoutMs (default 3000 ms),
//     bounded retries and exponential backoff; a provider failure resolves to
//     { status: 'failed' } — it never throws through the worker (NFR-09);
//   * rows and log lines carry user IDs only; the recipient address is resolved at send
//     time and handed straight to the adapter (§3.4 PII register, ADR-003).
//
// Requirement traceability (SRS Appendix B):
//   FR-13 (TC-13, RT-02) — booking notifications delivered through this contract by the
//                          outbox worker; one attempt row per delivery with bounded retries
//   FR-14 (TC-14)        — cancellation notices use the same path
//   FR-07 (TC-07, IT-04) — emergency-contact email delivery + retry audit trail
//   NFR-09 (RT-01)       — timeout/bounded-retry/backoff around every provider call; a
//                          provider outage yields a failed ROW, not an unhandled rejection
//   NFR-08 (MT-01)       — structured events (notification_sent/failed/deduped/push_refused)
//                          with recipient user ID + attempt ID; callers may pass a job-scoped
//                          child logger so the worker's correlationId propagates
//
// Worker-only (ADR-001/003): this module reaches src/adapters/* and therefore may only be
// imported by src/outbox/handlers/* and worker code — NEVER by a request handler. The
// adr-conformance lane and tests/unit/adapters-comms.test.js enforce that statically.
'use strict';

const { z } = require('zod');
const config = require('../../config');
const { logger } = require('../../lib/logger');
const { withResilience } = require('../../lib/resilience');
const { ValidationError } = require('../../lib/errors');
const repo = require('./repo');
const mock = require('../../adapters/mockTransport');
const sendgrid = require('../../adapters/sendgrid');
const fcm = require('../../adapters/fcm');

const CHANNELS = ['email', 'push'];

const sendInputSchema = z.object({
  userId: z.string().uuid(),
  channel: z.enum(CHANNELS),
  template: z.string().min(1).max(200),
  params: z.record(z.unknown()).optional().default({}),
  idempotencyKey: z.string().min(1).max(255).optional(),
  // FR-07 third-party channel: an explicitly supplied delivery address for a notification
  // that is NOT addressed to the user's own account — the raising user's approved
  // emergency contact (src/outbox/handlers/safetyAlert.js decrypts it at send time). When
  // absent, the address is resolved from the recipient user's account as usual. It is
  // handed straight to the adapter: it never reaches a NOTIFICATION_ATTEMPT row (which
  // carries recipient_user_id only) or a log line (§3.4 PII register, ADR-003).
  recipientEmail: z.string().trim().email().max(254).optional(),
});

// ---- params PII guard ------------------------------------------------------------------------
// notification_attempts.params holds template identifiers and entity IDs ONLY (§3.4 PII
// register, ADR-003 "payloads carry IDs only"). Reject contact-identity keys and any
// email-shaped value before anything is persisted.
const CONTACT_PII_KEYS = new Set([
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'mobile',
  'tel',
  'name',
  'firstname',
  'lastname',
  'fullname',
  'displayname',
  'legalname',
  'emergencycontact',
  'address',
  'streetaddress',
]);
const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function assertParamsCarryIdsOnly(params) {
  for (const [key, value] of Object.entries(params)) {
    const normalized = String(key)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (CONTACT_PII_KEYS.has(normalized)) {
      throw new ValidationError(
        `notification params must carry IDs only — key "${key}" is contact PII (§3.4 PII register, ADR-003)`,
        { details: { field: `params.${key}` } }
      );
    }
    if (typeof value === 'string' && EMAIL_SHAPED.test(value)) {
      throw new ValidationError(
        `notification params must carry IDs only — value of "${key}" looks like an email address (§3.4 PII register, ADR-003)`,
        { details: { field: `params.${key}` } }
      );
    }
  }
}

// ---- adapter resolution (ADR-011) ------------------------------------------------------------

/**
 * Resolve the delivery adapter for a channel from configuration. Exported for direct
 * assertion; `cfg` defaults to the live config and is injectable ONLY so tests can prove
 * the sendgrid/fcm selection rules without faking the process environment.
 *
 * @param {'email'|'push'} channel
 * @param {object} [cfg]  config.notifications shape
 * @returns {object|null} an adapter, or null when the channel is refused (push gate off)
 */
function resolveAdapter(channel, cfg = config.notifications) {
  if (channel === 'push' && !cfg.push.enabled) {
    // ADR-011: FCM stays gated behind notifications.push.enabled (DEFAULT FALSE) — the
    // refusal happens before any adapter (even the mock) is considered.
    return null;
  }
  if (cfg.transport === 'mock') {
    // Dev and the ENTIRE automated suite: deterministic mock, nothing leaves the process.
    return mock.adapter;
  }
  // Live mode (NOTIFICATIONS_TRANSPORT=sendgrid; config validation already required the
  // API key, and the adapter re-checks — SendGrid is live ONLY when configured).
  return channel === 'email' ? sendgrid.adapter : fcm.adapter;
}

// ---- send ------------------------------------------------------------------------------------

/**
 * Send one notification. See the module header for the full contract.
 *
 * @param {object} input   { userId, channel, template, params?, idempotencyKey?, recipientEmail? }
 * @param {object} [options]
 * @param {object} [options.log]  a job-scoped child logger (outbox worker passes its own so
 *                                the correlationId propagates into these lines — NFR-08)
 * @param {() => Promise<object>} [options.resolveRenderContext]  per-send SECRET render
 *   material the adapter needs to compose the message but that must never be persisted —
 *   today the FR-10 single-use verification link. It is a callback, not a value, because
 *   producing it has a side effect (minting a credential): it runs at most once per send,
 *   only after the dedupe and push-gate checks, and only for an adapter that declares
 *   `requiresRenderContext` — so a deduped redelivery and the whole ADR-011 mock path mint
 *   nothing at all.
 * @returns {Promise<{status: 'sent'|'failed', attemptId: string, deduped?: boolean, reason?: string}>}
 * @throws {ValidationError} malformed input or PII-bearing params (caller bug — the outbox
 *                           worker treats it like any handler error; provider failures
 *                           NEVER throw, they resolve to { status: 'failed' })
 */
async function send(input, { log, resolveRenderContext } = {}) {
  const parsed = sendInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new ValidationError('transport.send: invalid notification input', {
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  const { userId, channel, template, params, idempotencyKey } = parsed.data;
  const suppliedRecipientEmail = parsed.data.recipientEmail;
  assertParamsCarryIdsOnly(params);

  const baseLog = log ?? logger;
  const jobLog = baseLog.child({
    module: 'notifications',
    channel,
    template,
    recipientUserId: userId,
  });

  // 1. Record the attempt row FIRST (mock or live — every send leaves a row, ADR-011).
  //    A duplicate idempotencyKey reuses its row instead of inserting a second one.
  let created;
  let attempt;
  try {
    ({ attempt, created } = await repo.createAttempt({
      recipientUserId: userId,
      channel,
      template,
      params,
      idempotencyKey: idempotencyKey ?? null,
    }));
  } catch (err) {
    if (err && err.code === '23503') {
      // FK violation: the recipient user does not exist — caller bug, not provider outage.
      throw new ValidationError('transport.send: recipient user does not exist', {
        details: { field: 'userId' },
        cause: err,
      });
    }
    throw err;
  }

  // 2. Idempotency: an already-SENT key must not double-send (row-level guarantee).
  if (!created && attempt.status === 'sent') {
    jobLog.info(
      { event: 'notification_deduped', attemptId: attempt.id, idempotencyKeyPresent: true },
      'notification already sent for this idempotency key; not sending again'
    );
    return { status: 'sent', attemptId: attempt.id, deduped: true };
  }

  // 3. ADR-011 push gate: refused sends are recorded as failed rows, never delivered.
  const adapter = resolveAdapter(channel);
  if (adapter === null) {
    await repo.markFailed(
      attempt.id,
      'push channel refused: notifications.push.enabled=false (ADR-011 — email is the v1.0 channel)'
    );
    jobLog.warn(
      { event: 'notification_push_refused', attemptId: attempt.id },
      'push notification refused while notifications.push.enabled=false (ADR-011)'
    );
    return { status: 'failed', attemptId: attempt.id, reason: 'push_disabled' };
  }

  // 4. Resolve the recipient address AT SEND TIME for adapters that need one (live email).
  //    It goes straight to the adapter — never into a row or a log line (§3.4 PII register).
  //    A caller-supplied address wins: FR-07 delivers to the raising user's APPROVED
  //    EMERGENCY CONTACT, a third party who has no account here, while the attempt row still
  //    records the raising user's ID as the recipient.
  let recipientEmail = suppliedRecipientEmail;
  if (adapter.requiresRecipientEmail && !recipientEmail) {
    const recipient = await repo.getRecipientEmail(userId);
    if (!recipient || !recipient.email) {
      await repo.markFailed(attempt.id, 'recipient has no deliverable email address');
      jobLog.warn(
        { event: 'notification_failed', attemptId: attempt.id, reason: 'no_recipient_email' },
        'notification failed: recipient has no deliverable email address'
      );
      return { status: 'failed', attemptId: attempt.id, reason: 'no_recipient_email' };
    }
    recipientEmail = recipient.email;
  }

  // 4b. Resolve the per-send RENDER CONTEXT under exactly the same rule as the address above:
  //     secret, single-use material (FR-10's verification link) that the adapter needs to
  //     compose the message and that must NEVER reach a NOTIFICATION_ATTEMPT row, an outbox
  //     payload or a log line (§3.4 PII register, ADR-003 "payloads carry IDs only").
  //     Resolved ONCE here — outside the retry loop, after the dedupe/push-gate returns — so
  //     minting a credential happens only when a delivery is actually about to be attempted.
  let renderContext;
  if (adapter.requiresRenderContext && typeof resolveRenderContext === 'function') {
    renderContext = await resolveRenderContext();
  }

  // 5. Deliver under the NFR-09 resilience contract: per-attempt timeout from config,
  //    bounded retries, exponential backoff. Each try is persisted (recordTry) so the row
  //    reads 'retrying' between attempts and attempt_count matches reality.
  //
  //    Terminal-write ordering (MTUT-02): withResilience ABANDONS a try whose per-attempt
  //    budget expires — it rejects without awaiting fn — so a slow recordTry UPDATE can
  //    still be in flight when the loop exits. Every recordTry promise is therefore
  //    tracked (catch-wrapped: settlement only, the try itself still propagates errors)
  //    and awaited before markFailed/markSent below; otherwise the stale 'retrying' write
  //    could land AFTER the terminal status and leave the row 'retrying' forever, breaking
  //    the NFR-09/FR-07 audit trail ("a provider outage yields a failed ROW").
  let lastErrorMessage = null;
  const tryWrites = [];
  const settleTryWrites = () => Promise.all(tryWrites);
  try {
    await withResilience(
      async ({ attempt: tryNumber, signal }) => {
        const write = repo.recordTry(attempt.id, tryNumber > 1 ? lastErrorMessage : null);
        tryWrites.push(
          write.then(
            () => undefined,
            () => undefined
          )
        );
        await write;
        return adapter.deliver({
          userId,
          channel,
          template,
          params,
          idempotencyKey: idempotencyKey ?? null,
          recipientEmail,
          renderContext,
          attempt: tryNumber,
          signal,
        });
      },
      {
        name: `notification:${adapter.name}:${channel}`,
        timeoutMs: config.adapters.timeoutMs,
        retries: config.adapters.retryMax,
        backoff: { baseMs: config.adapters.backoffBaseMs },
        onRetry: ({ error }) => {
          lastErrorMessage = scrubErrorMessage(error);
        },
        log: jobLog,
      }
    );
  } catch (err) {
    // Provider outage / exhausted retries: a FAILED ROW, not a thrown error (NFR-09 —
    // the outbox worker must keep draining its batch). Any try abandoned by the timeout
    // must land its 'retrying' write BEFORE the terminal status goes down (MTUT-02).
    await settleTryWrites();
    const failed = await repo.markFailed(attempt.id, scrubErrorMessage(err));
    jobLog.warn(
      {
        event: 'notification_failed',
        attemptId: attempt.id,
        adapter: adapter.name,
        attempts: failed ? failed.attempt_count : undefined,
        code: err && err.code,
      },
      'notification delivery failed after bounded retries'
    );
    return { status: 'failed', attemptId: attempt.id };
  }

  // Same ordering guarantee on the success path: an earlier abandoned try must not be able
  // to overwrite 'sent' with a stale 'retrying' (MTUT-02).
  await settleTryWrites();
  const sent = await repo.markSent(attempt.id);
  jobLog.info(
    {
      event: 'notification_sent',
      attemptId: attempt.id,
      adapter: adapter.name,
      attempts: sent ? sent.attempt_count : undefined,
    },
    'notification delivered'
  );
  return { status: 'sent', attemptId: attempt.id };
}

/** PII-safe error text for last_error: message + code, email-shaped substrings scrubbed. */
function scrubErrorMessage(err) {
  const raw = err && err.message ? String(err.message) : 'unknown delivery error';
  const withCode = err && err.code ? `${err.code}: ${raw}` : raw;
  return withCode.replace(new RegExp(EMAIL_SHAPED, 'g'), '[REDACTED]');
}

module.exports = { send, resolveAdapter, CHANNELS };
