// client/src/features/booking/components/bookingErrors.js — U6-BOOKING: the typed-error
// rendering contract for the booking screens (SPMP WA-9). Every ApiError code the booking
// flows can receive maps to a real human sentence here — a stringified body is a defect.
//
// Requirement traceability (SRS Appendix B):
//   FR-09 — ELIGIBILITY_FIXES / describeEligibilityReasons: each NOT_ELIGIBLE reason code
//     (src/modules/eligibility/policy.js REASONS) is rendered as WHAT is missing plus HOW to
//     fix it, with a link (or resend action) to the fix. This is the product's flagship
//     error surface (UT-01 probes it).
//   FR-11 (ADR-009) — mehkoCapMessage names WHICH MEHKO cap refused the host and WHEN it
//     resets, reading the cap value, the calendar day and the week window EXCLUSIVELY from
//     the server's error `details` payload. No cap value appears as a literal in this file —
//     deliberately, so client copy can never contradict the configured caps.
//   FR-12 — distinct copy for NO_CAPACITY (the atomic-decrement race loser) and for the
//     per-guest pending-booking cap, whose code on this tree is BOOKING_LIMIT
//     (src/modules/bookings/service.js, details.limit from config — never guessed here).
//   FR-14 / FR-04 — cancel/completion refusal codes (CANCEL_TOO_LATE,
//     BOOKING_NOT_CANCELLABLE, BOOKING_NOT_IN_PROGRESS) rendered as real sentences.
//   NFR-07 — the screens announce every one of these messages via the kit's aria-live
//     channel (useAnnounce); NFR-09 — NETWORK_ERROR/UNEXPECTED_RESPONSE fall through to the
//     ApiError's own user-presentable transport message.
import { formatCalendarDate, statusLabel } from './formatters.js';

/** Cross-feature fix destinations — URL strings only (wave-6 parallel-work rule). */
export const ACCOUNT_PATH = '/account';
export const LOGIN_PATH = '/login';

/**
 * FR-09: per-reason-code fix copy. `resend: true` marks the reason whose fix is an action
 * (resend the verification email) rather than a page; the account link is still offered.
 */
export const ELIGIBILITY_FIXES = Object.freeze({
  EMAIL_UNVERIFIED: Object.freeze({
    what: 'Your email address has not been verified.',
    how: 'Resend the verification email, follow the link in it, then try again.',
    resend: true,
    fixPath: ACCOUNT_PATH,
    fixLabel: 'Manage your email on your account page',
  }),
  NAME_MISSING: Object.freeze({
    what: 'Your profile does not have your full name yet.',
    how: 'Add your full name on your account page, then try again.',
    fixPath: ACCOUNT_PATH,
    fixLabel: 'Add your full name',
  }),
  PHONE_MISSING: Object.freeze({
    what: 'Your profile does not have a phone number yet.',
    how: 'Add a phone number on your account page so you can be reached about a booking.',
    fixPath: ACCOUNT_PATH,
    fixLabel: 'Add a phone number',
  }),
  HOST_PROFILE_INCOMPLETE: Object.freeze({
    what: 'Your host profile is incomplete.',
    how: 'Complete your host profile on your account page.',
    fixPath: ACCOUNT_PATH,
    fixLabel: 'Complete your host profile',
  }),
  HOST_AGREEMENT_MISSING: Object.freeze({
    what: 'You have not accepted the host agreement yet.',
    how: 'Read and accept the host agreement on your account page.',
    fixPath: ACCOUNT_PATH,
    fixLabel: 'Review the host agreement',
  }),
  USER_NOT_FOUND: Object.freeze({
    what: 'Your signed-in account could not be found.',
    how: 'Sign in again to continue.',
    fixPath: LOGIN_PATH,
    fixLabel: 'Sign in again',
  }),
});

/**
 * FR-09: map the server's NOT_ELIGIBLE reason codes (error.details.reasons) to renderable
 * items. Unknown codes still render honestly (the code plus a generic account link) rather
 * than disappearing — a silent drop would hide WHY the server refused.
 * @param {string[]} reasons
 * @returns {Array<{code: string, what: string, how: string, fixPath: string,
 *                  fixLabel: string, resend?: boolean}>}
 */
export function describeEligibilityReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  return list.map((code) => {
    const fix = ELIGIBILITY_FIXES[code];
    if (fix) return { code, ...fix };
    return {
      code,
      what: `Your account does not meet a requirement yet (${code}).`,
      how: 'Review your account details, then try again.',
      fixPath: ACCOUNT_PATH,
      fixLabel: 'Go to your account page',
    };
  });
}

/**
 * FR-11 / ADR-009: one sentence per MEHKO cap code naming WHICH cap refused the request and
 * WHEN it resets — every number and date read from the server's `details` payload, never
 * from a client-side constant. Returns null for non-MEHKO codes.
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
        `Daily listing cap reached: MEHKO allows ${limit} listing(s) per host per calendar day, ` +
        `and ${formatCalendarDate(details.localDate)} (America/Los_Angeles) already has a ` +
        'listing of yours. This cap resets at the start of the next calendar day, ' +
        'America/Los_Angeles time.'
      );
    case 'MEHKO_DAILY_MEAL_LIMIT':
      return (
        `Daily meal cap: this seat capacity would exceed the MEHKO limit of ${limit} meals on ` +
        `${formatCalendarDate(details.localDate)} (America/Los_Angeles)` +
        (already === undefined ? '' : ` — ${already} meal(s) are already scheduled that day`) +
        '. The daily count resets at the start of the next calendar day, America/Los_Angeles ' +
        'time.'
      );
    case 'MEHKO_WEEKLY_MEAL_LIMIT':
      return (
        `Weekly meal cap: this seat capacity would exceed the MEHKO limit of ${limit} meals ` +
        `for the week of ${formatCalendarDate(details.weekStart)} to ` +
        `${formatCalendarDate(details.weekEnd)} (Monday to Sunday, America/Los_Angeles)` +
        (already === undefined ? '' : ` — ${already} meal(s) are already scheduled that week`) +
        `. The weekly count resets on the Monday after ${formatCalendarDate(details.weekEnd)}, ` +
        'America/Los_Angeles time.'
      );
    default:
      return null;
  }
}

/**
 * One human message per typed booking-surface error code (FR-12/FR-14/FR-04; NFR-07). The
 * fallback is the ApiError's own message, which the API client guarantees is a
 * user-presentable sentence (typed envelope message or a transport message — never a
 * stringified body).
 * @param {{code?: string, message?: string, details?: object}} error
 * @returns {string}
 */
export function bookingErrorMessage(error) {
  const code = error && error.code;
  const details = (error && error.details) || {};
  switch (code) {
    case 'NO_CAPACITY':
      return (
        'No seats are left on this listing — another guest took the last seat. ' +
        'Try another listing, or check back in case a seat frees up.'
      );
    case 'BOOKING_LIMIT':
      return details.limit === undefined
        ? 'You have reached the limit of pending bookings. Complete or cancel a pending ' +
            'booking, then reserve this seat.'
        : `You already have ${details.limit} pending bookings — that is the per-guest limit. ` +
            'Complete or cancel a pending booking, then reserve this seat.';
    case 'OWN_LISTING':
      return 'This is your own listing — hosts cannot reserve a seat at their own table.';
    case 'LISTING_STARTED':
      return 'This meal has already started, so seats can no longer be reserved.';
    case 'LISTING_NOT_BOOKABLE':
      return 'This listing was cancelled by its host and can no longer be booked.';
    case 'LISTING_NOT_FOUND':
      return 'This listing could not be found. It may have been removed, or it is not public.';
    case 'CANCEL_TOO_LATE':
      return 'The meal has already started — this booking can no longer be cancelled.';
    case 'BOOKING_NOT_CANCELLABLE':
      return details.status
        ? `This booking is “${statusLabel(details.status)}” and can no longer be cancelled.`
        : 'This booking can no longer be cancelled.';
    case 'BOOKING_NOT_IN_PROGRESS':
      return 'Completion can only be confirmed while the meal is in progress.';
    case 'BOOKING_NOT_FOUND':
      return 'This booking could not be found.';
    case 'NOT_PARTICIPANT':
      return 'Only the guest or the host of this booking can view or change it.';
    case 'VALIDATION_FAILED':
      return 'The request was not valid — review the details and try again.';
    case 'NO_SESSION': // requireSession's live 401 code (src/modules/auth/middleware.js)
    case 'AUTHENTICATION_REQUIRED': // the eligibility middleware's bare 401 default
      return 'Your session has ended. Sign in again to continue.';
    case 'RATE_LIMITED':
      return details.retryAfterSeconds === undefined
        ? 'Too many attempts — wait a moment and try again.'
        : `Too many attempts — wait ${details.retryAfterSeconds} seconds and try again.`;
    case 'MEHKO_DAILY_LISTING_LIMIT':
    case 'MEHKO_DAILY_MEAL_LIMIT':
    case 'MEHKO_WEEKLY_MEAL_LIMIT':
      return mehkoCapMessage(error);
    default:
      return (error && error.message) || 'Something went wrong — please try again.';
  }
}
