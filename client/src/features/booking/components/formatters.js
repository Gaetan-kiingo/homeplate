// client/src/features/booking/components/formatters.js — U6-BOOKING: display formatting
// shared by the booking screens (SPMP WA-9).
//
// Requirement traceability (SRS Appendix B):
//   FR-04 / FR-12 / FR-14 — booking lifecycle states and the listing's scheduled instant are
//     rendered as readable text (NFR-07: state is conveyed as text, never by colour alone).
//   FR-11 (ADR-009) — formatCalendarDate renders the API's 'YYYY-MM-DD' America/Los_Angeles
//     MEHKO calendar days exactly as the server named them: the string is formatted at UTC
//     midnight of that literal day, never re-projected through the viewer's timezone, so the
//     day named on screen can never drift off the day the server enforced.

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short' });
const CALENDAR = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ISO instant → e.g. "Friday, September 4, 2026 at 6:15 PM" (viewer-local meal time). */
export function formatWhen(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? WHEN.format(t) : String(iso);
}

/**
 * 'YYYY-MM-DD' (an America/Los_Angeles MEHKO calendar day from an ADR-009 cap payload) →
 * "September 4, 2026", with no timezone re-projection (see module header).
 */
export function formatCalendarDate(value) {
  const match = CALENDAR_DAY.exec(String(value));
  if (!match) return String(value);
  const [, year, month, day] = match;
  return CALENDAR.format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
}

/** Booking lifecycle states (src/modules/bookings) → human labels. */
export const STATUS_LABELS = Object.freeze({
  pending: 'Reserved — upcoming',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
});

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status);
}
