// client/src/App.jsx — application root of the responsive React WEB client (U5-SHELL /
// U5-SHELL-WIRE; SRS §2.1.2 — web, not React Native; SRS wins over SPMP §5.2.1, recorded at
// WA-9). Requirement / decision traceability (SRS Appendix B):
//   NFR-03 / AB-05 — <SessionProvider> is ambient here, at the very top of the tree, so every
//     screen (wave 5 and wave 6 alike) reads response-inferred session state via useSession();
//     no cookie is ever readable and none is ever read (client/src/session).
//   NFR-07 — design tokens (styles/tokens.css) are imported HERE, exactly once, per the UI-kit
//     contract (client/src/ui/index.js): every component references var(--hp-*) and this import
//     is what puts the values in the document. <StatusAnnouncer /> — the app-wide aria-live
//     channel (role="status" polite + role="alert" assertive) — is mounted HERE, exactly once,
//     as a SIBLING of the router rather than inside AppLayout: the root errorElement REPLACES
//     the routed tree (AppLayout included) when rendering fails, and a live region only
//     announces if it already existed in the DOM before its content changed — so the announcer
//     must survive that swap for RootErrorBoundary's announcement (and any later one) to be
//     spoken. It renders BEFORE the router because sibling effects run in order: the
//     announcer's listener must be registered before any first-commit announcement fires
//     (e.g. RootErrorBoundary when the very first route crashes). The regions are empty,
//     visually hidden and never focusable, so the skip link remains the first focusable
//     element (NFR-07 keyboard entry point — pinned by App.test.jsx and the audit harness).
// The mount contract (main.jsx renders <App /> into #root) is unchanged.
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles/tokens.css';
import { SessionProvider } from './session/index.js';
import { StatusAnnouncer } from './ui/index.js';
import routes from './routes.jsx';

const router = createBrowserRouter(routes);

export default function App() {
  return (
    <SessionProvider>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </SessionProvider>
  );
}
