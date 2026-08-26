// client/src/session/SessionProvider.jsx — U5-API-CLIENT: cookie-free session state
// (build-plan §6.1 5B behaviour 1). 5C (U5-SHELL-WIRE) wraps the app in this provider.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-03 / AB-05 — the session cookie is opaque, HttpOnly, Secure, SameSite=Lax; Redis
//     stores only its SHA-256 digest. JavaScript CANNOT read it and never tries (the grep
//     gate over client/src pins zero document-cookie references). Authentication state is
//     INFERRED FROM API RESPONSES ONLY:
//       - hydration: GET /api/users/me → 200 = 'authenticated', 401 = 'anonymous';
//       - every API 401 anywhere broadcasts session-expired (src/api/http.js →
//         src/api/sessionEvents.js) and this store flips to 'anonymous';
//       - login/logout flip the store from their own typed responses.
//   NFR-07 (groundwork) — `status` is a three-state machine ('unknown' | 'authenticated' |
//     'anonymous'), so shells and screens can render a real loading state instead of
//     flashing anonymous UI at an authenticated user; login/logout failures propagate as
//     typed ApiError codes for per-code aria-live messaging.
//   NFR-09 — a transport failure during hydration leaves status 'unknown' (the truthful
//     answer) rather than guessing; refresh() lets the shell retry explicitly.
//   AB-08 — `user` is exactly the owner-profile allowlist from GET /api/users/me
//     (src/api/types.js SessionUser); nothing is derived or widened here.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, onSessionExpired } from '../api/index.js';
import { SessionContext } from './context.js';

/**
 * Provides { user, status, login, logout, refresh } to the tree.
 *
 * Contract (published wave-5 interface):
 *   status  'unknown' (hydrating / unreachable) | 'authenticated' | 'anonymous'
 *   user    SessionUser when authenticated, null otherwise
 *   login({ email, password })  resolves with the user; rejects with ApiError (typed code)
 *   logout()                    always leaves the store 'anonymous'; rejects only on
 *                               non-401 failure (the cookie may then still be live)
 *   refresh()                   re-hydrates from GET /api/users/me; resolves user or null
 *
 * @param {{children: import('react').ReactNode}} props
 */
export default function SessionProvider({ children }) {
  const [state, setState] = useState({ user: null, status: 'unknown' });

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.users.me();
      setState({ user, status: 'authenticated' });
      return user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The normal anonymous answer, not a failure (the 401 also broadcast — same flip).
        setState({ user: null, status: 'anonymous' });
        return null;
      }
      throw err;
    }
  }, []);

  const login = useCallback(async (credentials) => {
    const { user } = await api.auth.login(credentials);
    setState({ user, status: 'authenticated' });
    return user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch (err) {
      // 401 = the session was already dead; that IS a completed logout.
      if (!(err instanceof ApiError && err.status === 401)) throw err;
    } finally {
      setState({ user: null, status: 'anonymous' });
    }
  }, []);

  // Hydrate once on mount. A transport failure (API unreachable) keeps status 'unknown' —
  // deliberately not 'anonymous': we do not KNOW, and the shell can offer retry via
  // refresh() (NFR-09: degrade to a truthful state, never a guess).
  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  // Any API 401 anywhere (expired/destroyed session) flips the store — response-inferred
  // auth state, never a cookie read (NFR-03/AB-05).
  useEffect(() => onSessionExpired(() => setState({ user: null, status: 'anonymous' })), []);

  const value = useMemo(
    () => ({ user: state.user, status: state.status, login, logout, refresh }),
    [state, login, logout, refresh]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
