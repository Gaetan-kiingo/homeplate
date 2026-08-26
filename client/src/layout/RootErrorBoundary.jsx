// client/src/layout/RootErrorBoundary.jsx — the top-level error boundary (U5-SHELL;
// build-plan §6.1 5A.3). Mounted as `errorElement` on the ROOT route, so it catches render
// and loader errors from every page AND from AppLayout itself. Because it replaces the whole
// tree when AppLayout is the thing that failed, it renders its OWN complete landmark
// structure (NFR-07: skip link, header/nav/main/footer, exactly one h1, document.title) —
// an error must never land the user on a landmark-free page. Since 5C (U5-SHELL-WIRE) the
// boundary ALSO announces through the UI kit's assertive aria-live region (NFR-07: "errors
// are announced via aria-live"): the <StatusAnnouncer /> lives in App.jsx as a SIBLING of
// the router, so it is still mounted — and was in the DOM before this content change —
// when the routed tree it replaces has crashed.
// Every control here is real: a home link (full document load, which also clears whatever
// client state caused the failure). No dead links.
import { useEffect } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { useAnnounce } from '../ui/index.js';
import usePageTitle from './usePageTitle.js';
import styles from './AppLayout.module.css';

export default function RootErrorBoundary() {
  const error = useRouteError();
  const { announceError } = useAnnounce();
  usePageTitle('Something went wrong');

  useEffect(() => {
    // Diagnosability: the full error goes to the console, never to the page (no stack
    // traces or internals in user-facing copy).
    console.error('Homeplate shell: unhandled route error', error);
  }, [error]);

  useEffect(() => {
    // NFR-07: say what the page shows — assistive tech must not depend on a visual scan to
    // learn the app fell over. Same wording as the visible copy, no internals.
    announceError(
      'Something went wrong: Homeplate hit an unexpected error and could not draw this page.'
    );
  }, [announceError, error]);

  const status = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : null;

  return (
    <>
      <a className={styles.skipLink} href="#main">
        Skip to main content
      </a>
      <header className={styles.header}>
        <nav aria-label="Primary" className={styles.nav}>
          {/* Plain anchor on purpose: a full reload recovers from broken client state. */}
          <a className={styles.brand} href="/">
            Homeplate
          </a>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className={styles.main}>
        <h1>Something went wrong</h1>
        <p>
          Homeplate hit an unexpected error and could not draw this page. Nothing you did caused it,
          and nothing you submitted was lost silently — if you were in the middle of something, it
          is safe to try again.
        </p>
        {status ? <p>Error reference: {status}</p> : null}
        <p>
          <a href="/">Reload Homeplate and return to the home page</a>
        </p>
      </main>
      <footer className={styles.footer}>
        <p>Homeplate v1.0 — MSCS 2101 Group 6 prototype.</p>
      </footer>
    </>
  );
}
