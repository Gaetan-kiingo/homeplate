// client/src/features/account/components/ResendVerificationForm.jsx — U6-ACCOUNT-MOD: the
// FR-10 recovery path as a small labelled form (used by VerifyEmailPage when the mailed
// link is missing or dead).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 / AB-05 — POST /api/auth/resend-verification always answers 202, so the
//     confirmation copy promises neither that the account exists nor that a mail was sent —
//     only that a delivery was queued IF the account exists. The 429 throttle renders its
//     retry horizon honestly (details.retryAfterSeconds).
//   NFR-07 — the field is labelled via FormField with a stable id; outcomes are announced
//     through the shell's aria-live channel and shown in text.
import { useState } from 'react';
import { Button, ErrorSummary, FormField, TextInput, useAnnounce } from '../../../ui/index.js';
import { api } from '../../../api/index.js';
import {
  isThrottleError,
  messageForAccountError,
  resendQueuedMessage,
  resendThrottledMessage,
} from './errorCopy.js';
import styles from '../account.module.css';

const EMAIL_SHAPE = /^\S+@\S+\.\S+$/;

export default function ResendVerificationForm() {
  const { announce, announceError } = useAnnounce();
  const [email, setEmail] = useState('');
  const [fieldErrors, setFieldErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setNotice(null);
    setError(null);
    const cleanEmail = email.trim();
    if (cleanEmail === '' || !EMAIL_SHAPE.test(cleanEmail)) {
      setFieldErrors([
        { fieldId: 'resend-email', message: 'Enter the email address you registered with' },
      ]);
      return;
    }
    setFieldErrors([]);
    setBusy(true);
    try {
      await api.auth.resendVerification(cleanEmail);
      const message = resendQueuedMessage(cleanEmail);
      setNotice(message);
      announce(message);
    } catch (err) {
      // Finding AMV-W6-02: the live throttle code is VERIFICATION_RESEND_RATE_LIMITED —
      // match the 429 family so the tailored wait-then-retry copy actually renders.
      const message = isThrottleError(err)
        ? resendThrottledMessage(err)
        : messageForAccountError(err);
      setError(message);
      announceError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="resend-heading" className={styles.section}>
      <h2 id="resend-heading">Request a new verification email</h2>
      <ErrorSummary errors={fieldErrors} />
      {error !== null && <p className={styles.errorBox}>{error}</p>}
      {notice !== null && <p className={styles.noticeBox}>{notice}</p>}
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <FormField
          id="resend-email"
          label="Email address"
          required
          error={
            fieldErrors.length > 0 && fieldErrors[0].fieldId === 'resend-email'
              ? fieldErrors[0].message
              : undefined
          }
        >
          <TextInput
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" busy={busy}>
            Request a new verification email
          </Button>
        </div>
      </form>
    </section>
  );
}
