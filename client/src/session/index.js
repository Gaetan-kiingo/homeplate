// client/src/session/index.js — U5-API-CLIENT: the published wave-5 session interface
// (build-plan §6.1 5B): `import { SessionProvider, useSession } from '../session/index.js'`.
// See SessionProvider.jsx for the NFR-03/AB-05 response-inferred-state contract.
export { default as SessionProvider } from './SessionProvider.jsx';
export { default as useSession } from './useSession.js';
export { default as useOptionalSession } from './useOptionalSession.js';
