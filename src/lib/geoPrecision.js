// src/lib/geoPrecision.js — U2-ADAPTER-MAPS: coordinate coarsening, the ADR-010 public-precision
// substrate (build-plan wave 2).
//
// ADR-010 makes address disclosure progressive: every PUBLIC read path (search, listing detail,
// host profile) exposes only an approximate area — a neighbourhood/city label plus coordinates
// snapped to a coarse grid — while the exact street address and precise coordinates stay in
// PostgreSQL for the privileged serializer. This module produces that public precision. The Maps
// adapter (src/adapters/maps.js) writes ONLY output of this function into Redis, so a cache read
// can never leak an exact location even if a later serializer is forgotten.
//
// Requirement traceability (SRS Appendix B):
//   FR-01  — coarsened coordinates are sufficient for map placement and distance filtering in
//            location search (ADR-010: approximate area pre-booking).
//   NFR-13 — data minimization: the public projection of a location carries no more precision
//            than the configured radius; the street address never appears here.
//   AB-08  — scraping mitigation: harvested public payloads yield only ~radius-level areas,
//            never a host's exact coordinates.
//   NFR-01 — pure arithmetic (no I/O), safe on the hot search path and inside cache writers.
//
// Mechanism: the globe is divided into a fixed grid of cells `coarsenRadiusMeters` on a side
// (config.privacy.coarsenRadiusMeters, ADR-010 "the coarsening radius is configuration, not a
// constant"). A coordinate maps to the CENTER of its cell, so:
//   - the same input always lands in the same cell (deterministic, cacheable),
//   - two nearby points in one cell become indistinguishable (k-anonymity within the cell),
//   - a precise address is displaced by up to ~0.71 × cell size, and
//   - coarsening is idempotent: a cell center maps to itself.
// Longitude cell width is computed at the SNAPPED latitude band (not the caller's raw latitude)
// so every point in a lat band shares one longitude grid — stability does not depend on the
// exact input.
'use strict';

const config = require('../config');

/** Meters per degree of latitude (WGS-84 mean); the standard survey approximation. */
const METERS_PER_DEGREE_LAT = 111320;

/** Output decimals: 1e-6 deg ≈ 0.11 m — far below any sane coarsening radius. */
const OUTPUT_DECIMALS = 6;

function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function assertLatLng(lat, lng) {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError('geoPrecision.coarsen: lat must be a finite number in [-90, 90]');
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RangeError('geoPrecision.coarsen: lng must be a finite number in [-180, 180]');
  }
}

/**
 * Default area label when no neighbourhood/city name is available: built from the COARSENED
 * cell center (already public precision), 3 decimals ≈ 111 m — never from the raw input.
 */
function defaultAreaLabel(coarseLat, coarseLng) {
  return `area near ${coarseLat.toFixed(3)}, ${coarseLng.toFixed(3)}`;
}

/**
 * Snap a precise coordinate to its public-precision cell center (ADR-010).
 *
 * @param {number} lat  Precise latitude in [-90, 90].
 * @param {number} lng  Precise longitude in [-180, 180].
 * @param {object} [options]
 * @param {number} [options.radiusMeters]  Cell size; defaults to
 *                 config.privacy.coarsenRadiusMeters (PRIVACY_COARSEN_RADIUS_METERS).
 * @param {string} [options.areaLabel]     Human area name (neighbourhood/city) to carry through;
 *                 falls back to a label derived from the coarsened cell center.
 * @returns {{lat: number, lng: number, areaLabel: string}} public-precision projection —
 *          the ONLY location shape that may be cached or serialized on public read paths.
 */
function coarsen(lat, lng, { radiusMeters, areaLabel } = {}) {
  assertLatLng(lat, lng);
  const radius = radiusMeters === undefined ? config.privacy.coarsenRadiusMeters : radiusMeters;
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    throw new RangeError('geoPrecision.coarsen: radiusMeters must be a positive finite number');
  }

  // Latitude grid: fixed cell height in degrees.
  const latCellDeg = radius / METERS_PER_DEGREE_LAT;
  const latIndex = Math.floor((lat + 90) / latCellDeg);
  const snappedLat = clamp((latIndex + 0.5) * latCellDeg - 90, -90, 90);

  // Longitude grid: cell width evaluated at the SNAPPED latitude band so the whole band shares
  // one grid. Near the poles cos(lat) → 0; degrade to a single band-wide cell rather than
  // dividing by ~0 (out of service area, but must stay well-defined).
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((snappedLat * Math.PI) / 180);
  const lngCellDeg = metersPerDegreeLng > 1 ? Math.min(radius / metersPerDegreeLng, 360) : 360;
  const lngIndex = Math.floor((lng + 180) / lngCellDeg);
  let snappedLng = (lngIndex + 0.5) * lngCellDeg - 180;
  if (snappedLng >= 180) snappedLng -= 360;
  snappedLng = clamp(snappedLng, -180, 180);

  const coarseLat = round(snappedLat, OUTPUT_DECIMALS);
  const coarseLng = round(snappedLng, OUTPUT_DECIMALS);
  const label =
    typeof areaLabel === 'string' && areaLabel.trim().length > 0
      ? areaLabel.trim()
      : defaultAreaLabel(coarseLat, coarseLng);

  return { lat: coarseLat, lng: coarseLng, areaLabel: label };
}

module.exports = { coarsen, defaultAreaLabel, METERS_PER_DEGREE_LAT };
