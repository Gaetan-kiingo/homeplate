// client/src/layout/AppLayout.jsx — the application layout every route renders inside
// (U5-SHELL / U5-SHELL-WIRE; SRS §2.1.2 responsive WEB client, WA-9). Requirement traceability:
//   NFR-07 (built in now, audited in wave 7; build-plan §6.1 5A.4 + 5C.1):
//     - skip-to-content link is the FIRST focusable element and targets #main;
//     - semantic landmarks: <header>, labelled <nav aria-label="Primary">,
//       <main id="main" tabIndex={-1}> (programmatic focus target), <footer>;
//     - focus moves to #main on every ROUTE CHANGE (never on initial load, so the first
//       Tab still lands on the skip link) — screen-reader users hear the new page instead
//       of being stranded on a stale control;
//     - responsive to 320 px with no horizontal scroll (fluid max-width containers, wrapping
//       flex header — AppLayout.module.css, on the UI-kit tokens since 5C).
//   NFR-03 / AB-05 — the nav is session-aware through useSession() ONLY: state inferred from
//     API responses by the ambient SessionProvider (App.jsx), never from a cookie read. This
//     is login-state DISPLAY only ("Signed in as …" / "Not signed in"); the auth screens and
//     their nav links are wave 6, so no dead links ship now. While the session is still
//     hydrating (status 'unknown') the nav shows NOTHING about the session — never a wrong
//     guess flashed at an authenticated user (and nothing to mis-announce, NFR-07).
import { useEffect, useRef } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../session/index.js';
import styles from './AppLayout.module.css';

/** Login-state display for the header nav (5C: display only — auth screens are wave 6). */
function sessionLabel(status, user) {
  if (status === 'authenticated') {
    // SessionUser.fullName is part of the AB-08 owner-profile allowlist; the email fallback
    // only guards a blank name, it derives nothing new.
    return `Signed in as ${user.fullName || user.email}`;
  }
  if (status === 'anonymous') {
    return 'Not signed in';
  }
  return null; // 'unknown' — still hydrating (or API unreachable): claim nothing.
}

export default function AppLayout() {
  const location = useLocation();
  const { user, status } = useSession();
  const mainRef = useRef(null);
  // The history key of the entry the app LOADED on. Comparing keys (instead of a boolean
  // first-render flag) keeps the effect idempotent under React 18 StrictMode's double
  // mount, so initial load never steals focus from the document start / skip link.
  const initialKeyRef = useRef(location.key);

  useEffect(() => {
    if (location.key === initialKeyRef.current) {
      return; // initial load — leave focus at the document start (skip link is first).
    }
    if (mainRef.current) {
      mainRef.current.focus(); // route change — announce the new page (NFR-07).
    }
  }, [location.key]);

  const label = sessionLabel(status, user);

  return (
    <>
      <a className={styles.skipLink} href="#main">
        Skip to main content
      </a>
      <header className={styles.header}>
        <nav aria-label="Primary" className={styles.nav}>
          <Link className={styles.brand} to="/">
            Homeplate
          </Link>
          {label !== null && <span className={styles.sessionStatus}>{label}</span>}
        </nav>
      </header>
      <main id="main" tabIndex={-1} ref={mainRef} className={styles.main}>
        <Outlet />
      </main>
      <footer className={styles.footer}>
        <p>Homeplate v1.0 — MSCS 2101 Group 6 prototype.</p>
      </footer>
    </>
  );
}
