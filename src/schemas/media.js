// src/schemas/media.js — U3-HOSTS-MEDIA: zod schemas for every /api/media route (API boundary,
// build-plan wave 3B).
//
// Requirement traceability (SRS Appendix B):
//   FR-02 / FR-03 / FR-05 — the media supply path: upload-target minting and attachment
//            record shapes for listing, host-profile and (wave-4) review images (ADR-004 —
//            media live in object storage referenced by key).
//   NFR-11 / AB-06 (ST-04) — kind is a strict enum of media_entity_type; contentType must be
//            on the CONFIGURED allowlist (config.media.allowedContentTypes — configuration,
//            never an inline policy literal); sizeBytes is bounded by the configured cap;
//            storageKey must match the canonical S3-safe key pattern with no '..' traversal.
//            Hostile payloads therefore arrive as 422 shape violations or inert data — no
//            executable markup can ever reach media_objects through these shapes.
//   NFR-13 / AB-08 — the shapes carry identifiers, a MIME type and a byte count only; no
//            personal data field exists at this boundary.
//   ADR-001/003 — imports src/lib/mediaUrls (pure local computation) for the key pattern and
//            kind enum; NOTHING from src/adapters/* is reachable from this module.
'use strict';

const { z } = require('zod');
const config = require('../config');
const { uuid } = require('./common');
const { MEDIA_KINDS, KEY_PATTERN } = require('../lib/mediaUrls');

/** media_objects.entity_type enum ('listing' | 'review' | 'host_profile'). */
const kind = z.enum([...MEDIA_KINDS]);

/** MIME type on the CONFIGURED allowlist (ADR-004 upload validation; values from env via
 *  src/config — src/lib/mediaUrls.createUploadTarget re-checks the same config as defense
 *  in depth, so there is one source of truth for the allowed set). */
const contentType = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .refine((value) => config.media.allowedContentTypes.includes(value), {
    message: `must be one of: ${config.media.allowedContentTypes.join(', ')}`,
  });

/** Declared object size, bounded by the configured cap (config.media.maxUploadBytes). */
const sizeBytes = z.coerce
  .number()
  .int('must be an integer')
  .min(1, 'must be at least 1 byte')
  .max(config.media.maxUploadBytes, 'exceeds the configured upload size limit');

/** Canonical storage-key shape (mirror of the adapter/mediaUrls KEY_PATTERN rule): S3-safe
 *  charset, no leading slash, bounded length, no '..' traversal (NFR-11, ST-04). */
const storageKey = z
  .string()
  .min(1)
  .max(512)
  .regex(KEY_PATTERN, 'must be a valid object-storage key')
  .refine((value) => !value.includes('..'), { message: 'must not contain ".."' });

/** POST /api/media/uploads — mint a direct-to-storage upload target (build-plan §6.3). */
const uploadTarget = z.object({
  kind,
  contentType,
  sizeBytes,
});

/** POST /api/media — record an attachment for a previously minted, caller-namespaced key.
 *  entityId (optional) is the listing / review / host user the media belongs to; ownership
 *  of that entity is verified in the route (403 otherwise). */
const attach = z.object({
  storageKey,
  kind,
  entityId: uuid.optional(),
  contentType: contentType.optional(),
  sizeBytes: sizeBytes.optional(),
});

/** Path params for DELETE /api/media/:id. */
const idParams = z.object({ id: uuid });

module.exports = { kind, contentType, sizeBytes, storageKey, uploadTarget, attach, idParams };
