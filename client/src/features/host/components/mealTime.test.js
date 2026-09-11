// client/src/features/host/components/mealTime.test.js — the America/Los_Angeles wall-clock
// conversion the listing form relies on (SRS §2.1.7 / ADR-009): a host anywhere in the world
// enters the meal's LA time and the API receives the matching UTC instant.
import { describe, expect, it } from 'vitest';
import { isoToLaWallClock, laWallClockToIso } from './mealTime.js';

describe('laWallClockToIso', () => {
  it('converts a PDT wall-clock time (UTC-7) to the UTC instant', () => {
    expect(laWallClockToIso('2026-09-13T18:30')).toBe('2026-09-14T01:30:00.000Z');
  });

  it('converts a PST wall-clock time (UTC-8) to the UTC instant', () => {
    expect(laWallClockToIso('2026-12-20T18:30')).toBe('2026-12-21T02:30:00.000Z');
  });

  it('does not depend on the browser zone: the same input always yields the same instant', () => {
    // vitest runs in whatever TZ the machine has; the conversion goes through Intl with an
    // explicit zone, so it must be identical to the fixed expectations above regardless.
    expect(laWallClockToIso('2026-07-04T12:00')).toBe('2026-07-04T19:00:00.000Z');
  });

  it('returns null for a value that is not a datetime-local string', () => {
    expect(laWallClockToIso('')).toBeNull();
    expect(laWallClockToIso('tomorrow evening')).toBeNull();
    expect(laWallClockToIso(undefined)).toBeNull();
  });
});

describe('isoToLaWallClock', () => {
  it('round-trips an instant back to the LA wall clock for the input control', () => {
    expect(isoToLaWallClock('2026-09-14T01:30:00.000Z')).toBe('2026-09-13T18:30');
    expect(isoToLaWallClock(laWallClockToIso('2026-12-20T18:30'))).toBe('2026-12-20T18:30');
  });

  it('is empty for an unparseable instant', () => {
    expect(isoToLaWallClock('not a date')).toBe('');
  });
});
