// client/src/api/media.js — U5-API-CLIENT: the /api/media supply path, transcribed from
// src/modules/media/routes.js on this tree (never invented), plus the direct-to-storage
// upload step that path is built around.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-02/FR-03/FR-05 — listing, host-profile and review images: mint an upload target,
//     PUT the bytes STRAIGHT to object storage (image bytes never transit the API —
//     ADR-004/ADR-001), then attach the minted key.
//   AB-08 — keys are SERVER-generated under the caller's own namespace; attaching a foreign
//     key is a 403 (MEDIA_KEY_FORBIDDEN). remove() delete-MARKS; physical per-key deletion
//     stays on the worker/erasure path (NFR-12).
//   NFR-03 / AB-05 — uploadToTarget PUTs to the server-minted storage URL with
//     `credentials: 'omit'`: the API session cookie must NEVER be sent to the storage host.
//     This is the ONE deliberate exception to the include-on-every-call rule, which covers
//     /api calls (the endpoint-surface spec pins both sides).
import { post, del, pathParam } from './http.js';
import { ApiError, NETWORK_ERROR, MEDIA_UPLOAD_FAILED } from './errors.js';

/**
 * POST /api/media/uploads — mint a namespaced direct-to-storage upload target. Pure local
 * computation server-side; a storage outage never fails this call.
 * @param {{kind: string, contentType: string, sizeBytes: number}} body
 * @returns {Promise<{storageKey: string, uploadUrl: string, headers: object, expiresAt: string}>}
 */
export function createUploadTarget(body) {
  return post('/api/media/uploads', { body });
}

/**
 * PUT the file bytes to the minted target's storage URL (NOT an API route — the URL and
 * headers are server-issued by createUploadTarget; nothing here invents an endpoint).
 * @param {{uploadUrl: string, headers?: object, storageKey: string}} target
 * @param {Blob|File|ArrayBuffer} data  the image bytes
 * @returns {Promise<{storageKey: string}>} the key to pass to attach()
 * @throws {ApiError} NETWORK_ERROR on transport failure; MEDIA_UPLOAD_FAILED on a non-2xx
 *         storage answer (client-derived code — storage speaks no typed envelope)
 */
export async function uploadToTarget(target, data) {
  if (!target || typeof target.uploadUrl !== 'string' || target.uploadUrl === '') {
    throw new TypeError('uploadToTarget: target must be the object minted by createUploadTarget');
  }
  let response;
  try {
    response = await fetch(target.uploadUrl, {
      method: 'PUT',
      // AB-05: never send the API session cookie to the storage host.
      credentials: 'omit',
      headers: target.headers || {},
      body: data,
    });
  } catch (cause) {
    throw new ApiError('The image upload could not reach storage. Check your connection.', {
      status: 0,
      code: NETWORK_ERROR,
      cause,
    });
  }
  if (!response.ok) {
    throw new ApiError(`The image upload failed (HTTP ${response.status}). Please retry.`, {
      status: response.status,
      code: MEDIA_UPLOAD_FAILED,
    });
  }
  return { storageKey: target.storageKey };
}

/**
 * POST /api/media — record the attachment for a minted, uploaded key (201).
 * @param {{storageKey: string, kind: string, entityId?: string, contentType?: string,
 *          sizeBytes?: number}} body
 * @returns {Promise<{media: object}>}
 */
export function attach(body) {
  return post('/api/media', { body });
}

/**
 * DELETE /api/media/:id — delete-mark own media (204 → null); idempotent for the owner.
 * @param {string} id
 * @returns {Promise<null>}
 */
export function remove(id) {
  return del(`/api/media/${pathParam(id, 'id')}`);
}
