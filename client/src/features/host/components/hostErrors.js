// client/src/features/host/components/hostErrors.js — typed-error copy for the host listing
// screens (FR-11 / FR-09 / ADR-009; NFR-07: every failure is a human sentence, never a
// stringified body).
//
// The MEHKO wording mirrors the guest-side renderer in features/booking (bookingErrors.js):
// same facts, same calendar-day/week framing, but addressed to the HOST who is about to
// exceed a cap. Both read the numbers from the server payload — no cap literal lives in the
// client (ADR-009 single enforcement point; the adr-conformance lane scans for literals).

/** Where the eligibility fix path lives (features/account, addressed by URL only). */
export const ACCOUNT_PATH = '/account';

/** One short line per FR-09 reason code the publish gate can return. */
export const PUBLISH_REASONS = Object.freeze({
  EMAIL_UNVERIFIED: 'Verify your email address.',
  NAME_MISSING: 'Add your full name to your profile.',
  PHONE_MISSING: 'Add a phone number to your profile.',
  HOST_PROFILE_INCOMPLETE: 'Complete your host profile (a host bio).',
  HOST_AGREEMENT_MISSING: 'Accept the host agreement on your account page.',
});

function calendarDate(value) {
  if (typeof value !== 'string' || value === '') return 'that day';
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The host-facing sentence for a MEHKO cap refusal, or null for any other error.
 * @param {{code?: string, details?: object}} error
 * @returns {?string}
 */
export function mehkoCapMessage(error) {
  const details = (error && error.details) || {};
  const limit = details.limit;
  const already = details.alreadyScheduled;
  switch (error && error.code) {
    case 'MEHKO_DAILY_LISTING_LIMIT':
      return (
        `You already have a listing on ${calendarDate(details.localDate)} (America/Los_Angeles). ` +
        `MEHKO allows ${limit} listing(s) per host per calendar day — pick another day.`
      );
    case 'MEHKO_DAILY_MEAL_LIMIT':
      return (
        `This seat capacity would exceed the MEHKO limit of ${limit} meals on ` +
        `${calendarDate(details.localDate)} (America/Los_Angeles)` +
        (already === undefined ? '' : ` — ${already} seat(s) are already scheduled that day`) +
        '. Reduce the seats or pick another day.'
      );
    case 'MEHKO_WEEKLY_MEAL_LIMIT':
      return (
        `This seat capacity would exceed the MEHKO limit of ${limit} meals for the week of ` +
        `${calendarDate(details.weekStart)} to ${calendarDate(details.weekEnd)} ` +
        '(Monday to Sunday, America/Los_Angeles)' +
        (already === undefined ? '' : ` — ${already} seat(s) are already scheduled that week`) +
        '. Reduce the seats or pick another week.'
      );
    default:
      return null;
  }
}

/**
 * Translate the server's 422 VALIDATION_FAILED issue list into ErrorSummary entries for the
 * fields this form owns. `fieldIds` maps the API body key to the control id. Issues on keys
 * the form does not render are folded into one general message so nothing is swallowed.
 * @param {{details?: {fields?: Array<{path: string, message: string}>}}} error
 * @param {Record<string, string>} fieldIds
 * @returns {{fieldErrors: Array<{fieldId: string, message: string}>, general: ?string}}
 */
export function validationIssues(error, fieldIds) {
  const fields = (error && error.details && error.details.fields) || [];
  const fieldErrors = [];
  const unmapped = [];
  for (const issue of fields) {
    // "body.seatCapacity" → "seatCapacity"; nested paths keep their last segment.
    const segments = String(issue.path || '').split('.');
    const key = segments[segments.length - 1];
    const fieldId = fieldIds[key];
    if (fieldId) fieldErrors.push({ fieldId, message: issue.message });
    else unmapped.push(`${key}: ${issue.message}`);
  }
  return {
    fieldErrors,
    general: unmapped.length > 0 ? `The server rejected: ${unmapped.join('; ')}.` : null,
  };
}

/**
 * The general message for a failed create/update, given the typed error. NOT_ELIGIBLE and
 * VALIDATION_FAILED are rendered structurally by the page; this covers the rest.
 * @param {{code?: string, message?: string, details?: object}} error
 * @returns {string}
 */
export function hostErrorMessage(error) {
  const cap = mehkoCapMessage(error);
  if (cap) return cap;
  switch (error && error.code) {
    case 'AUTHENTICATION_REQUIRED':
    case 'NO_SESSION':
      return 'Your session has ended. Sign in again to continue.';
    case 'FORBIDDEN':
    case 'NOT_OWNER':
      return 'Only the host who created this meal can change it.';
    case 'NOT_FOUND':
      return 'This meal no longer exists.';
    case 'LISTING_CANCELLED':
      return 'This meal has been cancelled and can no longer be edited.';
    case 'SEAT_CAPACITY_BELOW_BOOKED':
      return (
        'Seat capacity cannot go below the seats already reserved' +
        (error.details && error.details.activeBookings !== undefined
          ? ` (${error.details.activeBookings} active booking(s))`
          : '') +
        '.'
      );
    case 'MEDIA_UPLOAD_FAILED':
      return 'A photo could not be uploaded. The meal was created without it — you can add photos later.';
    case 'NETWORK_ERROR':
      return 'The request could not reach Homeplate. Check your connection and try again.';
    default:
      return (error && error.message) || 'Something went wrong. Please try again.';
  }
}
