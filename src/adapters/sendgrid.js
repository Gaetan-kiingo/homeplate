// src/adapters/sendgrid.js — U2-ADAPTERS-COMMS: the SendGrid email adapter (ADR-011).
//
// Email via SendGrid is THE v1.0 notification channel (FR-13 booking notifications,
// FR-14 cancellation notices, FR-07 emergency-contact delivery). This adapter is selected
// by src/modules/notifications/transport.js only when NOTIFICATIONS_TRANSPORT=sendgrid
// (production); dev and the whole automated suite run the mock instead (ADR-011).
//
// Requirement traceability (SRS Appendix B):
//   FR-13, FR-14, FR-07 — live email delivery for the notification flows
//   FR-10               — the verification email carries the SINGLE-USE LINK the recipient
//                         acts on. The link arrives as the transport's per-send render
//                         context (never in `params`, which are persisted on the attempt
//                         row); a verification send without one is refused rather than
//                         delivered empty (finding TCB-W3-01)
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
//
// ADR-011 test guard (finding IT-F4): under NODE_ENV=test this adapter REFUSES to use the real
// @sendgrid/mail SDK (code LIVE_PROVIDER_REFUSED_IN_TEST) even when a key happens to be present
// in the environment, so no stray configuration or accidental direct call can put an outbound
// request on the wire from the suite. Tests exercise the live body by substituting the SDK with
// a `__fake: true` double (tests/it-adapters/it01c-adapter-depth.test.js loadIsolated).
'use strict';

const config = require('../config');
const { InternalError, UpstreamServiceError } = require('../lib/errors');

// Lazily initialised so mock-mode processes (dev, CI, the whole test suite) never load or
// configure the SendGrid SDK at all.
let sgMail = null;

/**
 * True only for a provider SDK the TEST HARNESS has explicitly substituted. The marker is the
 * one tests/it-adapters/it01c-adapter-depth.test.js already stamps on its jest module mocks
 * (`__fake: true`) before it exercises the live delivery body in an isolated registry; the real
 * `@sendgrid/mail` never carries it. Keeping the check on the double — rather than on "is an
 * SDK present" — is what makes the NODE_ENV=test guard below an invariant instead of a
 * convention (finding IT-F4).
 */
function isSubstitutedSdk(sdk) {
  return Boolean(sdk && sdk.__fake === true);
}

/**
 * ADR-011 reciprocal guard (finding IT-F4). src/adapters/llmModeration.js already resolves the
 * mock whenever the mode is not 'live', and src/config/schema.js refuses a mock transport under
 * NODE_ENV=production — but nothing stopped a stray SENDGRID_API_KEY in the environment plus a
 * direct `sendgrid.adapter.deliver(...)` call from putting an outbound HTTPS request on the wire
 * from inside the Jest suite (observed: 'UpstreamServiceError: SendGrid send failed … Cause:
 * Unauthorized'). ADR-011 says dev and the WHOLE test suite use a mock transport, so the adapter
 * itself now enforces it: under NODE_ENV=test the only acceptable SDK is a substituted double.
 * @returns {InternalError} permanent (retrying cannot help — NFR-09)
 */
function liveProviderRefusedInTest() {
  return new InternalError(
    'SendGrid adapter: refusing to reach the live provider while NODE_ENV=test — ADR-011 puts ' +
      'dev and the entire automated suite on the mock transport (NOTIFICATIONS_TRANSPORT=mock). ' +
      'Substitute @sendgrid/mail with a test double exposing __fake === true to exercise this path.',
    { code: 'LIVE_PROVIDER_REFUSED_IN_TEST', retryable: false }
  );
}

function client() {
  if (!config.notifications.sendgridApiKey) {
    // Configuration problem, not a provider outage — retrying cannot help (NFR-09).
    throw new InternalError(
      'SendGrid adapter: SENDGRID_API_KEY is not configured (ADR-011 — live email requires it)',
      { code: 'SENDGRID_NOT_CONFIGURED', retryable: false }
    );
  }
  if (!sgMail) {
    // Requiring the module is inert (no network happens until send()); the guard runs before
    // the key is ever handed to it, so a real SDK under NODE_ENV=test is refused unconfigured.
    const sdk = require('@sendgrid/mail');
    if (config.isTest && !isSubstitutedSdk(sdk)) throw liveProviderRefusedInTest();
    sdk.setApiKey(config.notifications.sendgridApiKey);
    sgMail = sdk;
  }
  return sgMail;
}

// ---- template registry (FR-13, FR-14, FR-10, FR-07 — ADR-011) --------------------------------
//
// TEMPLATE_IDS is the v1.0 template vocabulary AS ACTUALLY EMITTED ON THE WIRE — the exact
// strings that reach renderEmail() at runtime:
//
//   src/outbox/handlers/emailVerification.js    template: 'email.verification'  (its job type)
//   src/outbox/handlers/bookingNotifications.js template: `booking.${event}`, event ∈
//                                               src/modules/bookings/lifecycle.js EVENT_VALUES
//   src/outbox/handlers/safetyAlert.js          template: 'safety-alert-moderator' /
//                                               'safety-alert-emergency'
//
// Finding TCB-W3-04: this registry used to be keyed with a hand-written HYPHENATED vocabulary
// ('booking-created', 'booking-cancelled', …) that no handler ever emits. The two vocabularies
// were disjoint for the FR-13/FR-14 booking family, so every booking email shipped with the
// neutral fallback — a guest's confirmation arrived titled "Homeplate notification
// (booking.created)". The booking ids below are therefore DERIVED with the same
// `booking.<event>` rule the handler applies, over the same event list, and
// assertSubjectCoverage() below fails at REQUIRE TIME if any emitted id loses its subject, so a
// new flow cannot regress this silently.
const BOOKING_TEMPLATE_PREFIX = 'booking.';

/** The FR-13/FR-14 booking events (mirrors bookings/lifecycle.js EVENTS — build-plan §3). */
const BOOKING_EVENTS = Object.freeze([
  'created',
  'started', // pending → in_progress (FR-12 promotion), a FR-13 status transition
  'cancelled_by_guest',
  'cancelled_by_host',
  'listing_cancelled',
  'completed',
]);

/** The template id bookingNotifications.js emits for one lifecycle event (FR-13). */
function templateForBookingEvent(event) {
  return `${BOOKING_TEMPLATE_PREFIX}${event}`;
}

const TEMPLATE_IDS = Object.freeze({
  emailVerification: 'email.verification',
  bookingCreated: templateForBookingEvent('created'),
  bookingStarted: templateForBookingEvent('started'),
  bookingCancelledByGuest: templateForBookingEvent('cancelled_by_guest'),
  bookingCancelledByHost: templateForBookingEvent('cancelled_by_host'),
  bookingListingCancelled: templateForBookingEvent('listing_cancelled'),
  bookingCompleted: templateForBookingEvent('completed'),
  safetyAlertEmergency: 'safety-alert-emergency',
  safetyAlertModerator: 'safety-alert-moderator',
});

// Subjects for every emitted id, plus the legacy hyphenated spellings kept as first-class
// entries so any caller still using them (and the wave-2 suite, which drives the transport with
// 'booking-created' & co.) also renders a real subject instead of the fallback. Unknown
// templates still fall back to a neutral subject so a new flow cannot crash delivery.
const EMAIL_SUBJECTS = Object.freeze({
  // — ids emitted by the v1.0 outbox handlers (TEMPLATE_IDS) —
  [TEMPLATE_IDS.emailVerification]: 'Verify your Homeplate email address',
  [TEMPLATE_IDS.bookingCreated]: 'Homeplate: a seat was reserved',
  [TEMPLATE_IDS.bookingStarted]: 'Homeplate: your booking has started',
  [TEMPLATE_IDS.bookingCancelledByGuest]: 'Homeplate: a booking was cancelled by the guest',
  [TEMPLATE_IDS.bookingCancelledByHost]: 'Homeplate: a booking was cancelled by the host',
  [TEMPLATE_IDS.bookingListingCancelled]: 'Homeplate: a meal you booked was cancelled',
  [TEMPLATE_IDS.bookingCompleted]: 'Homeplate: your Homeplate meal is complete',
  [TEMPLATE_IDS.safetyAlertEmergency]: 'Homeplate safety alert',
  [TEMPLATE_IDS.safetyAlertModerator]: 'Homeplate: a safety alert needs review',
  // — legacy hyphenated spellings (no emitter; retained so older callers keep a real subject) —
  'email-verification': 'Verify your Homeplate email address',
  'booking-created': 'Homeplate: a seat was reserved',
  'booking-confirmed': 'Homeplate: your booking is confirmed',
  'booking-status-changed': 'Homeplate: your booking status changed',
  'booking-cancelled': 'Homeplate: a booking was cancelled',
  'inactivity-notice': 'Homeplate: your account is inactive',
});

/** True when `template` has a registered subject (i.e. will NOT render the neutral fallback). */
function hasSubject(template) {
  return Object.prototype.hasOwnProperty.call(EMAIL_SUBJECTS, template);
}

// TCB-W3-04 regression guard, enforced at require time in EVERY environment (dev, CI and
// production all load this module): an emitted template id without a subject is a build fault,
// not a runtime surprise a recipient discovers in their inbox.
(function assertSubjectCoverage() {
  const emitted = [...Object.values(TEMPLATE_IDS), ...BOOKING_EVENTS.map(templateForBookingEvent)];
  const missing = [...new Set(emitted)].filter((id) => !hasSubject(id));
  if (missing.length > 0) {
    throw new InternalError(
      `SendGrid adapter: template ids emitted by the v1.0 flows have no registered subject: ` +
        `${missing.join(', ')} — add them to EMAIL_SUBJECTS (ADR-011, finding TCB-W3-04)`,
      { code: 'EMAIL_SUBJECT_REGISTRY_INCOMPLETE', retryable: false }
    );
  }
})();

// FR-10 — the verification email is the one v1.0 message whose body must carry an ACTIONABLE
// secret (the single-use link), not just reference IDs. Both the emitted dotted job-type
// spelling and the legacy hyphenated one name that template, so the fail-loud check in
// deliver() below recognises either.
const VERIFICATION_TEMPLATE_IDS = Object.freeze([
  TEMPLATE_IDS.emailVerification,
  'email-verification',
]);

/** True for the FR-10 verification template under either spelling. */
function isVerificationTemplate(template) {
  return VERIFICATION_TEMPLATE_IDS.includes(template);
}

/** Subject for a template id; unknown ids get a neutral, never-crashing fallback. */
function subjectFor(template) {
  if (hasSubject(template)) return EMAIL_SUBJECTS[template];
  return `Homeplate notification (${template})`;
}

/**
 * Renders the minimal v1.0 email body. `params` carry template identifiers and entity IDs
 * only — never names, emails or phone numbers (§3.4 PII register, ADR-003) — so the body is
 * safe to build mechanically; wave 3-4 flows layer richer copy on top of this contract.
 *
 * `renderContext` is the per-send, NEVER-persisted material the transport resolves at send
 * time (src/modules/notifications/transport.js): today only `verificationUrl`, FR-10's
 * single-use link. It is deliberately not part of `params` — params are persisted on the
 * NOTIFICATION_ATTEMPT row, and a stored link would be a stored credential.
 *
 * @param {string} template
 * @param {object} [params]         persisted reference IDs
 * @param {{verificationUrl?: string, expiresAt?: string}} [renderContext]
 * @returns {{subject: string, text: string}}
 */
function renderEmail(template, params = {}, renderContext = {}) {
  const subject = subjectFor(template);
  const lines = [
    'You have a new notification from Homeplate.',
    '',
    `Notification type: ${template}`,
  ];
  const verificationUrl = renderContext && renderContext.verificationUrl;
  if (verificationUrl) {
    // FR-10: what the recipient actually acts on. The token in this URL is the ONLY value
    // that can flip email_verified — the digest carried by params never could.
    lines.push('', 'Confirm this email address to finish setting up your account:', '');
    lines.push(verificationUrl);
    lines.push('', 'The link can be used once.');
    if (renderContext.expiresAt) lines.push(`It expires at ${renderContext.expiresAt}.`);
  }
  const entries = Object.entries(params);
  if (entries.length > 0) {
    lines.push('', 'Reference:');
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
  // FR-10: this adapter composes real message bodies, so it is the one that needs the
  // transport's per-send render context (the single-use verification link). The ADR-011 mock
  // records rows instead of composing text and deliberately does NOT set this, so dev/test
  // never mint a credential.
  requiresRenderContext: true,

  /**
   * Sends one email through SendGrid. Called ONLY under withResilience by the transport.
   * @param {object} input { userId, recipientEmail, template, params, renderContext }
   * @returns {Promise<{providerMessageId: string|null}>}
   * @throws {UpstreamServiceError} provider failure (retryability per upstream status)
   * @throws {InternalError} missing configuration or a verification email with no link
   *   (never retried inside the resilience loop — the outbox still redelivers the job)
   */
  async deliver({ recipientEmail, template, params, renderContext }) {
    // FR-10 fail-loud: a verification email with no single-use link is worse than none —
    // the recipient would have nothing to act on and email_verified could never become
    // true (finding TCB-W3-01). Refuse before the provider is even contacted.
    if (isVerificationTemplate(template) && !(renderContext && renderContext.verificationUrl)) {
      throw new InternalError(
        'SendGrid adapter: refusing to send a verification email with no single-use link ' +
          '(FR-10 — the caller must supply resolveRenderContext)',
        { code: 'SENDGRID_NO_VERIFICATION_LINK', retryable: false }
      );
    }
    const sg = client();
    if (!recipientEmail) {
      throw new InternalError('SendGrid adapter: no recipient email resolved for delivery', {
        code: 'SENDGRID_NO_RECIPIENT',
        retryable: false,
      });
    }
    const { subject, text } = renderEmail(template, params, renderContext);
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

module.exports = {
  adapter,
  renderEmail,
  isVerificationTemplate,
  subjectFor,
  hasSubject,
  templateForBookingEvent,
  EMAIL_SUBJECTS,
  TEMPLATE_IDS,
  BOOKING_EVENTS,
  VERIFICATION_TEMPLATE_IDS,
};
