// src/modules/eligibility/policy.js — U2-ELIGIBILITY: THE single eligibility policy interface.
//
// Requirement traceability (SRS Appendix B):
//   FR-09  — while a user does not satisfy the eligibility policy for an action, that action
//            is restricted; every restricted flow consults evaluate()/requireEligibility()
//            from THIS module and nowhere else.
//   NFR-06 — canReserveSeat requires email_verified AND full_name AND phone_number;
//            canPublishListing additionally requires a completed host profile AND
//            host-agreement acceptance. The rules exist behind this one interface so v2.0
//            identity verification can replace them without touching any consumer (ADR-006).
//   AB-01  — a host who has not completed the profile/host-agreement gate cannot publish.
//   AB-02  — ineligible users are blocked before any capacity check in the booking flow.
//   AB-08  — eligibility decisions are computed from presence booleans; no personal data
//            (phone, email address) flows through results, reasons or logs — IDs and
//            machine-readable codes only.
//
// ADR-006 single-interface rule (build-plan invariant 4): canReserveSeat / canPublishListing
// are implemented HERE and only here. tests/unit/eligibility.test.js walks src/ and fails on
// any second implementation. The denormalized users.can_reserve_seat / can_publish_listing
// columns are projections persisted by the identity module CALLING these predicates — they
// are never an alternative rule source.
//
// Public interface (build-plan §3 wave-2 contract):
//   evaluate(userId, action[, client]) -> Promise<{ allowed, reasons: string[] }>
//   canReserveSeat(user)  -> boolean
//   canPublishListing(user) -> boolean
//   reasonsFor(user, action) -> string[]      (machine-readable codes, deterministic order)
//   ACTIONS, REASONS       — frozen constant maps
//   assertAction(action)   — definition-time guard used by requireEligibility()
'use strict';

const repo = require('./repo');

/** Actions the policy knows how to judge (FR-09). */
const ACTIONS = Object.freeze({
  RESERVE_SEAT: 'reserve_seat',
  PUBLISH_LISTING: 'publish_listing',
});

const ACTION_VALUES = Object.freeze(Object.values(ACTIONS));

/**
 * Machine-readable reason codes (NFR-06 acceptance set, plus USER_NOT_FOUND for a session
 * whose account no longer exists / was erased under NFR-12 — still restricted per FR-09).
 */
const REASONS = Object.freeze({
  EMAIL_UNVERIFIED: 'EMAIL_UNVERIFIED',
  NAME_MISSING: 'NAME_MISSING',
  PHONE_MISSING: 'PHONE_MISSING',
  HOST_PROFILE_INCOMPLETE: 'HOST_PROFILE_INCOMPLETE',
  HOST_AGREEMENT_MISSING: 'HOST_AGREEMENT_MISSING',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
});

/** True for a non-empty, non-blank string (a whitespace-only full_name is still missing). */
function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Host-profile completeness rule (NFR-06 "completed host profile"). SRS §3.4 gives the host
 * profile exactly one content attribute (bio) beyond the agreement timestamp, so a profile is
 * complete when the row exists and carries a non-blank bio. This derivation lives HERE so no
 * caller ever re-invents it (ADR-006).
 * @param {{bio?: string|null}|null|undefined} hostProfile joined host_profiles row, or null.
 * @returns {boolean}
 */
function isHostProfileComplete(hostProfile) {
  if (!hostProfile || typeof hostProfile !== 'object') return false;
  return nonBlank(hostProfile.bio);
}

/**
 * Normalize the accepted user shapes into presence booleans. Accepted inputs (documented for
 * consumers such as U2-IDENTITY's flag recomputation and wave-3 flows):
 *  - a users DB row (snake_case), optionally merged/joined with host_profiles columns
 *    (host_agreement_accepted_at) or carrying a nested `host_profile` object;
 *  - the repo.getEligibilityAttributes() snapshot (presence booleans has_full_name /
 *    has_phone / host_profile_complete);
 *  - camelCase equivalents of any of the above.
 * Phone presence intentionally accepts the encrypted-at-rest column (phone_enc, NFR-13):
 * ciphertext presence === attribute presence, and the plaintext never needs decrypting here
 * (AB-08 data minimization).
 */
function normalizeUser(user) {
  if (!user || typeof user !== 'object') {
    throw new TypeError('eligibility policy: expected a user attribute object');
  }

  const emailVerified = Boolean(user.email_verified ?? user.emailVerified);

  let hasFullName;
  if (typeof (user.has_full_name ?? user.hasFullName) === 'boolean') {
    hasFullName = user.has_full_name ?? user.hasFullName;
  } else {
    hasFullName = nonBlank(user.full_name ?? user.fullName);
  }

  let hasPhone;
  if (typeof (user.has_phone ?? user.hasPhone) === 'boolean') {
    hasPhone = user.has_phone ?? user.hasPhone;
  } else {
    hasPhone = nonBlank(
      user.phone_enc ?? user.phoneEnc ?? user.phone_number ?? user.phoneNumber ?? user.phone
    );
  }

  const hostProfile = user.host_profile ?? user.hostProfile ?? null;

  let hostProfileComplete;
  if (typeof (user.host_profile_complete ?? user.hostProfileComplete) === 'boolean') {
    hostProfileComplete = user.host_profile_complete ?? user.hostProfileComplete;
  } else {
    hostProfileComplete = isHostProfileComplete(hostProfile);
  }

  const hostAgreementAcceptedAt =
    user.host_agreement_accepted_at ??
    user.hostAgreementAcceptedAt ??
    (hostProfile
      ? (hostProfile.host_agreement_accepted_at ?? hostProfile.hostAgreementAcceptedAt ?? null)
      : null);

  return {
    emailVerified,
    hasFullName,
    hasPhone,
    hostProfileComplete,
    hasHostAgreement: hostAgreementAcceptedAt !== null && hostAgreementAcceptedAt !== undefined,
  };
}

/** Definition-time guard: an unknown action is a programming error and must fail at boot. */
function assertAction(action) {
  if (!ACTION_VALUES.includes(action)) {
    throw new RangeError(
      `eligibility policy: unknown action "${String(action)}" — expected one of ` +
        ACTION_VALUES.map((a) => `"${a}"`).join(', ')
    );
  }
  return action;
}

/**
 * Machine-readable reason codes for one user/action pair, in deterministic order
 * (EMAIL_UNVERIFIED, NAME_MISSING, PHONE_MISSING, then for publish_listing
 * HOST_PROFILE_INCOMPLETE, HOST_AGREEMENT_MISSING). Empty array === allowed (NFR-06).
 * @param {object} user   see normalizeUser() for accepted shapes.
 * @param {string} action one of ACTIONS.*
 * @returns {string[]}
 */
function reasonsFor(user, action) {
  assertAction(action);
  const attrs = normalizeUser(user);
  const reasons = [];
  if (!attrs.emailVerified) reasons.push(REASONS.EMAIL_UNVERIFIED);
  if (!attrs.hasFullName) reasons.push(REASONS.NAME_MISSING);
  if (!attrs.hasPhone) reasons.push(REASONS.PHONE_MISSING);
  if (action === ACTIONS.PUBLISH_LISTING) {
    if (!attrs.hostProfileComplete) reasons.push(REASONS.HOST_PROFILE_INCOMPLETE);
    if (!attrs.hasHostAgreement) reasons.push(REASONS.HOST_AGREEMENT_MISSING);
  }
  return reasons;
}

/**
 * canReserveSeat — true iff email_verified AND full_name AND phone_number (NFR-06).
 * @param {object} user  see normalizeUser() for accepted shapes.
 * @returns {boolean}
 */
function canReserveSeat(user) {
  return reasonsFor(user, ACTIONS.RESERVE_SEAT).length === 0;
}

/**
 * canPublishListing — canReserveSeat's attributes AND host_profile_complete AND
 * host_agreement_accepted_at (NFR-06, AB-01).
 * @param {object} user  see normalizeUser() for accepted shapes.
 * @returns {boolean}
 */
function canPublishListing(user) {
  return reasonsFor(user, ACTIONS.PUBLISH_LISTING).length === 0;
}

/**
 * evaluate — load the user's current attributes and judge one action (FR-09).
 * A missing, soft-deleted or anonymized account (NFR-12) is not eligible for anything:
 * { allowed: false, reasons: [USER_NOT_FOUND] } — the caller decides how to map that.
 *
 * @param {string} userId  UUID of the acting user (IDs only — AB-08).
 * @param {string} action  one of ACTIONS.*
 * @param {import('pg').PoolClient|null} [client]  optional transaction client so wave-3
 *   flows can check eligibility inside the same transaction as their business write
 *   (ADR-001 — no dual reads across transactions).
 * @returns {Promise<{allowed: boolean, reasons: string[]}>}
 */
async function evaluate(userId, action, client = null) {
  assertAction(action);
  if (typeof userId !== 'string') {
    throw new TypeError('eligibility policy: evaluate(userId, action) requires a string userId');
  }
  const snapshot = await repo.getEligibilityAttributes(userId, client);
  if (snapshot === null) {
    return { allowed: false, reasons: [REASONS.USER_NOT_FOUND] };
  }
  const reasons = reasonsFor(snapshot, action);
  return { allowed: reasons.length === 0, reasons };
}

module.exports = {
  ACTIONS,
  REASONS,
  assertAction,
  isHostProfileComplete,
  reasonsFor,
  canReserveSeat,
  canPublishListing,
  evaluate,
};
