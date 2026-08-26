// client/src/api/http.js — U5-API-CLIENT: the ONE fetch wrapper every endpoint module uses
// (build-plan §6.1 5B behaviours 1–2). No resource module calls fetch directly for /api —
// this file is the single place where credentials, error typing and the 401 broadcast live.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-03 / AB-05 — `credentials: 'include'` on EVERY call: the opaque HttpOnly session
//     cookie rides each request and is never readable (zero document-cookie references under
//     client/src is a vitest grep gate). TLS is enforced by the server and the Vite proxy
//     (client/vite.config.js) — nothing here can weaken it: this module only ever issues
//     same-origin `/api/...` paths.
//   NFR-07 (groundwork) / NFR-08 — every non-2xx becomes ApiError { status, code, message,
//     details?, requestId? } from the API's typed envelope
//     { error: { code, message, correlationId, details? } } (src/middleware/errorHandler.js)
//     — never a stringified body — so wave-6 screens render one message per code and
//     announce it via the aria-live channel.
//   NFR-09 — transport failure maps to NETWORK_ERROR (status 0) and a body that is not the
//     typed envelope maps to UNEXPECTED_RESPONSE, so outages degrade to typed, renderable
//     states.
//   AB-08 — responses are returned exactly as the server's allowlist serializers shaped
//     them; nothing here re-derives or widens fields.
import { ApiError, NETWORK_ERROR, UNEXPECTED_RESPONSE } from './errors.js';
import { emitSessionExpired } from './sessionEvents.js';

/**
 * Build a query string from a plain object. undefined/null values are omitted (optional
 * filters simply absent, matching the zod `.optional()` schemas); everything else is
 * stringified and URL-encoded by URLSearchParams.
 * @param {object} [query]
 * @returns {string} '' or '?key=value&...'
 */
export function buildQuery(query) {
  if (!query || typeof query !== 'object') return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/**
 * Encode one path parameter, refusing to build a URL out of a missing id. A `null`/empty id
 * would otherwise silently hit `/api/listings/undefined` and surface as a confusing 422.
 * @param {string} value
 * @param {string} name  parameter name for the developer-facing TypeError
 * @returns {string} URL-safe encoded segment
 */
export function pathParam(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`API client: required path parameter "${name}" is missing`);
  }
  return encodeURIComponent(value);
}

/**
 * Core request. Resolves with the parsed JSON body (or null for 204/empty); rejects with
 * ApiError ONLY (never a raw fetch TypeError, never a stringified body).
 *
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path  same-origin API path ('/api/...')
 * @param {{body?: object, query?: object, signal?: AbortSignal}} [options]
 *   `body` is JSON-serialized; omit it entirely for routes that declare no body schema.
 * @returns {Promise<*>}
 * @throws {ApiError}
 */
export async function request(method, path, { body, query, signal } = {}) {
  const url = `${path}${buildQuery(query)}`;
  /** @type {RequestInit} */
  const init = {
    method,
    // NFR-03/AB-05: the HttpOnly session cookie rides every API call; it is never read.
    credentials: 'include',
    headers: { Accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (signal !== undefined) init.signal = signal;

  let response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new ApiError('Could not reach the Homeplate service. Check your connection and retry.', {
      status: 0,
      code: NETWORK_ERROR,
      cause,
    });
  }

  if (response.status === 204) return null;

  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ApiError('The connection was interrupted before the response completed.', {
      status: 0,
      code: NETWORK_ERROR,
      cause,
    });
  }

  let data;
  let parseFailed = false;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (!response.ok) {
    // AB-05/NFR-03: a 401 means the session is absent or dead — broadcast BEFORE throwing so
    // the session store flips to 'anonymous' even if the caller swallows the error.
    if (response.status === 401) emitSessionExpired();

    const envelope =
      data && typeof data === 'object' && data.error && typeof data.error === 'object'
        ? data.error
        : null;
    if (!envelope || typeof envelope.code !== 'string') {
      // Non-2xx without the typed envelope (proxy error page, truncated body, ...).
      throw new ApiError(`The service answered unexpectedly (HTTP ${response.status}).`, {
        status: response.status,
        code: UNEXPECTED_RESPONSE,
      });
    }
    throw new ApiError(
      typeof envelope.message === 'string' && envelope.message !== ''
        ? envelope.message
        : 'The request failed.',
      {
        status: response.status,
        code: envelope.code,
        details: envelope.details,
        requestId: typeof envelope.correlationId === 'string' ? envelope.correlationId : undefined,
      }
    );
  }

  if (text === '') return null;
  if (parseFailed) {
    throw new ApiError('The service answered with an unreadable response body.', {
      status: response.status,
      code: UNEXPECTED_RESPONSE,
    });
  }
  return data;
}

/** GET convenience wrapper. @see request */
export function get(path, options) {
  return request('GET', path, options);
}

/** POST convenience wrapper. @see request */
export function post(path, options) {
  return request('POST', path, options);
}

/** PATCH convenience wrapper. @see request */
export function patch(path, options) {
  return request('PATCH', path, options);
}

/** DELETE convenience wrapper (`delete` is reserved). @see request */
export function del(path, options) {
  return request('DELETE', path, options);
}
