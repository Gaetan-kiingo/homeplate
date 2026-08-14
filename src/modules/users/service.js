// src/modules/users/service.js — U2-IDENTITY: profile reads/updates + eligibility-flag
// recomputation through the single U2-ELIGIBILITY policy.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-06 (IT-02) — "Registration and profile update recompute and persist the eligibility
//                    flags on the USER row, and the flags equal the policy result after every
//                    mutation." recomputeEligibility() asks policy.evaluate() (FR-09's ONE
//                    interface — never a local re-implementation, ADR-006) on the SAME
//                    transaction client as the mutation, so the persisted flags can never
//                    read a stale row.
//   NFR-08 (MT-01) — every profile mutation writes one audit record (event, actor, entity,
//                    outcome, correlationId via req.log); changed FIELD NAMES are logged,
//                    never field values (SRS §3.4 PII register).
//   NFR-13 / AB-08 — reads return the explicit allowlist serializer from ./repo; phone and
//                    emergency contact are decrypted ONLY for the authenticated owner.
//
// Public interface (build-plan §3): users service for profile reads/updates; the auth
// service reuses recomputeEligibility() after registration and email verification.
'use strict';

const { withTransaction } = require('../../db/tx');
const { NotFoundError } = require('../../lib/errors');
const { logger, audit } = require('../../lib/logger');
const policy = require('../eligibility/policy');
const repo = require('./repo');

/**
 * Recompute canReserveSeat / canPublishListing through the single eligibility policy and
 * persist them on the users row (NFR-06). Runs on the caller's transaction client so the
 * evaluation sees the mutation it follows.
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @returns {Promise<object|null>} the updated users row (null when the user vanished)
 */
async function recomputeEligibility(client, userId) {
  const [reserve, publish] = await Promise.all([
    policy.evaluate(userId, policy.ACTIONS.RESERVE_SEAT, client),
    policy.evaluate(userId, policy.ACTIONS.PUBLISH_LISTING, client),
  ]);
  return repo.setEligibilityFlags(
    userId,
    { canReserveSeat: reserve.allowed, canPublishListing: publish.allowed },
    client
  );
}

/**
 * The authenticated user's own profile (GET /api/users/me).
 * @param {string} userId
 * @returns {Promise<object>} allowlist-serialized profile (NFR-13/AB-08)
 */
async function getProfile(userId) {
  const row = await repo.findById(userId);
  if (!row || row.deleted_at !== null) {
    throw new NotFoundError('User not found');
  }
  const hostProfile = await repo.getHostProfile(userId);
  return repo.serializeUser(row, hostProfile);
}

/**
 * Apply a PATCH /api/users/me body (already validated by src/schemas/auth.js profileUpdate)
 * and recompute the eligibility flags in the same transaction (NFR-06).
 *
 * API patch shape: { fullName?, phone?, emergencyContact?|null, hostProfile? } — an absent
 * key changes nothing; null clears the attribute (emergencyContact null clears all three
 * §3.4 emergency-contact fields together — NFR-13 deletion scope).
 *
 * @param {string} userId
 * @param {object} patch
 * @param {{log?: object}} [ctx]  request-scoped logger for the audit record (NFR-08)
 * @returns {Promise<object>} the updated allowlist-serialized profile
 */
async function updateProfile(userId, patch, { log = logger } = {}) {
  const changedFields = [];

  const result = await withTransaction(async (client) => {
    const existing = await repo.findById(userId, client);
    if (!existing || existing.deleted_at !== null) {
      throw new NotFoundError('User not found');
    }

    // users-row columns (full name, phone, emergency contact — encrypted in the repo).
    const columnPatch = {};
    if (patch.fullName !== undefined) {
      columnPatch.fullName = patch.fullName;
      changedFields.push('fullName');
    }
    if (patch.phone !== undefined) {
      columnPatch.phone = patch.phone;
      changedFields.push('phone');
    }
    if (patch.emergencyContact !== undefined) {
      const contact = patch.emergencyContact;
      columnPatch.emergencyContactName = contact === null ? null : contact.name;
      columnPatch.emergencyContactPhone = contact === null ? null : contact.phone;
      columnPatch.emergencyContactEmail = contact === null ? null : contact.email;
      changedFields.push('emergencyContact');
    }
    let row = existing;
    if (Object.keys(columnPatch).length > 0) {
      row = await repo.updateProfileFields(client, userId, columnPatch);
    }

    // Host-profile completion inputs (NFR-06 canPublishListing).
    let hostProfile = await repo.getHostProfile(userId, client);
    if (patch.hostProfile !== undefined) {
      hostProfile = await repo.upsertHostProfile(client, userId, patch.hostProfile);
      changedFields.push('hostProfile');
    }

    // NFR-06: flags recomputed through the ONE policy, same transaction as the mutation.
    const flagged = await recomputeEligibility(client, userId);
    return repo.serializeUser(flagged ?? row, hostProfile);
  });

  // MT-01 audit record: field NAMES only, never values (SRS §3.4 PII register).
  audit(log, {
    event: 'user.profile_updated',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'user',
    entityId: userId,
    changedFields,
    canReserveSeat: result.canReserveSeat,
    canPublishListing: result.canPublishListing,
  });

  return result;
}

module.exports = { getProfile, updateProfile, recomputeEligibility };
