// client/src/features/account/SignupPage.jsx — U6-ACCOUNT-MOD: registration (the other half
// of the NFR-07 "signup/login" interface).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 — POST /api/auth/register creates the UNVERIFIED account; the screen then flips to
//     the check-your-email state (the verification token travels by email only — inbox
//     ownership is the proof, so this screen never sees or asks for the token) with a
//     resend action on the FR-10 recovery path (always 202 — AB-05 anti-enumeration, so the
//     copy promises neither account existence nor delivery).
//   NFR-06 — fullName/phone are optional here by schema (src/schemas/auth.js register);
//     the hints say why they matter (eligibility flags stay false until the profile is
//     complete — finished on /account, FR-09 fix path).
//   NFR-07 — one h1 + document.title; all fields labelled via FormField; pre-submit
//     validation renders a focus-taking ErrorSummary linking each field; server failures
//     get one message per typed code (EMAIL_IN_USE 409, VERIFICATION_RESEND_RATE_LIMITED
//     429, ...) and are
//     announced via the shell's aria-live channel.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, ErrorSummary, FormField, TextInput, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import { api } from '../../api/index.js';
import {
  isThrottleError,
  messageForAccountError,
  resendQueuedMessage,
  resendThrottledMessage,
} from './components/errorCopy.js';
import styles from './account.module.css';

// Mirrors of the server's shapes for PRE-SUBMIT guidance only — src/schemas/auth.js remains
// the enforcement (a forced submit still renders the 422 correctly).
const EMAIL_SHAPE = /^\S+@\S+\.\S+$/;
const E164_SHAPE = /^\+[1-9]\d{1,14}$/;

export default function SignupPage() {
  usePageTitle('Create an account');
  const { announce, announceError } = useAnnounce();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [fieldErrors, setFieldErrors] = useState([]);
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNotice, setResendNotice] = useState(null);
  const [resendError, setResendError] = useState(null);

  const errorFor = (fieldId) => {
    const hit = fieldErrors.find((entry) => entry.fieldId === fieldId);
    return hit ? hit.message : undefined;
  };

  async function handleSubmit(event) {
    event.preventDefault();
    setServerError(null);
    const errors = [];
    const cleanEmail = email.trim();
    if (cleanEmail === '') {
      errors.push({ fieldId: 'signup-email', message: 'Enter your email address' });
    } else if (!EMAIL_SHAPE.test(cleanEmail)) {
      errors.push({ fieldId: 'signup-email', message: 'Enter a valid email address' });
    }
    if (password.length < 8) {
      errors.push({
        fieldId: 'signup-password',
        message: 'Enter a password of at least 8 characters',
      });
    } else if (password.length > 72) {
      errors.push({
        fieldId: 'signup-password',
        message: 'Passwords are at most 72 characters',
      });
    }
    if (phone.trim() !== '' && !E164_SHAPE.test(phone.trim())) {
      errors.push({
        fieldId: 'signup-phone',
        message: 'Enter the phone number in international format, e.g. +14155552671',
      });
    }
    setFieldErrors(errors);
    if (errors.length > 0) {
      return;
    }
    setBusy(true);
    try {
      const body = { email: cleanEmail, password };
      if (fullName.trim() !== '') {
        body.fullName = fullName.trim();
      }
      if (phone.trim() !== '') {
        body.phone = phone.trim();
      }
      await api.auth.register(body);
      setRegisteredEmail(cleanEmail);
      announce(
        `Account created. A verification email for ${cleanEmail} has been queued — open the link inside to verify your address.`
      );
    } catch (err) {
      const message = messageForAccountError(err);
      setServerError(message);
      announceError(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    setResendNotice(null);
    setResendError(null);
    setResendBusy(true);
    try {
      await api.auth.resendVerification(registeredEmail);
      const message = resendQueuedMessage(registeredEmail);
      setResendNotice(message);
      announce(message);
    } catch (err) {
      // Finding AMV-W6-02: the live throttle code is VERIFICATION_RESEND_RATE_LIMITED —
      // match the 429 family so the tailored wait-then-retry copy actually renders.
      const message = isThrottleError(err)
        ? resendThrottledMessage(err)
        : messageForAccountError(err);
      setResendError(message);
      announceError(message);
    } finally {
      setResendBusy(false);
    }
  }

  // FR-10 check-your-email state: the account exists but is unverified until the mailed
  // link is opened; the resend button is the recovery path for a lost/dead-lettered email.
  if (registeredEmail !== null) {
    return (
      <>
        <h1>Check your email</h1>
        <p className={styles.lead}>
          Your account was created and a verification email for <strong>{registeredEmail}</strong>{' '}
          has been queued. Open the link in that email to verify your address — verification is
          required before you can reserve seats or publish listings.
        </p>
        {resendError !== null && <p className={styles.errorBox}>{resendError}</p>}
        {resendNotice !== null && <p className={styles.noticeBox}>{resendNotice}</p>}
        <div className={styles.actions}>
          <Button variant="secondary" busy={resendBusy} onClick={handleResend}>
            Resend verification email
          </Button>
        </div>
        <p>
          Already verified? <Link to="/login">Sign in</Link>.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Create an account</h1>
      <p className={styles.lead}>
        One account lets you reserve seats at home-cooked meals and host your own. Already
        registered? <Link to="/login">Sign in</Link>.
      </p>
      <ErrorSummary errors={fieldErrors} />
      {serverError !== null && <p className={styles.errorBox}>{serverError}</p>}
      <form className={`${styles.form} ${styles.authForm}`} onSubmit={handleSubmit} noValidate>
        <FormField
          id="signup-email"
          label="Email address"
          required
          error={errorFor('signup-email')}
        >
          <TextInput
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </FormField>
        <FormField
          id="signup-password"
          label="Password"
          required
          hint="At least 8 characters (at most 72)."
          error={errorFor('signup-password')}
        >
          <TextInput
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </FormField>
        <FormField
          id="signup-fullName"
          label="Full name"
          hint="Optional now, but required before you can reserve a seat or host (FR-09) — you can add it later on your account page."
        >
          <TextInput
            name="name"
            autoComplete="name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </FormField>
        <FormField
          id="signup-phone"
          label="Phone number"
          hint="Optional now; international format, e.g. +14155552671. Also required before reserving or hosting."
          error={errorFor('signup-phone')}
        >
          <TextInput
            type="tel"
            name="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" busy={busy}>
            Create account
          </Button>
        </div>
      </form>
    </>
  );
}
