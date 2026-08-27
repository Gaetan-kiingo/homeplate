// client/src/features/booking/components/EligibilityNotice.jsx — U6-BOOKING: the FR-09
// flagship error surface (SPMP WA-9; UT-01 probes exactly this screen state).
//
// Requirement traceability (SRS Appendix B):
//   FR-09 — a 403 NOT_ELIGIBLE renders one item per reason code saying WHAT is missing and
//     HOW to fix it, each with a working fix: EMAIL_UNVERIFIED gets a real resend action
//     (POST /api/auth/resend-verification via the wave-5 API client) plus the account link;
//     profile gaps link to /account (U6-ACCOUNT-MOD's route — URL string only).
//   NFR-07 — the notice is a labelled section with its own heading (the screens announce the
//     refusal via useAnnounce when they render it); the resend outcome is announced through
//     the same aria-live channel and mirrored as visible text.
//   NFR-03 / AB-05 — the resend email address comes from useSession()'s response-inferred
//     user, never from anything stored client-side.
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/index.js';
import { useSession } from '../../../session/index.js';
import { Button, useAnnounce } from '../../../ui/index.js';
import { ACCOUNT_PATH, bookingErrorMessage, describeEligibilityReasons } from './bookingErrors.js';
import styles from '../booking.module.css';

/** The EMAIL_UNVERIFIED fix: a real resend action with announced, visible outcome. */
function ResendVerification() {
  const { user } = useSession();
  const { announce, announceError } = useAnnounce();
  const [state, setState] = useState({ phase: 'idle', message: '' });
  const email = user && user.email;

  if (!email) {
    // No session email to resend to (e.g. the session just expired): the account page is
    // still a real path to the fix.
    return <Link to={ACCOUNT_PATH}>Verify your email from your account page</Link>;
  }

  async function resend() {
    setState({ phase: 'sending', message: '' });
    try {
      await api.auth.resendVerification(email);
      const message = `Verification email sent to ${email}. Follow the link in it, then try again.`;
      setState({ phase: 'sent', message });
      announce(message);
    } catch (err) {
      const message = bookingErrorMessage(err);
      setState({ phase: 'failed', message });
      announceError(message);
    }
  }

  return (
    <>
      <Button variant="secondary" busy={state.phase === 'sending'} onClick={resend}>
        Resend the verification email
      </Button>
      {state.message !== '' ? (
        <p className={state.phase === 'failed' ? styles.errorText : styles.successText}>
          {state.message}
        </p>
      ) : null}
    </>
  );
}

/**
 * @param {{reasons: string[], actionPhrase: string}} props  reasons = the server's
 *   NOT_ELIGIBLE `details.reasons`; actionPhrase e.g. "reserve a seat".
 */
export default function EligibilityNotice({ reasons, actionPhrase }) {
  const headingId = useId();
  const items = describeEligibilityReasons(reasons);

  return (
    <section aria-labelledby={headingId} className={styles.notice}>
      <h2 id={headingId}>You can&rsquo;t {actionPhrase} yet</h2>
      <p>
        Your account is missing the details below. Fix them, then try again — nothing you entered is
        lost.
      </p>
      <ul className={styles.noticeList}>
        {items.map((item) => (
          <li key={item.code}>
            <p className={styles.noticeWhat}>{item.what}</p>
            <p>{item.how}</p>
            {item.resend ? <ResendVerification /> : null}
            <p>
              <Link to={item.fixPath}>{item.fixLabel}</Link>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
