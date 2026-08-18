// src/modules/media/routes.js — U3-HOSTS-MEDIA: the /api/media HTTP surface (mounted by the
// U1-HTTP route registry; build-plan wave 3B; SPMP WA-8).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-02 / FR-03 / FR-05 — the media supply path for listing, host-profile and (wave-4)
//            review images: POST /uploads mints a namespaced direct-to-storage upload target,
//            POST / records the attachment through the wave-2 media service, DELETE /:id
//            delete-marks a row. Review photos arrive through these same endpoints in wave 4
//            (kind='review') — no new surface needed.
//   ADR-001/003 (build-plan §6.3) — NO ADAPTER ON THE REQUEST PATH: the upload target is
//            pure local SigV4 computation (src/lib/mediaUrls); the client PUTs bytes straight
//            to object storage, so image bytes never transit this API and a storage outage
//            never fails these routes. Physical deletion stays on the worker/erasure path
//            (mediaService.deleteForUser, ADR-004/NFR-12) — DELETE here only marks the row.
//   NFR-13 / AB-08 — upload keys are SERVER-generated under <kind>/<userId>/…; attaching a
//            key outside the caller's own namespace is 403, so cross-user attachment and
//            key-guessing harvesting are impossible. Attaching to an entity the caller does
//            not own (someone else's listing/review/profile) is 403/404. Every route
//            requires a session (401 otherwise).
//   NFR-11 / AB-06 (ST-04) — every route declares its zod schema (src/schemas/media.js):
//            kind/contentType/size validated against the CONFIGURED allowlists, storage keys
//            against the canonical pattern — hostile payloads are 422/403, never a 500, and
//            nothing executable can be stored.
//   NFR-08 (MT-01) — every mutation writes one structured audit record (IDs only) through
//            the request-scoped logger, so the correlation id rides every line.
//
// Data access note (ADR-001 layering): this file executes NO SQL. Every read it needs comes
// from a repo — media_objects through src/modules/media/repo.js (findOwnedById / markDeleted),
// listings through the listings repo, review authorship through mediaRepo.findReviewAuthorId.
// That last one is a transitional tenant of the media repo because U4-REVIEWS ships in wave 4;
// when it lands, the function moves to src/modules/reviews/repo.js and the call here re-points
// at it (tracked in build-plan §4, U4-REVIEWS). Nothing on this path changes behaviourally.
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const mediaSchemas = require('../../schemas/media');
const { requireSession } = require('../auth/middleware');
const mediaService = require('./service');
const mediaRepo = require('./repo');
const mediaUrls = require('../../lib/mediaUrls');
const { audit } = require('../../lib/logger');
const { ForbiddenError, NotFoundError } = require('../../lib/errors');
const listingsRepo = require('../listings/repo');

const router = express.Router();

/** The caller's own upload namespace for a kind (mirror of mediaUrls.createUploadTarget's
 *  server-generated key shape `<kind>/<userId>/<uuid>.<ext>` — AB-08). */
function ownPrefix(userId, kind) {
  return `${kind}/${String(userId).toLowerCase()}/`;
}

/**
 * Verify the caller owns the entity a media object is being attached to (AB-08 — media can
 * never be planted on someone else's listing, review or profile):
 *   - kind 'listing'      → the listing must exist (404) and belong to the caller (403);
 *   - kind 'review'       → the review must exist (404) and be authored by the caller (403)
 *                           (wave-4 reviews attach photos through this same rule — FR-05);
 *   - kind 'host_profile' → the only attachable entity is the caller's own profile (403).
 * entityId is optional: an attachment recorded before its entity linkage stays owner-scoped
 * via owner_user_id and the key namespace.
 */
async function assertEntityAttachable(userId, kind, entityId) {
  if (entityId === undefined || entityId === null) return;

  if (kind === 'listing') {
    const listing = await listingsRepo.findById(entityId);
    if (!listing) throw new NotFoundError('Listing not found');
    if (listing.host_id !== userId) {
      throw new ForbiddenError('You can only attach media to your own listing', {
        code: 'MEDIA_ENTITY_NOT_OWNED',
      });
    }
    return;
  }

  if (kind === 'review') {
    // Authorship comes from the repo layer (mediaRepo hosts it until U4-REVIEWS lands — see
    // header note). null row → the review does not exist; a null authorId (NFR-12 anonymized
    // author) matches no caller, so such a review is attachable by nobody.
    const review = await mediaRepo.findReviewAuthorId(entityId);
    if (!review) throw new NotFoundError('Review not found');
    if (review.authorId !== userId) {
      throw new ForbiddenError('You can only attach media to your own review', {
        code: 'MEDIA_ENTITY_NOT_OWNED',
      });
    }
    return;
  }

  // kind === 'host_profile' (schema-enforced enum): the entity IS the host's own profile.
  if (entityId !== userId) {
    throw new ForbiddenError('You can only attach media to your own host profile', {
      code: 'MEDIA_ENTITY_NOT_OWNED',
    });
  }
}

/** Explicit-allowlist projection of a media row for API responses (NFR-13/AB-08 — never a
 *  row spread; the URL is derived locally from the storage key, ADR-004). */
function serializeMedia(media) {
  return {
    id: media.id,
    kind: media.entityType,
    entityId: media.entityId,
    storageKey: media.storageKey,
    contentType: media.contentType,
    sizeBytes: media.sizeBytes,
    url: mediaUrls.urlForKey(media.storageKey),
    createdAt: media.createdAt,
  };
}

// POST /api/media/uploads — mint a direct-to-storage upload target (FR-02/03/05 supply path).
// PURE LOCAL COMPUTATION (build-plan §6.3): no network call, no src/adapters import — the
// unit test pins both. kind/contentType/size are validated against the configured allowlists
// by the schema AND by mediaUrls.createUploadTarget (one configured source of truth).
router.post(
  '/uploads',
  requireSession,
  validate({ body: mediaSchemas.uploadTarget }),
  (req, res, next) => {
    try {
      const { kind, contentType, sizeBytes } = req.body;
      const target = mediaUrls.createUploadTarget(req.auth.userId, kind, contentType, {
        sizeBytes,
      });
      // { storageKey: '<kind>/<userId>/<uuid>.<ext>', uploadUrl, headers, expiresAt }
      res.status(200).json(target);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/media — record an attachment for a minted key (wave-2 mediaService.attach).
router.post(
  '/',
  requireSession,
  validate({ body: mediaSchemas.attach }),
  async (req, res, next) => {
    try {
      const { storageKey, kind, entityId, contentType, sizeBytes } = req.body;
      const userId = req.auth.userId;

      // AB-08: only keys under the caller's own server-issued namespace are attachable.
      if (!storageKey.startsWith(ownPrefix(userId, kind))) {
        throw new ForbiddenError('storageKey is outside your own upload namespace', {
          code: 'MEDIA_KEY_FORBIDDEN',
        });
      }
      await assertEntityAttachable(userId, kind, entityId);

      const media = await mediaService.attach(userId, storageKey, kind, {
        entityId: entityId ?? null,
        contentType: contentType ?? null,
        sizeBytes: sizeBytes ?? null,
      });

      // NFR-08/MT-01 audit record — IDs and kinds only, never key contents beyond the id.
      audit(req.log, {
        event: 'media.attached',
        outcome: 'success',
        actorUserId: userId,
        entityType: 'media',
        entityId: media.id,
        mediaKind: kind,
        attachedTo: entityId ?? null,
      });

      res.status(201).json({ media: serializeMedia(media) });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/media/:id — delete-MARK only (sets deleted_at so the object disappears from
// every read path immediately); physical per-key deletion stays on the worker/erasure path
// (ADR-004, NFR-12). Idempotent for the owner; someone else's media (or an unknown id) is a
// 404 — indistinguishable on purpose (AB-08).
router.delete(
  '/:id',
  requireSession,
  validate({ params: mediaSchemas.idParams }),
  async (req, res, next) => {
    try {
      const userId = req.auth.userId;
      const media = await mediaRepo.findOwnedById(userId, req.params.id);
      if (!media) throw new NotFoundError('Media not found');

      const marked = await mediaRepo.markDeleted(media.id);
      if (marked) {
        audit(req.log, {
          event: 'media.delete_marked',
          outcome: 'success',
          actorUserId: userId,
          entityType: 'media',
          entityId: media.id,
        });
      }

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
