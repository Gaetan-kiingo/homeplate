// client/src/session/context.js — U5-API-CLIENT: the React context object behind
// SessionProvider/useSession, in its own module so the provider and the hook can live in
// separate files without a cycle.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-03 / AB-05 — the context VALUE never contains a token or cookie: session state is
//     { user, status } inferred from API responses only (see SessionProvider.jsx).
import { createContext } from 'react';

/** null until a <SessionProvider> mounts — useSession() treats null as a usage error. */
export const SessionContext = createContext(null);
