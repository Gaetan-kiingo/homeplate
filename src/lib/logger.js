// src/lib/logger.js — U1-OBS structured JSON logging with correlation propagation and
// PII redaction (build-plan wave 1; SPMP WA-10 substrate).
//
// Requirement traceability (SRS Appendix B):
//   NFR-08 (MT-01) — every line is structured JSON with `level`, ISO `time`, `msg` and any
//                    bound `correlationId`; `audit()` emits the MT-01 audit record shape
//                    (event, actor user ID, subject entity ID, outcome, timestamp).
//   SRS §3.4 PII register — "Logs: user IDs only, never PII". A defence-in-depth redaction
//                    pass rewrites password/email/phone/name/address/secret fields to
//                    [REDACTED] in log objects AND child bindings, and scrubs anything that
//                    looks like an email address out of message strings and error stacks.
//
// Contract for other units (build-plan §3 public interfaces):
//   const { logger } = require('../lib/logger');
//   const log = logger.child({ correlationId });   // .info/.warn/.error/.debug
//   audit(log, { event, actorUserId, entityType, entityId, outcome, ...safeExtras });
//
// Redaction is a safety net, not a licence: modules must still log IDs only.
'use strict';

const pino = require('pino');

const REDACTED = '[REDACTED]';

// Matches RFC-5322-ish addresses; used to scrub emails out of free-text strings
// (messages, error messages, stack traces) as belt-and-braces for the PII register.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Keys are normalized (lowercased, punctuation stripped) before matching, so
// `userEmail`, `user_email` and `user-email` all hit the same rule.
const EXACT_PII_KEYS = new Set([
  // credentials / secrets (ADR-006)
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'passphrase',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  // contact identity (SRS §3.4 account identity + emergency contact)
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'mobile',
  'tel',
  'name',
  'firstname',
  'lastname',
  'fullname',
  'displayname',
  'middlename',
  'username',
  'legalname',
  'emergencycontact',
  // location identity (ADR-010 — host street address is protected data)
  'address',
  'streetaddress',
  'street',
  'addressline1',
  'addressline2',
]);

// Composed keys (guestEmail, contactPhone, hostName, csrfToken, …) are caught by suffix.
const PII_KEY_SUFFIXES = ['password', 'email', 'phone', 'name', 'token', 'secret'];

// Operational keys that end in a PII suffix but are not personal data. Deliberately
// NOT including `hostname`: in this domain "host" is a person, so `hostName` is PII.
const SAFE_KEY_ALLOWLIST = new Set([
  'eventname',
  'filename',
  'fieldname',
  'tablename',
  'columnname',
  'indexname',
  'constraintname',
  'queuename',
  'routename',
  'modulename',
  'templatename',
  'bucketname',
]);

function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isPiiKey(key) {
  const normalized = normalizeKey(key);
  if (SAFE_KEY_ALLOWLIST.has(normalized)) return false;
  if (EXACT_PII_KEYS.has(normalized)) return true;
  return PII_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function scrubString(value) {
  return value.replace(EMAIL_PATTERN, REDACTED);
}

/** Serializes an Error to a plain object (type/message/stack + own props), scrubbed. */
function errSerializer(err) {
  if (!(err instanceof Error)) return err;
  const serialized = pino.stdSerializers.err(err);
  if (serialized && typeof serialized === 'object') {
    if (typeof serialized.message === 'string')
      serialized.message = scrubString(serialized.message);
    if (typeof serialized.stack === 'string') serialized.stack = scrubString(serialized.stack);
  }
  return serialized;
}

/**
 * Deep-redacts PII from a value about to be logged. Returns a NEW structure — the input
 * is never mutated (callers keep their data intact). Values under PII keys are replaced
 * wholesale with [REDACTED]; email-shaped substrings are scrubbed from every string.
 */
function redactPii(value, seen, depth) {
  seen = seen || new WeakSet();
  depth = depth || 0;
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  if (depth >= 10) return '[MAX_DEPTH]';
  if (value instanceof Error) return errSerializer(value);
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((item) => redactPii(item, seen, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // Dates, Buffers, streams, class instances: leave to pino's own serialization.
    return value;
  }
  seen.add(value);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isPiiKey(key) ? REDACTED : redactPii(entry, seen, depth + 1);
  }
  return out;
}

/**
 * Ensures child bindings are redacted: pino applies `formatters.bindings` only to the
 * root logger's base bindings, never to `child()` bindings (verified against pino 9.x),
 * so the child method is wrapped. `pinoChild` is pino's genuine child implementation and
 * is invoked on the CURRENT instance (`this`) — pino children are created with
 * Object.create(parent), so a parent-bound copy would silently re-parent grandchildren
 * and drop intermediate bindings such as correlationId.
 */
function wrapChildRedaction(instance, pinoChild) {
  instance.child = function child(bindings, childOptions) {
    return wrapChildRedaction(
      pinoChild.call(this, redactPii(bindings || {}), childOptions),
      pinoChild
    );
  };
  return instance;
}

/**
 * @param {object} [options]
 * @param {string} [options.level]   pino level; defaults to LOG_LEVEL, or `silent` in test.
 * @param {object} [options.stream]  destination with a write(line) method (tests inject a sink).
 * @param {object} [options.base]    extra base bindings (redacted like everything else).
 */
function createLogger({ level, stream, base } = {}) {
  const options = {
    level: level || process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    base: { service: 'homeplate', ...(base || {}) },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => redactPii(bindings),
      log: (obj) => redactPii(obj),
    },
    hooks: {
      // Scrubs email-shaped substrings out of message strings and interpolation args.
      logMethod(inputArgs, method) {
        const args = inputArgs.map((arg) => (typeof arg === 'string' ? scrubString(arg) : arg));
        return method.apply(this, args);
      },
    },
    serializers: { err: errSerializer, error: errSerializer },
  };
  const instance = stream ? pino(options, stream) : pino(options);
  // Capture pino's untouched child implementation before shadowing it on the instance.
  return wrapChildRedaction(instance, instance.child);
}

/**
 * Emits the NFR-08 / MT-01 audit record: one structured JSON line carrying the event
 * name, actor user ID, subject entity type/ID and outcome; timestamp and correlationId
 * come from the logger itself (use a request- or job-scoped child). IDs only — any PII
 * accidentally passed in `extra` is redacted by the logger pipeline.
 *
 * @param {object} log   A logger (usually `req.log` or a worker job child).
 * @param {object} fields  { event, outcome, actorUserId, entityType, entityId, ...extra }
 */
function audit(log, fields) {
  if (!log || typeof log.info !== 'function') {
    throw new TypeError('audit(log, fields) requires a logger with .info');
  }
  const { event, outcome, actorUserId, entityType, entityId, ...extra } = fields || {};
  if (!event || typeof event !== 'string') {
    throw new TypeError('audit record requires a non-empty string `event`');
  }
  if (!outcome || typeof outcome !== 'string') {
    throw new TypeError('audit record requires a non-empty string `outcome`');
  }
  log.info({ audit: true, event, outcome, actorUserId, entityType, entityId, ...extra }, event);
}

// Shared default instance. Modules bind request/job context via logger.child({...}).
const logger = createLogger();

module.exports = { logger, createLogger, audit, redactPii, isPiiKey, REDACTED };
