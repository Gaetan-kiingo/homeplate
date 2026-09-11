import { useContext } from 'react';
import { SessionContext } from './context.js';

/**
 * Read the session store when one is mounted, or null when it is not. For screens whose
 * PRIMARY job does not need a session (the listing detail page renders for any signed-in
 * viewer and is unit-tested without a provider) but that add owner-only affordances when
 * the viewer happens to be the listing's host (FR-11 manage actions, 2026-09-11).
 * useSession() stays the strict variant for screens that cannot work without the store.
 * @returns {?{user: ?object, status: 'unknown'|'authenticated'|'anonymous'}}
 */
export default function useOptionalSession() {
  return useContext(SessionContext);
}
