// client/src/features/account/VerifyEmailPage.jsx — U6-ACCOUNT-MOD: consumes the mailed
// FR-10 verification link.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 — the emailed link lands here carrying ?token=…; the SPA relays it to
//     POST /api/auth/verify-email exactly once (the token is single-use — a ref holds the one
//     in-flight redemption so StrictMode's dev-only double effect neither burns the token nor
//     orphans the response) and flips to the success state on { emailVerified: true }. A wrong/used/expired token is the
//     server's 400 INVALID_VERIFICATION_TOKEN, rendered honestly with the recovery path
//     (ResendVerificationForm — always-202, AB-05).
//   NFR-06 — on success the session store is refreshed so a signed-in user's eligibility
//     panel (/account) reflects the verified email without a manual reload.
//   NFR-07 — one h1 + document.title; each state (verifying/success/failure/missing) is
//     real rendered text, announced via the shell's aria-live channel; the spinner names
//     what is loading.
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Spinner, useAnnounce } from '../../ui/index.js';
import { useSession } from '../../session/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import { api } from '../../api/index.js';
import { messageForAccountError } from './components/errorCopy.js';
import ResendVerificationForm from './components/ResendVerificationForm.jsx';
import styles from './account.module.css';

export default function VerifyEmailPage() {
  usePageTitle('Verify your email');
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const { refresh } = useSession();
  const { announce, announceError } = useAnnounce();
  // 'missing' | 'verifying' | 'success' | 'failure'
  const [state, setState] = useState(token !== '' ? 'verifying' : 'missing');
  const [failureMessage, setFailureMessage] = useState(null);
  // The single in-flight redemption for the current token: { token, promise }. Kept in a ref
  // so the token is POSTed exactly once (single-use, FR-10) no matter how many times the
  // effect runs — and so that EVERY run re-attaches to the same promise.
  //
  // FIXED 2026-09-11 (found by clicking a real SendGrid link in `npm run dev`): the previous
  // version guarded the double POST with a "already redeemed" ref but ALSO set `cancelled`
  // in the effect cleanup. Under React.StrictMode (client/src/main.jsx, dev only) the effect
  // runs → cleans up → runs again before the response arrives: run 1 started the request and
  // its cleanup marked it cancelled; run 2 saw the token already redeemed and returned early
  // without subscribing. The 200 then arrived to a handler that had been told to ignore it,
  // and the page span forever on "Verifying your email address" while the server had already
  // verified the account. The spec suite never rendered under StrictMode, so it stayed green.
  const redemptionRef = useRef(null);

  useEffect(() => {
    if (token === '') {
      return undefined;
    }
    if (!redemptionRef.current || redemptionRef.current.token !== token) {
      redemptionRef.current = { token, promise: api.auth.verifyEmail(token) };
    }
    let cancelled = false;
    setState('verifying');
    redemptionRef.current.promise
      .then(() => {
        if (cancelled) return;
        setState('success');
        announce('Your email address is verified. You can now sign in.');
        // NFR-06: a signed-in user's eligibility flags change with verification — refresh
        // the session snapshot; for an anonymous visitor this resolves as a harmless 401.
        refresh().catch(() => {});
      })
      .catch((err) => {
        if (cancelled) return;
        const message = messageForAccountError(err);
        setState('failure');
        setFailureMessage(message);
        announceError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [token, announce, announceError, refresh]);

  return (
    <>
      <h1>Verify your email</h1>
      {state === 'verifying' && <Spinner label="Verifying your email address" />}
      {state === 'success' && (
        <>
          <p className={styles.noticeBox}>
            Your email address is verified. <Link to="/login">Sign in</Link> to continue — or, if
            you are already signed in, check your{' '}
            <Link to="/account">eligibility on the account page</Link>.
          </p>
        </>
      )}
      {state === 'failure' && (
        <>
          <p className={styles.errorBox}>{failureMessage}</p>
          <ResendVerificationForm />
        </>
      )}
      {state === 'missing' && (
        <>
          <p className={styles.lead}>
            This page finishes Homeplate&apos;s email verification (FR-10). Open the verification
            link from your email and it will land here with its token. Lost the email, or did the
            link expire? Request a new one below.
          </p>
          <ResendVerificationForm />
        </>
      )}
    </>
  );
}
