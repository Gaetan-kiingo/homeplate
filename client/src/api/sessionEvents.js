// client/src/api/sessionEvents.js — U5-API-CLIENT: the session-expired broadcast channel
// (build-plan §6.1 5B behaviour 1).
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-03 / AB-05 — the session cookie is opaque and HttpOnly; JavaScript can NEVER read
//     it, so authentication state is *inferred from API responses only*. Every API 401
//     (src/api/http.js) is broadcast here, and client/src/session/SessionProvider.jsx flips
//     the store to 'anonymous' — no cookie read, no polling, no guessing.
//
// Deliberately a plain listener set (not window events): it works identically in the
// browser and under vitest/jsdom, and nothing outside this module can forge a dispatch
// target name.

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Subscribe to session-expired broadcasts.
 * @param {() => void} listener
 * @returns {() => void} unsubscribe — shaped for direct use as a React effect cleanup.
 */
export function onSessionExpired(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('onSessionExpired: listener must be a function');
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Broadcast that the API answered 401 — the session (if any) is gone. Called by the core
 * fetch wrapper only; listeners run isolated so one throwing listener cannot starve another.
 */
export function emitSessionExpired() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener failure must never break the API call that triggered the broadcast.
    }
  }
}
