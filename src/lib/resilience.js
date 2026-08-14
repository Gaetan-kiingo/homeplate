// src/lib/resilience.js — U1-OBS timeout / bounded-retry / exponential-backoff / fallback
// wrapper (build-plan wave 1). EVERY external adapter call (Maps, SendGrid, FCM, moderation
// LLM, object storage — ADR-005/007/011, ADR-004) goes through withResilience, and only
// worker/outbox code may reach those adapters in the first place (ADR-001/003).
//
// Requirement traceability (SRS Appendix B):
//   NFR-09 (RT-01) — enforces a per-attempt timeout (default 3000 ms per the requirements
//                    inventory), bounded retries with exponential backoff, and a documented
//                    fallback invoked once attempts are exhausted (cache read, deferral,
//                    degraded-mode result). No unbounded retry loops.
//   NFR-08 (MT-01) — retry and fallback transitions are logged as structured events with
//                    the operation name, attempt number and delay; IDs only, never PII.
//
// Contract (build-plan §3 public interfaces):
//   await withResilience(fn, { timeoutMs, retries, backoff, onFallback, ... })
//   `fn` receives ({ attempt, signal }) — `signal` is an AbortSignal that fires on timeout
//   so HTTP calls can be cancelled instead of leaking sockets.
'use strict';

const { TimeoutError } = require('./errors');
const { logger: baseLogger } = require('./logger');

// Default per-attempt budget (NFR-09 acceptance: "timeout (default 3000 ms)").
// Adapters may override from config (config.adapters.timeoutMs) — this module stays
// config-independent so wave-1 units have no cross-unit load-order coupling.
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRIES = 2;

/**
 * Delay before the retry that follows failed attempt `attempt` (1-indexed):
 * baseMs * factor^(attempt-1), capped at maxMs, plus optional random jitter.
 * Jitter defaults to 0 so behaviour is deterministic under fake timers.
 */
function computeBackoffDelay(
  attempt,
  { baseMs = 200, factor = 2, maxMs = 30000, jitter = 0 } = {}
) {
  const exponential = baseMs * Math.pow(factor, attempt - 1);
  let delay = Math.min(exponential, maxMs);
  if (jitter > 0) delay += Math.round(Math.random() * delay * jitter);
  return delay;
}

/** Retry unless the error explicitly opts out (AppError subclasses set `retryable`). */
function defaultIsRetryable(err) {
  return !err || err.retryable !== false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` under a timeout with bounded retries, exponential backoff and an optional
 * fallback, returning fn's result (or the fallback's).
 *
 * @param {function({attempt: number, signal: AbortSignal}): Promise<*>|*} fn
 * @param {object}   [options]
 * @param {string}   [options.name]        Operation name for log lines (no PII, no URLs with paths).
 * @param {number}   [options.timeoutMs]   Per-attempt budget in ms (default: DEFAULT_TIMEOUT_MS;
 *                                         0/null disables the timer).
 * @param {number}   [options.retries=2]   Retries AFTER the first attempt (total = retries + 1).
 * @param {object}   [options.backoff]     { baseMs=200, factor=2, maxMs=30000, jitter=0 }.
 * @param {function} [options.onFallback]  Called with the final error once attempts are
 *                                         exhausted (or the error is non-retryable); its
 *                                         return value becomes the result. Omitted → rethrow.
 * @param {function} [options.isRetryable] Predicate deciding whether an error may retry.
 * @param {function} [options.onRetry]     Observer: ({ attempt, delayMs, error }).
 * @param {object}   [options.log]         Logger; defaults to the shared instance.
 */
async function withResilience(fn, options = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError('withResilience(fn, options): fn must be a function');
  }
  const {
    name = fn.name || 'operation',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    backoff = {},
    onFallback,
    isRetryable = defaultIsRetryable,
    onRetry,
    log = baseLogger,
  } = options;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new TypeError('withResilience: retries must be a non-negative integer');
  }

  const totalAttempts = retries + 1;
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const controller = new AbortController();
    let timer = null;
    attemptsMade = attempt;
    try {
      const result = await new Promise((resolve, reject) => {
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            const timeoutError = new TimeoutError(`${name} timed out after ${timeoutMs} ms`, {
              timeoutMs,
            });
            controller.abort(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
        }
        // The .then(resolve, reject) chain also swallows a late rejection after a
        // timeout has already settled this promise — no unhandled rejection leaks.
        Promise.resolve()
          .then(() => fn({ attempt, signal: controller.signal }))
          .then(resolve, reject);
      });
      if (timer) clearTimeout(timer);
      return result;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastError = err;
      if (attempt >= totalAttempts || !isRetryable(err)) break;
      const delayMs = computeBackoffDelay(attempt, backoff);
      if (onRetry) onRetry({ attempt, delayMs, error: err });
      log.warn(
        { event: 'resilience_retry', operation: name, attempt, delayMs, code: err && err.code },
        `${name} failed (attempt ${attempt}/${totalAttempts}); retrying in ${delayMs} ms`
      );
      await sleep(delayMs);
    }
  }

  if (typeof onFallback === 'function') {
    // Degraded mode (NFR-09): exhausted or non-retryable — serve cache/deferral instead.
    log.warn(
      {
        event: 'resilience_fallback',
        operation: name,
        attempts: attemptsMade,
        code: lastError && lastError.code,
        err: lastError,
      },
      `${name} exhausted ${attemptsMade} attempt(s); invoking fallback`
    );
    return onFallback(lastError);
  }
  throw lastError;
}

module.exports = {
  withResilience,
  computeBackoffDelay,
  defaultIsRetryable,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
};
