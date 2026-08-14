// src/lib/httpClient.js — U1-OBS resilient outbound HTTP(S) client (build-plan wave 1).
// The transport under every REST-style adapter (Maps ADR-005, SendGrid ADR-011, moderation
// LLM ADR-007). Adapters remain worker-only code (ADR-001/003) — this module is transport,
// not policy.
//
// Requirement traceability (SRS Appendix B):
//   NFR-09 (RT-01) — every request runs inside withResilience: per-attempt timeout
//                    (default 3000 ms) with AbortSignal cancellation, bounded retries with
//                    exponential backoff on transient failures (network errors, 5xx, 429,
//                    408 — never other 4xx), and an optional fallback for degraded mode.
//   NFR-08 (MT-01) — failures surface as AppError subclasses (TimeoutError,
//                    UpstreamServiceError) carrying status + code; log lines name only the
//                    method and host, never full URLs (query strings can carry PII).
//   NFR-03 / ADR-006 — outbound calls are HTTPS-only. Plain http:// is refused unless the
//                    caller passes `allowHttp: true` AND NODE_ENV !== 'production'
//                    (local mocks such as MinIO/emulators only). This fails closed.
'use strict';

const { AppError, TimeoutError, UpstreamServiceError } = require('./errors');
const { withResilience } = require('./resilience');
const { logger: baseLogger } = require('./logger');

function hasHeader(headers, wanted) {
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

/**
 * Performs one outbound HTTP(S) request under the NFR-09 resilience policy.
 *
 * @param {object}  options
 * @param {string}  options.url            Absolute URL; https:// required (see allowHttp).
 * @param {string}  [options.method='GET']
 * @param {object}  [options.headers]
 * @param {*}       [options.body]         Raw body (string/Buffer), passed through.
 * @param {*}       [options.json]         JSON-serializable body; sets content-type.
 * @param {number}  [options.timeoutMs]    Per-attempt budget (default 3000 in resilience).
 * @param {number}  [options.retries]      Retries after the first attempt (default 2).
 * @param {object}  [options.backoff]      { baseMs, factor, maxMs, jitter }.
 * @param {function}[options.onFallback]   Degraded-mode fallback (NFR-09).
 * @param {function}[options.isRetryable]  Override the transient-error predicate.
 * @param {function}[options.onRetry]      Observer for retry transitions.
 * @param {function}[options.fetchImpl]    Injected fetch (tests use fakes; ADR-007 mock CI).
 * @param {boolean} [options.allowHttp]    Allow http:// outside production (local mocks).
 * @param {string}  [options.name]         Operation name for logs; defaults to "METHOD host".
 * @param {object}  [options.log]          Logger.
 * @returns {Promise<{status:number, headers:*, json:*, text:string}>}
 */
async function request(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    json,
    timeoutMs,
    retries,
    backoff,
    onFallback,
    isRetryable,
    onRetry,
    fetchImpl,
    allowHttp = false,
    name,
    log = baseLogger,
  } = options || {};

  if (!url) throw new TypeError('httpClient.request requires a url');
  const target = new URL(url);

  // HTTPS-only outbound (NFR-03 / ADR-006); http:// is a dev/test-only escape hatch.
  const insecureAllowed = allowHttp === true && process.env.NODE_ENV !== 'production';
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && insecureAllowed)) {
    throw new AppError(
      `Refused outbound request to non-HTTPS URL (${target.protocol}//${target.host})`,
      { status: 500, code: 'INSECURE_OUTBOUND_URL', retryable: false }
    );
  }

  const doFetch = fetchImpl || globalThis.fetch;
  const requestHeaders = { ...headers };
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    if (!hasHeader(requestHeaders, 'content-type')) {
      requestHeaders['content-type'] = 'application/json';
    }
  }

  // Host only — full URLs can carry PII in paths/query strings (SRS §3.4 register).
  const operationName = name || `${method} ${target.host}`;

  return withResilience(
    async ({ signal }) => {
      let response;
      try {
        response = await doFetch(target.toString(), {
          method,
          headers: requestHeaders,
          body: payload,
          signal,
          redirect: 'follow',
        });
      } catch (err) {
        if (signal.aborted) {
          // Timeout fired: surface the TimeoutError that withResilience aborted with.
          throw signal.reason instanceof Error
            ? signal.reason
            : new TimeoutError(`${operationName} timed out`, {});
        }
        throw new UpstreamServiceError(`Network failure calling ${target.host}`, {
          code: 'UPSTREAM_UNREACHABLE',
          retryable: true,
          cause: err,
        });
      }

      const text = await response.text();
      const contentType =
        (response.headers &&
          typeof response.headers.get === 'function' &&
          response.headers.get('content-type')) ||
        '';
      let parsed;
      if (typeof contentType === 'string' && contentType.includes('application/json') && text) {
        try {
          parsed = JSON.parse(text);
        } catch (_err) {
          parsed = undefined; // malformed upstream JSON — callers see raw text
        }
      }

      if (!(response.status >= 200 && response.status < 300)) {
        // Retryability derived from the status inside UpstreamServiceError (5xx/429/408).
        throw new UpstreamServiceError(`${operationName} responded with HTTP ${response.status}`, {
          upstreamStatus: response.status,
        });
      }

      return { status: response.status, headers: response.headers, json: parsed, text };
    },
    { name: operationName, timeoutMs, retries, backoff, onFallback, isRetryable, onRetry, log }
  );
}

module.exports = { request };
