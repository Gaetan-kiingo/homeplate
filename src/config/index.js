// U1-CONFIG — single configuration entry point.
// `require('src/config')` returns one deep-frozen object; an invalid or incomplete
// environment throws at load time (FAIL FAST — a missing required secret aborts start-up
// rather than defaulting; build-plan §3 wave 1).
//
// Requirement traceability (SRS Appendix B): NFR-05 (auth.loginMaxAttempts/loginWindowSeconds),
// NFR-09 (adapters.timeoutMs/retryMax/backoffBaseMs, outbox.*), NFR-12 (privacy.erasureDays/
// inactivityMonths), NFR-13 (crypto.fieldEncryptionKeyHex, privacy.coarsenRadiusMeters),
// FR-08 (moderation.* incl. confidenceThreshold), FR-10 (auth.emailTokenTtlHours),
// FR-11 (mehko.* — ADR-009 caps), FR-12 (booking.maxConcurrentPending), FR-13 (outbox.*,
// notifications.* — ADR-011 push gated default-false).
//
// In development/production, variables come from the process environment plus an optional
// `.env` file (dotenv). Under NODE_ENV=test the `.env` file is NOT read: the test
// environment is fully defined by tests/helpers/env.js so runs are reproducible (SRS §4.1).
'use strict';

const path = require('path');
const { validateEnv, deepFreeze } = require('./schema');
const locale = require('./locale');

if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const config = validateEnv(process.env);

// Canonical MEHKO cap section (FR-11, AB-07, ADR-009; SRS §2.1.7). The numbers are defined
// ONCE, in ./locale.js — this is a projection under the names every enforcement point reads
// (config.mehko.*), never a second copy. Day/week boundaries use mehko.timezone, never UTC.
const mehko = {
  listingsPerHostPerDay: locale.mehko.maxListingsPerHostPerDay,
  maxMealsPerDay: locale.mehko.maxMealsPerHostPerDay,
  maxMealsPerWeek: locale.mehko.maxMealsPerHostPerWeek,
  timezone: locale.timezone,
};

// locale is frozen by its own module; attach and freeze the composite.
module.exports = deepFreeze({ ...config, locale, mehko });
