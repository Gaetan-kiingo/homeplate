// src/adapters/fcm.js — U2-ADAPTERS-COMMS: the Firebase Cloud Messaging push adapter.
//
// ADR-011: FCM is IMPLEMENTED but GATED behind notifications.push.enabled, which defaults
// to FALSE — email via SendGrid is the v1.0 channel. Every entry point of this adapter
// re-checks the gate (defence in depth on top of the transport's own refusal), so even a
// direct caller cannot push while the flag is off.
//
// Requirement traceability (SRS Appendix B):
//   FR-13, FR-14, FR-07 — the future push channel for the notification flows (v2.0 enable)
//   NFR-09 (RT-01)      — calls run under withResilience via the transport; provider errors
//                         map to UpstreamServiceError with an explicit transient/permanent
//                         split so retries stay bounded
//   NFR-08 (MT-01)      — stable error codes (PUSH_DISABLED, FCM_NOT_CONFIGURED); messages
//                         carry no PII
//
// Recipient addressing carries the user ID only (§3.4 PII register / ADR-003): messages go
// to the per-user topic `user-<uuid>` — no device-token table exists in v1.0, clients
// subscribe to their own topic when push ships. Secrets come from config
// (FCM_SERVICE_ACCOUNT_JSON via src/config/schema.js); nothing is hardcoded.
// Worker-only (ADR-001/003): request handlers must never import this module.
'use strict';

const config = require('../config');
const { AppError, InternalError, UpstreamServiceError } = require('../lib/errors');

function pushDisabledError() {
  return new AppError(
    'Push notifications are disabled (notifications.push.enabled=false — ADR-011 gates FCM off in v1.0)',
    { status: 403, code: 'PUSH_DISABLED', retryable: false }
  );
}

// firebase-admin error codes that indicate a transient provider condition (retry) versus
// everything else (a malformed message or auth problem never fixes itself by retrying).
const TRANSIENT_FCM_CODES = new Set([
  'messaging/server-unavailable',
  'messaging/internal-error',
  'messaging/quota-exceeded',
  'app/network-error',
]);

// Lazily initialised so the (heavy) firebase-admin SDK is never loaded while the gate is
// closed — which is every dev/test process and every v1.0 production process.
let fcmApp = null;

function messaging() {
  if (!config.notifications.push.enabled) {
    throw pushDisabledError();
  }
  if (!config.notifications.fcmServiceAccountJson) {
    throw new InternalError(
      'FCM adapter: FCM_SERVICE_ACCOUNT_JSON is not configured (required when push is enabled)',
      { code: 'FCM_NOT_CONFIGURED', retryable: false }
    );
  }
  const admin = require('firebase-admin');
  if (!fcmApp) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(config.notifications.fcmServiceAccountJson);
    } catch (err) {
      throw new InternalError('FCM adapter: FCM_SERVICE_ACCOUNT_JSON is not valid JSON', {
        code: 'FCM_NOT_CONFIGURED',
        retryable: false,
        cause: err,
      });
    }
    fcmApp = admin.initializeApp(
      { credential: admin.credential.cert(serviceAccount) },
      'homeplate-fcm'
    );
  }
  return admin.messaging(fcmApp);
}

const adapter = {
  name: 'fcm',
  channels: ['push'],
  requiresRecipientEmail: false,

  /**
   * Sends one push message to the recipient's per-user topic. Called ONLY under
   * withResilience by the transport, and ONLY while notifications.push.enabled=true.
   * @param {object} input { userId, template, params }
   * @returns {Promise<{providerMessageId: string}>}
   * @throws {AppError} PUSH_DISABLED while the ADR-011 gate is off (never retried)
   * @throws {UpstreamServiceError} provider failure (retryability per FCM error code)
   */
  async deliver({ userId, template, params }) {
    const fcm = messaging();
    try {
      const providerMessageId = await fcm.send({
        topic: `user-${userId}`,
        data: {
          template,
          // IDs only, stringified for FCM's string-map data payload (ADR-003).
          params: JSON.stringify(params ?? {}),
        },
      });
      return { providerMessageId };
    } catch (err) {
      const fcmCode = (err && (err.code || (err.errorInfo && err.errorInfo.code))) || null;
      const transient = fcmCode === null || TRANSIENT_FCM_CODES.has(fcmCode);
      // upstreamStatus drives UpstreamServiceError's retryable split: 503 → retry,
      // 400 → permanent (NFR-09 bounded retries).
      throw new UpstreamServiceError(`FCM send failed (${fcmCode ?? 'unknown error'})`, {
        upstreamStatus: transient ? 503 : 400,
        cause: err,
      });
    }
  },
};

module.exports = { adapter, pushDisabledError };
