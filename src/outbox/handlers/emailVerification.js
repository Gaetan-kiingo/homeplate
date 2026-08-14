// src/outbox/handlers/emailVerification.js — U2-IDENTITY: worker-side delivery of the
// FR-10 verification email, discovered by src/outbox/dispatch.js.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 (TC-10) — completes the registration flow end-to-end: register → outbox row
//                   (type 'email.verification', IDs only) → worker → THIS handler →
//                   U2-ADAPTERS-COMMS transport → persisted NOTIFICATION_ATTEMPT row.
//   ADR-001/003   — this file is the ONLY place the verification email touches a
//                   transport/adapter: it runs exclusively under the outbox worker, never
//                   on a request path. A transport failure throws, so the worker's
//                   retry/backoff/dead-letter budget applies (NFR-09).
//   ADR-011       — the transport resolves to the mock in dev/test (recording the attempt
//                   row the suite asserts on) and to SendGrid email in live mode; both IDs
//                   only in rows and logs (SRS §3.4 PII register). The payload/params carry
//                   the token's SHA-256 DIGEST — the raw single-use token is never
//                   persisted anywhere (users/tokens.js), so neither an outbox row nor a
//                   notification row can leak a usable verification link.
//   NFR-08 (MT-01) — ctx.log is the worker's job-scoped child logger carrying the
//                   originating request's correlationId into these lines.
//
// Handler contract (build-plan §1 convention 3): { type, handle(payload, ctx) } with ctx
// = { jobId, type, attempt, correlationId, idempotencyKey, log } (src/outbox/dispatch.js).
'use strict';

const { logger } = require('../../lib/logger');
// Worker-only import (ADR-001/003): the transport reaches src/adapters/*.
const transport = require('../../modules/notifications/transport');

const TYPE = 'email.verification';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

module.exports = {
  type: TYPE,

  /**
   * Deliver one verification email through the transport contract (U2-ADAPTERS-COMMS).
   * @param {{userId: string, tokenHash: string}} payload  IDs only (ADR-003)
   * @param {{idempotencyKey?: string, log?: object}} [ctx]  worker job context
   * @returns {Promise<{status: 'sent', attemptId: string}>}
   * @throws on malformed payload (dead-letters after retries — a caller bug) and on a
   *   failed delivery (so the worker retries with backoff and eventually dead-letters,
   *   keeping the attempt visible — NFR-09)
   */
  async handle(payload, ctx = {}) {
    const log = ctx.log || logger;
    if (!payload || typeof payload !== 'object') {
      throw new TypeError(`${TYPE}: payload must be { userId, tokenHash }`);
    }
    const { userId, tokenHash } = payload;
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      throw new TypeError(`${TYPE}: payload.userId must be a UUID`);
    }
    if (typeof tokenHash !== 'string' || !SHA256_HEX_RE.test(tokenHash)) {
      throw new TypeError(`${TYPE}: payload.tokenHash must be a SHA-256 hex digest`);
    }

    // The enqueue-side dedupeKey doubles as the transport idempotency key, so a job
    // redelivered after a worker crash cannot double-send (RT-02 exactly-once).
    const idempotencyKey = ctx.idempotencyKey || `${TYPE}:${tokenHash}`;

    const result = await transport.send(
      {
        userId,
        channel: 'email',
        template: TYPE,
        params: { userId, tokenHash }, // IDs/digests only (§3.4 PII register, ADR-003)
        idempotencyKey,
      },
      { log }
    );

    if (result.status !== 'sent') {
      // Provider outage after the transport's own bounded retries: throw so the OUTBOX
      // retry/backoff/dead-letter budget takes over (NFR-09 — deferred, never dropped).
      throw new Error(
        `${TYPE}: delivery failed (attempt row ${result.attemptId}); outbox will retry`
      );
    }
    return { status: result.status, attemptId: result.attemptId };
  },
};
