// src/adapters/sendgrid.js — U2-ADAPTERS-COMMS: the SendGrid email adapter (ADR-011).
//
// Email via SendGrid is THE v1.0 notification channel (FR-13 booking notifications,
// FR-14 cancellation notices, FR-07 emergency-contact delivery). This adapter is selected
// by src/modules/notifications/transport.js only when NOTIFICATIONS_TRANSPORT=sendgrid
// (production); dev and the whole automated suite run the mock instead (ADR-011).
//
// Requirement traceability (SRS Appendix B):
//   FR-13, FR-14, FR-07 — live email delivery for the notification flows
//   NFR-09 (RT-01)      — every call is driven through withResilience by the transport
//                         (timeout config.adapters.timeoutMs, bounded retries, backoff);
//                         provider errors become UpstreamServiceError with the standard
//                         transient/permanent retryability split
//   NFR-08 (MT-01)      — thrown errors carry stable codes and NEVER the recipient address
//                         (SRS §3.4 PII register: logs and rows hold user IDs only)
//
// Secrets: the API key comes from config (SENDGRID_API_KEY via src/config/schema.js) and
// is never hardcoded — the unit test greps this tree for key material (ADR-011).
// Worker-only (ADR-001/003): request handlers must never import this module.
'use strict';

const config = require('../config');
const { InternalError, UpstreamServiceError } = require('../lib/errors');

// Lazily initialised so mock-mode processes (dev, CI, the whole test suite) never load or
// configure the SendGrid SDK at all.
let sgMail = null;

function client() {
  if (!config.notifications.sendgridApiKey) {
    // Configuration problem, not a provider outage — retrying cannot help (NFR-09).
    throw new InternalError(
      'SendGrid adapter: SENDGRID_API_KEY is not configured (ADR-011 — live email requires it)',
      { code: 'SENDGRID_NOT_CONFIGURED', retryable: false }
    );
  }
  if (!sgMail) {
    sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(config.notifications.sendgridApiKey);
  }
  return sgMail;
}

// Template registry — subjects for the v1.0 flows (FR-10 via U2-IDENTITY's handler,
// FR-13/FR-14 booking flows in wave 3, FR-07 safety alerts in wave 4). Unknown templates
// fall back to a neutral subject so a new flow cannot crash delivery.
const EMAIL_SUBJECTS = {
  'email-verification': 'Verify your Homeplate email address',
  'booking-created': 'Homeplate: a seat was reserved',
  'booking-confirmed': 'Homeplate: your booking is confirmed',
  'booking-status-changed': 'Homeplate: your booking status changed',
  'booking-cancelled': 'Homeplate: a booking was cancelled',
  'safety-alert-emergency': 'Homeplate safety alert',
  'safety-alert-moderator': 'Homeplate: a safety alert needs review',
  'inactivity-notice': 'Homeplate: your account is inactive',
};

/**
 * Renders the minimal v1.0 email body. `params` carry template identifiers and entity IDs
 * only — never names, emails or phone numbers (§3.4 PII register, ADR-003) — so the body is
 * safe to build mechanically; wave 3-4 flows layer richer copy on top of this contract.
 * @returns {{subject: string, text: string}}
 */
function renderEmail(template, params = {}) {
  const subject = EMAIL_SUBJECTS[template] ?? `Homeplate notification (${template})`;
  const lines = [
    'You have a new notification from Homeplate.',
    '',
    `Notification type: ${template}`,
  ];
  const entries = Object.entries(params);
  if (entries.length > 0) {
    lines.push('Reference:');
    for (const [key, value] of entries) {
      lines.push(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
  }
  lines.push('', 'Sign in to Homeplate to view the details.');
  return { subject, text: lines.join('\n') };
}

const adapter = {
  name: 'sendgrid',
  channels: ['email'],
  // The §3.4 NOTIFICATION_ATTEMPT row carries the user ID only; the transport resolves the
  // address at send time and hands it to us — it never touches a row or a log line.
  requiresRecipientEmail: true,

  /**
   * Sends one email through SendGrid. Called ONLY under withResilience by the transport.
   * @param {object} input { userId, recipientEmail, template, params }
   * @returns {Promise<{providerMessageId: string|null}>}
   * @throws {UpstreamServiceError} provider failure (retryability per upstream status)
   * @throws {InternalError} missing configuration (never retried)
   */
  async deliver({ recipientEmail, template, params }) {
    const sg = client();
    if (!recipientEmail) {
      throw new InternalError('SendGrid adapter: no recipient email resolved for delivery', {
        code: 'SENDGRID_NO_RECIPIENT',
        retryable: false,
      });
    }
    const { subject, text } = renderEmail(template, params);
    try {
      const [response] = await sg.send({
        to: recipientEmail,
        from: config.notifications.email.from,
        subject,
        text,
      });
      const messageId = (response && response.headers && response.headers['x-message-id']) || null;
      return { providerMessageId: messageId };
    } catch (err) {
      // @sendgrid/mail surfaces the HTTP status on err.code; the message deliberately
      // excludes the recipient address (PII register). UpstreamServiceError applies the
      // standard transient split: network/5xx/429/408 retry, other 4xx do not (NFR-09).
      const upstreamStatus =
        Number.isInteger(err && err.code) && err.code >= 100
          ? err.code
          : (err && err.response && err.response.statusCode) || null;
      throw new UpstreamServiceError('SendGrid send failed', { upstreamStatus, cause: err });
    }
  },
};

module.exports = { adapter, renderEmail, EMAIL_SUBJECTS };
