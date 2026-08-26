// client/src/session/useSession.js — U5-API-CLIENT: the hook side of the published session
// interface (build-plan §6.1 5B behaviour 1).
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-03 / AB-05 — consumers get response-inferred { user, status } and the
//     login/logout/refresh actions; no token, no cookie, nothing readable to exfiltrate.
import { useContext } from 'react';
import { SessionContext } from './context.js';

/**
 * Read the session store.
 * @returns {{user: ?import('../api/types.js').SessionUser,
 *            status: 'unknown'|'authenticated'|'anonymous',
 *            login: (credentials: {email: string, password: string}) => Promise<object>,
 *            logout: () => Promise<void>,
 *            refresh: () => Promise<?object>}}
 */
export default function useSession() {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used inside <SessionProvider> (client/src/session)');
  }
  return value;
}
