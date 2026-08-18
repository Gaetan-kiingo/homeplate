// U1-CONFIG — jurisdiction and MEHKO policy numbers (SRS §2.1.7, ADR-009; FR-11, AB-07).
//
// ADR-009: these caps are CONFIGURATION, defined here and NOWHERE else. No module may inline
// these numbers; every listing create/update path reads them from config and enforces them at
// the single server-side enforcement point. Day and week boundaries are evaluated in
// America/Los_Angeles — never UTC, never the caller's timezone.
//
// Services read these values via `require('src/config').mehko` (listingsPerHostPerDay,
// maxMealsPerDay, maxMealsPerWeek, timezone) — a projection built in ./index.js from this
// file, so the numbers still have exactly one home.
'use strict';

module.exports = Object.freeze({
  jurisdiction: 'US-CA',
  regulation: 'California AB 626 (MEHKO)',
  // ADR-009: boundary timezone for "per day" and "per week" cap evaluation.
  timezone: 'America/Los_Angeles',
  mehko: Object.freeze({
    // FR-11 / AB-07 / ADR-009 — one listing per host per calendar day (America/Los_Angeles).
    maxListingsPerHostPerDay: 1,
    // ADR-009 — at most 30 meals (seats) per host per day.
    maxMealsPerHostPerDay: 30,
    // ADR-009 — at most 90 meals (seats) per host per week. AB 626 set 60; Assembly Bill 1325
    // raised it to 90. The week is a fixed calendar block, ratified Monday–Sunday in LA time
    // (not a rolling 7-day window) — see ADR-009 "Weekly window shape", ratified 2026-08-18.
    maxMealsPerHostPerWeek: 90,
  }),
});
