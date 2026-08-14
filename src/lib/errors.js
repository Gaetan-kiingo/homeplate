// src/lib/errors.js — U1-OBS error taxonomy (build-plan wave 1).
//
// Requirement traceability (SRS Appendix B):
//   NFR-08 (MT-01) — every AppError carries an HTTP `status` and a machine-readable `code`
//                    so the error handler can log message + stack + correlationId while
//                    returning a structured JSON error WITHOUT a stack trace.
//   NFR-09 (RT-01) — errors carry a `retryable` marker consumed by src/lib/resilience.js
//                    (bounded retries / fallback) and src/lib/httpClient.js.
//
// Contract for other units (build-plan §3): AppError subclasses expose `status` (HTTP),
// `code` (stable machine-readable string), optional `details` (safe, field-level info such
// as validation errors) and optional `retryable`. `toJSON()` is the safe wire shape — it
// NEVER includes the stack. Messages on AppError subclasses are operational and must never
// embed PII (SRS §3.4 PII register: logs and responses carry user IDs only).
'use strict';

class AppError extends Error {
  /**
   * @param {string} message  Operational, PII-free description.
   * @param {object} [options]
   * @param {number} [options.status=500]    HTTP status the error maps to.
   * @param {string} [options.code]          Stable machine-readable code.
   * @param {*}      [options.details]       Safe details for the JSON response body.
   * @param {Error}  [options.cause]         Underlying error (logged, never returned).
   * @param {boolean}[options.retryable]     Hint for withResilience/httpClient.
   */
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details, cause, retryable } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (retryable !== undefined) this.retryable = retryable;
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }

  /** Safe response shape — code/message/details only, never the stack (NFR-08). */
  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/** 422 — input failed schema validation at the API boundary (NFR-11 consumers). */
class ValidationError extends AppError {
  constructor(message = 'Validation failed', options = {}) {
    super(message, { status: 422, code: 'VALIDATION_FAILED', retryable: false, ...options });
  }
}

/** 401 — no valid session (ADR-006 auth boundary consumers). */
class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', options = {}) {
    super(message, { status: 401, code: 'AUTHENTICATION_REQUIRED', retryable: false, ...options });
  }
}

/** 403 — authenticated but not allowed (eligibility/role gates, FR-09 consumers). */
class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options = {}) {
    super(message, { status: 403, code: 'FORBIDDEN', retryable: false, ...options });
  }
}

/** 404 — entity does not exist or is not visible to the caller. */
class NotFoundError extends AppError {
  constructor(message = 'Not found', options = {}) {
    super(message, { status: 404, code: 'NOT_FOUND', retryable: false, ...options });
  }
}

/** 409 — state conflict (duplicate email, capacity race loser, AB-07 consumers). */
class ConflictError extends AppError {
  constructor(message = 'Conflict', options = {}) {
    super(message, { status: 409, code: 'CONFLICT', retryable: false, ...options });
  }
}

/** 429 — rate limited (NFR-05 login throttling consumers). */
class RateLimitError extends AppError {
  constructor(message = 'Too many requests', options = {}) {
    super(message, { status: 429, code: 'RATE_LIMITED', retryable: false, ...options });
  }
}

/** 503 — a dependency is degraded and no fallback could serve the request (NFR-09). */
class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', options = {}) {
    super(message, { status: 503, code: 'SERVICE_UNAVAILABLE', retryable: true, ...options });
  }
}

/** 504 — an outbound call exceeded its budget; produced by withResilience (NFR-09). */
class TimeoutError extends AppError {
  constructor(message = 'Operation timed out', options = {}) {
    const { timeoutMs, ...rest } = options;
    super(message, {
      status: 504,
      code: 'UPSTREAM_TIMEOUT',
      retryable: true,
      details: timeoutMs !== undefined ? { timeoutMs } : undefined,
      ...rest,
    });
    if (timeoutMs !== undefined) this.timeoutMs = timeoutMs;
  }
}

/**
 * 502 — an upstream provider misbehaved. `upstreamStatus` is the provider's HTTP status
 * (null for network-level failures). Retryability defaults to the standard transient set:
 * network failures, 5xx, 429 and 408 retry; other 4xx do not (NFR-09 bounded retries).
 */
class UpstreamServiceError extends AppError {
  constructor(message = 'Upstream service error', options = {}) {
    const { upstreamStatus = null, ...rest } = options;
    const transient =
      upstreamStatus === null ||
      upstreamStatus >= 500 ||
      upstreamStatus === 429 ||
      upstreamStatus === 408;
    super(message, {
      status: 502,
      code: 'UPSTREAM_ERROR',
      retryable: transient,
      details: upstreamStatus !== null ? { upstreamStatus } : undefined,
      ...rest,
    });
    this.upstreamStatus = upstreamStatus;
  }
}

/** 500 — explicit internal failure with a stable code. */
class InternalError extends AppError {
  constructor(message = 'Internal server error', options = {}) {
    super(message, { status: 500, code: 'INTERNAL_ERROR', retryable: false, ...options });
  }
}

function isAppError(err) {
  return err instanceof AppError;
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
  UpstreamServiceError,
  InternalError,
  isAppError,
};
