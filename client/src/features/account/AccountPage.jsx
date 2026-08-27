// client/src/features/account/AccountPage.jsx — U6-ACCOUNT-MOD: the /account surface —
// eligibility, profile, data export, account deletion.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-09 / NFR-06 — the proactive EligibilityPanel: both server-computed flags plus the
//     outstanding reason codes with fix paths. This page is also the fix destination other
//     features link to (by the '/account' URL string) when a 403 NOT_ELIGIBLE names
//     NAME_MISSING / PHONE_MISSING / HOST_* codes.
//   NFR-06 — ProfileForm PATCHes /api/users/me; the response's recomputed flags flow
//     straight back into the panel via local state (no second fetch needed), and the
//     ambient session store is refreshed so the shell reflects the same snapshot.
//   NFR-12 — DeleteAccountSection: 202-accepted deletion behind an explicit confirm Dialog
//     naming the 30-day erasure; after acceptance this page shows the confirmation state
//     and the session store re-hydrates to anonymous (the server destroyed the session).
//   NFR-13 — ExportSection: request + retrieval of the §3.4 register copy.
//   NFR-07 — one h1 + document.title; section headings in order; the hydrating state is a
//     labelled spinner and the anonymous state is a real sign-in prompt — never a blank or
//     misleading screen (NFR-03/AB-05: all of it inferred from API responses, no cookie).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../../ui/index.js';
import { useSession } from '../../session/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import EligibilityPanel from './components/EligibilityPanel.jsx';
import ProfileForm from './components/ProfileForm.jsx';
import ExportSection from './components/ExportSection.jsx';
import DeleteAccountSection from './components/DeleteAccountSection.jsx';
import styles from './account.module.css';

/** 'Month D, YYYY' (UTC) for the 202 request's dueAt instant; null when it does not parse. */
function formatDueDate(iso) {
  if (typeof iso !== 'string' || iso === '') return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function AccountPage() {
  usePageTitle('Your account');
  const { user, status, refresh } = useSession();
  // The freshest owner profile: the session snapshot until a PATCH returns a newer one.
  const [savedUser, setSavedUser] = useState(null);
  const [deletionRequest, setDeletionRequest] = useState(null);

  const current = savedUser || user;

  function handleSaved(updated) {
    setSavedUser(updated);
    // Keep the ambient store (header display, other screens) on the same snapshot.
    refresh().catch(() => {});
  }

  function handleDeletionAccepted(request) {
    setDeletionRequest(request);
    // The server destroyed the session with the 202 (AB-05) — re-hydrating answers 401 and
    // flips the store to anonymous, which is the truthful state now.
    refresh().catch(() => {});
  }

  return (
    <>
      <h1>Your account</h1>
      {deletionRequest !== null ? (
        <section aria-labelledby="deletion-accepted-heading" className={styles.section}>
          <h2 id="deletion-accepted-heading">Deletion accepted</h2>
          <p className={styles.noticeBox}>
            Your account deletion was accepted and you have been signed out. Your personal data will
            be permanently erased 30 days after this request
            {/* AMV-W6-04: the server's own dueAt removes any drift from the static number */}
            {formatDueDate(deletionRequest.dueAt) === null
              ? ''
              : ` — scheduled for ${formatDueDate(deletionRequest.dueAt)}`}{' '}
            (NFR-12). You do not need to do anything else.
          </p>
          <p>
            <Link to="/">Back to Homeplate</Link>
          </p>
        </section>
      ) : status === 'unknown' ? (
        <Spinner label="Checking your session" />
      ) : status === 'anonymous' ? (
        <>
          <p className={styles.lead}>
            Your profile, eligibility, data export and account deletion live here.
          </p>
          <p className={styles.noticeBox}>
            You are not signed in. <Link to="/login">Sign in</Link> or{' '}
            <Link to="/signup">create an account</Link> to manage your account.
          </p>
        </>
      ) : (
        <>
          <EligibilityPanel user={current} />
          <section
            id="account-profile"
            aria-labelledby="profile-heading"
            className={styles.section}
          >
            <h2 id="profile-heading">Profile</h2>
            <ProfileForm user={current} onSaved={handleSaved} />
          </section>
          <ExportSection />
          <DeleteAccountSection onAccepted={handleDeletionAccepted} />
        </>
      )}
    </>
  );
}
