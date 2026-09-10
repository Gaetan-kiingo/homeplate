// client/src/features/account/LoginPage.jsx — U6-ACCOUNT-MOD: the sign-in screen (half of
// the NFR-07 "signup/login" interface).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10  — the session-start half of the account lifecycle: POST /api/auth/login via the
//     wave-5 session store (useSession().login — the HttpOnly cookie is set server-side and
//     never read here, NFR-03/AB-05).
//   NFR-05 — the 429 LOGIN_RATE_LIMITED answer renders the HONEST lockout message: what locked,
//     why, and when to retry (details.retryAfterSeconds), via loginLockoutMessage().
//   NFR-07 — one h1 + document.title; both fields labelled through FormField with stable
//     ids; client-side omissions render as a focus-taking ErrorSummary linking each field;
//     server failures render one message per typed code AND are announced through the
//     shell's aria-live channel (useAnnounce). No error is ever a stringified body.
// After success the user lands on the screen that sent them here (location.state.from — the
// cross-feature 401-redirect contract) or /account.
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, ErrorSummary, FormField, TextInput, useAnnounce } from '../../ui/index.js';
import { useSession } from '../../session/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import {
  isThrottleError,
  loginLockoutMessage,
  messageForAccountError,
} from './components/errorCopy.js';
import styles from './account.module.css';

export default function LoginPage() {
  usePageTitle('Sign in');
  const { user, status, login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { announce, announceError } = useAnnounce();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState([]);
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);

  const errorFor = (fieldId) => {
    const hit = fieldErrors.find((entry) => entry.fieldId === fieldId);
    return hit ? hit.message : undefined;
  };

  async function handleSubmit(event) {
    event.preventDefault();
    setServerError(null);
    const errors = [];
    if (email.trim() === '') {
      errors.push({ fieldId: 'login-email', message: 'Enter your email address' });
    }
    if (password === '') {
      errors.push({ fieldId: 'login-password', message: 'Enter your password' });
    }
    setFieldErrors(errors);
    if (errors.length > 0) {
      return; // the ErrorSummary takes focus and announces (role="alert")
    }
    setBusy(true);
    try {
      const signedIn = await login({ email: email.trim(), password });
      announce(`Signed in as ${signedIn.fullName || signedIn.email}.`);
      const from = location.state && typeof location.state.from === 'string' && location.state.from;
      navigate(from || '/account', { replace: true });
    } catch (err) {
      // NFR-05: any 429 on the login path IS the lockout — the live code is
      // LOGIN_RATE_LIMITED, matched as the status family (finding AMV-W6-01) — named
      // honestly with the retry horizon from the envelope.
      const message = isThrottleError(err) ? loginLockoutMessage(err) : messageForAccountError(err);
      setServerError(message);
      announceError(message);
    } finally {
      setBusy(false);
    }
  }

  // Already signed in: say so instead of offering a second sign-in (response-inferred state
  // only — while the session is still hydrating ('unknown') the form renders as normal).
  if (status === 'authenticated' && user) {
    return (
      <>
        <h1>Sign in</h1>
        <p className={styles.noticeBox}>
          You are already signed in as {user.fullName || user.email}. Manage your profile on the{' '}
          <Link to="/account">account page</Link>, or head <Link to="/">back to Homeplate</Link>.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Sign in</h1>
      <p className={styles.lead}>
        Sign in to reserve seats, host meals and manage your account. New to Homeplate?{' '}
        <Link to="/signup">Create an account</Link>.
      </p>
      <ErrorSummary errors={fieldErrors} />
      {serverError !== null && <p className={styles.errorBox}>{serverError}</p>}
      <form className={`${styles.form} ${styles.authForm}`} onSubmit={handleSubmit} noValidate>
        <FormField id="login-email" label="Email address" required error={errorFor('login-email')}>
          <TextInput
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </FormField>
        <FormField id="login-password" label="Password" required error={errorFor('login-password')}>
          <TextInput
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" busy={busy}>
            Sign in
          </Button>
        </div>
      </form>
      <p>
        Registered but never verified your email? <Link to="/verify-email">Verify it here</Link>.
      </p>
    </>
  );
}
