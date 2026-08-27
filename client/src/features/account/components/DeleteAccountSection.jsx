// client/src/features/account/components/DeleteAccountSection.jsx — U6-ACCOUNT-MOD: the
// NFR-12 account-deletion flow on /account, behind an explicit confirmation dialog.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-12 (ST-05) — DELETE /api/users/me answers 202: the account disappears from every
//     read path immediately and the personal-data erasure runs 30 days after the request.
//     Both the section copy and the confirm Dialog NAME the 30-day erasure explicitly, and
//     nothing is sent until the user activates the confirm button inside the dialog.
//   AB-05 — the 202 also destroys the session server-side; the caller's onAccepted handler
//     treats the outcome as a logout (session store re-hydrates to anonymous).
//   NFR-07 — the Dialog is the kit's focus-trapped, Escape-closable modal; initial focus
//     lands on Cancel (the safe action); the outcome is announced via aria-live.
import { useRef, useState } from 'react';
import { Button, Dialog, useAnnounce } from '../../../ui/index.js';
import { api } from '../../../api/index.js';
import { messageForAccountError } from './errorCopy.js';
import styles from '../account.module.css';

/**
 * @param {{onAccepted: (request: object) => void}} props  called with the 202 request row.
 */
export default function DeleteAccountSection({ onAccepted }) {
  const { announce, announceError } = useAnnounce();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const cancelRef = useRef(null);

  async function handleConfirm() {
    setError(null);
    setBusy(true);
    try {
      const { request } = await api.users.requestDeletion();
      announce(
        'Account deletion accepted. You are signed out; your personal data will be permanently erased 30 days after this request.'
      );
      setOpen(false);
      onAccepted(request);
    } catch (err) {
      const message = messageForAccountError(err);
      setError(message);
      announceError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="deletion-heading" className={styles.section}>
      <h2 id="deletion-heading">Delete your account</h2>
      <p className={styles.lead}>
        Deleting your account takes effect immediately: you are signed out and your profile
        disappears from Homeplate. Your personal data — name, email, phone, emergency contact and
        photos — is permanently erased 30 days after the request (NFR-12). Reviews and bookings are
        kept in anonymized form. This cannot be undone.
      </p>
      <div className={styles.actions}>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete my account…
        </Button>
      </div>
      <Dialog
        open={open}
        title="Delete your account?"
        onClose={() => setOpen(false)}
        initialFocusRef={cancelRef}
      >
        <p>
          Your account is deactivated immediately and you are signed out everywhere. All of your
          personal data is permanently erased 30 days after this request. This cannot be undone.
        </p>
        {error !== null && <p className={styles.errorBox}>{error}</p>}
        <div className={styles.actions}>
          <Button ref={cancelRef} variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} onClick={handleConfirm}>
            Yes, delete my account
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
