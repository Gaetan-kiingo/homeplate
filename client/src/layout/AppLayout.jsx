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
//   NAVIGABILITY (fixed 2026-08-27) — wave 5 shipped this nav deliberately link-free, on the
//     note that "the auth screens and their nav links are wave 6, so no dead links ship now".
//     Wave 6 built all seven interfaces but every one of its units was scoped to
//     client/src/features/**, so nobody owned this file and the links were never added: the
//     app shipped with seven screens reachable only by typing a URL. A human opening the front
//     door found it in seconds; no lane did, because each verified its own screen AT its route
//     and none asked "can a user GET here?". Links are now derived from the session state and
//     only ever point at routes that exist.
//   NFR-03 / AB-05 — the nav is session-aware through useSession() ONLY: state inferred from
//     API responses by the ambient SessionProvider (App.jsx), never from a cookie read. This
//     is login-state DISPLAY only ("Signed in as …" / "Not signed in"); the auth screens and
//     their nav links are wave 6, so no dead links ship now. While the session is still
//     hydrating (status 'unknown') the nav shows NOTHING about the session — never a wrong
//     guess flashed at an authenticated user (and nothing to mis-announce, NFR-07).
import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../session/index.js';
import styles from './AppLayout.module.css';

/** Initials for the account avatar — first letters of the first two words of the name,
 *  falling back to the email's first character. Purely visual: the accessible name beside it
 *  is the real one, so nothing depends on parsing a person's name correctly. */
function initialsFor(user) {
  const name = (user?.fullName || '').trim();
  if (name) {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }
  const email = (user?.email || '').trim();
  return email ? email[0].toUpperCase() : '';
}

/** True when the signed-in user may reach the FR-08 moderator queue. */
function isModerator(user) {
  return Array.isArray(user?.roles) && user.roles.includes('moderator');
}

/** Login-state display for the header nav. */
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
            {/* Brand mark: a plate, drawn inline so it ships with the app (design review §4:
                "a small self-hosted icon set … without introducing a heavy framework"). It is
                decorative; the word beside it is the accessible name. */}
            <span className={styles.brandMark} aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="5" />
              </svg>
            </span>
            Homeplate
          </Link>

          {/* Primary destinations. Rendered only once the session is resolved, so an
              authenticated user never sees a sign-in link flash first (and vice versa). */}
          {status !== 'unknown' && (
            <ul className={styles.navList}>
              <li>
                <NavLink to="/search">Find a meal</NavLink>
              </li>
              {status === 'authenticated' && (
                <>
                  <li>
                    <NavLink to="/bookings">Your bookings</NavLink>
                  </li>
                  <li>
                    <NavLink to="/account">Account</NavLink>
                  </li>
                  {user && user.canPublishListing === true && (
                    <li>
                      <NavLink to="/host/meals">Your meals</NavLink>
                    </li>
                  )}
                  {isModerator(user) && (
                    <li>
                      <NavLink to="/moderation">Moderation</NavLink>
                    </li>
                  )}
                </>
              )}
            </ul>
          )}

          {/* Account treatment (design review §3E): initials avatar plus the person's name,
              linking to the account page — not the prototype's "Signed in as <name>" string.
              The avatar is decorative; the link text carries the accessible name. */}
          {status === 'authenticated' && (
            <Link className={styles.account} to="/account">
              <span className={styles.avatar} aria-hidden="true">
                {initialsFor(user)}
              </span>
              <span className={styles.accountName}>{user?.fullName || user?.email}</span>
            </Link>
          )}
          {status === 'anonymous' && (
            <>
              <span className={styles.sessionStatus}>{label}</span>
              <Link className={styles.navAuth} to="/login">
                Sign in
              </Link>
            </>
          )}
        </nav>
      </header>
      <main id="main" tabIndex={-1} ref={mainRef} className={styles.main}>
        <Outlet />
      </main>
      <footer className={styles.footer}>
        <p className={styles.footerBrand}>Homeplate</p>
        <p>Home-cooked meals, shared locally. v1.0 — MSCS 2101, Group 6.</p>
      </footer>
    </>
  );
}
