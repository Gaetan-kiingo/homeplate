// client/src/features/host/components/mealTime.js — the meal's wall-clock time is entered and
// shown in America/Los_Angeles (SRS §2.1.7: the v1.0 deployment is configured for California;
// ADR-009 computes day/week caps in that zone). The host's browser may be anywhere, so the
// <input type="datetime-local"> value is interpreted as an LA wall-clock time and converted
// to the timezone-explicit ISO instant the API requires (src/schemas/listings.js
// scheduledStart), never as the browser's local time.

export const MEAL_TIME_ZONE = 'America/Los_Angeles';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: MEAL_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function zoneParts(instant) {
  const out = {};
  for (const part of PARTS.formatToParts(instant)) out[part.type] = part.value;
  // Intl may render midnight as "24" with hour12:false in some engines.
  const hour = Number(out.hour) % 24;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour,
    minute: Number(out.minute),
  };
}

/**
 * "YYYY-MM-DDTHH:mm" read as an America/Los_Angeles wall-clock time → ISO 8601 UTC instant.
 * Returns null for an unparseable value.
 * @param {string} local
 * @returns {?string}
 */
export function laWallClockToIso(local) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(local || ''));
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  // Start from the same wall-clock read as UTC, then shift by LA's offset at that instant.
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const la = zoneParts(new Date(guess));
  const laAsUtc = Date.UTC(la.year, la.month - 1, la.day, la.hour, la.minute);
  const offsetMs = laAsUtc - guess;
  const instant = new Date(guess - offsetMs);
  // Re-check once: across a DST transition the first shift can be off by an hour.
  const check = zoneParts(instant);
  const drift = Date.UTC(check.year, check.month - 1, check.day, check.hour, check.minute) - guess;
  const corrected = drift === 0 ? instant : new Date(instant.getTime() - drift);
  return Number.isNaN(corrected.getTime()) ? null : corrected.toISOString();
}

/**
 * ISO instant → "YYYY-MM-DDTHH:mm" in America/Los_Angeles, for pre-filling the input.
 * @param {string} iso
 * @returns {string} empty when unparseable
 */
export function isoToLaWallClock(iso) {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const p = zoneParts(instant);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}
