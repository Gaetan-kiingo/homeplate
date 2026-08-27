// client/src/features/discovery/components/format.js — presentation formatting shared by the
// U6-DISCOVERY screens (FR-01 search, FR-02 listing detail, FR-03 host profile; NFR-07 text
// alternatives are built from these strings).
//
// Dates render in America/Los_Angeles: Homeplate v1.0 operates in the California MEHKO
// market and the backend's meal calendar is defined in that zone (ADR-009), so screens show
// the meal's own local wall-clock time — deterministically, on any viewer's machine. This is
// PRESENTATION only: no cap, boundary or eligibility logic exists client-side (ADR-009's one
// enforcement point stays server-side), and no numeric cap literal appears here.
//
// ADR-010: areaText() renders ONLY the coarse public fields (areaLabel/city/region). Exact
// address rendering lives in ListingDetailPage and happens ONLY when the payload itself
// carries the privileged fields.

const MEAL_TIME_ZONE = 'America/Los_Angeles';

const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: MEAL_TIME_ZONE,
});

const dateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeZone: MEAL_TIME_ZONE,
});

const monthYearFormat = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: MEAL_TIME_ZONE,
});

/** Parse an ISO string (or Date) defensively; null for absent/invalid input. */
function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Sep 3, 2026, 6:30 PM" (meal-local wall clock) or a safe fallback. */
export function formatDateTime(value) {
  const date = parseDate(value);
  return date ? dateTimeFormat.format(date) : 'Date to be announced';
}

/** "Sep 3, 2026" or ''. */
export function formatDate(value) {
  const date = parseDate(value);
  return date ? dateFormat.format(date) : '';
}

/** "March 2026" or ''. */
export function formatMonthYear(value) {
  const date = parseDate(value);
  return date ? monthYearFormat.format(date) : '';
}

/**
 * ISO instant → the value a <input type="datetime-local"> shows (viewer-local wall clock,
 * minute precision). Inverse of `new Date(inputValue).toISOString()` at submit time, which
 * is what gives src/schemas/search.js the timezone-carrying ISO datetime it requires.
 */
export function isoToLocalInput(iso) {
  const date = parseDate(iso);
  if (!date) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * ADR-010 coarse location line: areaLabel + city/region, deduplicated, never an address.
 * Returns null when the payload carries no area context at all.
 */
export function areaText(listing) {
  const parts = [];
  for (const part of [listing.areaLabel, listing.city, listing.region]) {
    if (part && !parts.includes(part)) parts.push(part);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** FR-02 seat availability as a sentence ("4 of 6 seats remaining"). */
export function seatsText(listing) {
  const remaining = Number(listing.seatsRemaining);
  const capacity = Number(listing.seatCapacity);
  if (!Number.isFinite(remaining) || !Number.isFinite(capacity)) {
    return 'Seat availability unknown';
  }
  if (remaining <= 0) return 'No seats remaining';
  return `${remaining} of ${capacity} ${capacity === 1 ? 'seat' : 'seats'} remaining`;
}

/** FR-03/FR-05 rating aggregate as a sentence; honest when there are no reviews yet. */
export function ratingText(averageRating, reviewCount) {
  const count = Number(reviewCount);
  if (!Number.isFinite(count) || count <= 0) return 'No reviews yet';
  const reviews = `${count} ${count === 1 ? 'review' : 'reviews'}`;
  const average = Number(averageRating);
  if (!Number.isFinite(average)) return reviews;
  return `Rated ${average} out of 5 from ${reviews}`;
}
