// client/src/features/community/SafetyAlertPage.jsx — U6-COMMUNITY: the FR-07 safety-alert
// screen (route 'bookings/:bookingId/safety-alert'; SPMP WA-5; build-plan G.4 6A).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-07 — raising an alert is an explicit, confirmed action (the kit Dialog demands a
//     second, deliberate activation before anything is sent). On success the screen states
//     the THREE-PART outcome truthfully: (1) the alert is PERSISTED — the 201 commits the
//     row before any delivery is attempted (ADR-001/003); (2) moderators are notified — the
//     alert is visible in their review queue from the instant it is persisted and stays
//     there however delivery ends; (3) delivery to the user's emergency contact is
//     ATTEMPTED by email with automatic retries (ADR-011 — the worker delivers; a SendGrid
//     outage can neither delay nor roll back the alert). A user with no emergency contact
//     on file is pointed to /account BEFORE raising and again in the outcome (the server
//     records that leg as 'no_channel'; moderator notification still happens).
//   NFR-07 — one h1 + document.title; the confirm flow is fully keyboard-operable (kit
//     Dialog: focus trap, Escape, focus restore); success and every typed refusal
//     (403 NOT_PARTICIPANT, 404 BOOKING_NOT_FOUND, 401, transport) render as real human
//     messages and are announced through the shell's aria-live regions (build-plan G.2).
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/index.js';
import { useSession } from '../../session/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import { Button, Card, Dialog, useAnnounce } from '../../ui/index.js';
import { messageForError } from './components/communityMessages.js';
import styles from './SafetyAlertPage.module.css';

export default function SafetyAlertPage() {
  usePageTitle('Safety alert');
  const { bookingId } = useParams();
  const { user, status } = useSession();
  const { announce, announceError } = useAnnounce();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [raising, setRaising] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  const cancelRef = useRef(null);

  const hasContact = Boolean(user && user.emergencyContact);

  async function confirmRaise() {
    setRaising(true);
    setError(null);
    try {
      const { alert } = await api.safety.raiseAlert(bookingId);
      setOutcome({ alert });
      setDialogOpen(false);
      announce(
        hasContact
          ? 'Safety alert recorded. Moderators are notified and delivery to your emergency contact will be attempted.'
          : 'Safety alert recorded. Moderators are notified.'
      );
    } catch (err) {
      const message = messageForError(err);
      setDialogOpen(false);
      setError(message);
      announceError(message);
    } finally {
      setRaising(false);
    }
  }

  return (
    <>
      <h1>Safety alert</h1>
      <p>
        If something about this booking feels unsafe, raise a safety alert. It is recorded for
        Homeplate moderators immediately — you do not need to wait or explain anything first.
      </p>

      <section aria-labelledby="alert-what-heading">
        <h2 id="alert-what-heading">What happens when you raise an alert</h2>
        <ul>
          <li>The alert is saved right away — it cannot be lost, even if delivery fails.</li>
          <li>
            Homeplate moderators are notified: the alert appears in their review queue and stays
            there until it is handled.
          </li>
          <li>
            Delivery to your emergency contact is attempted by email, and retried automatically if
            an attempt fails.
          </li>
        </ul>
      </section>

      {status === 'authenticated' && !hasContact && (
        <Card as="section" aria-labelledby="no-contact-heading">
          <h2 id="no-contact-heading">No emergency contact on file</h2>
          <p>
            You have not added an emergency contact, so no emergency-contact delivery can be
            attempted. Moderators are still notified of every alert. You can add an emergency
            contact in <Link to="/account">your account settings</Link>.
          </p>
        </Card>
      )}

      {error && <p className={styles.error}>{error}</p>}

      <Button variant="danger" onClick={() => setDialogOpen(true)}>
        Raise a safety alert
      </Button>

      <Dialog
        open={dialogOpen}
        title="Raise a safety alert?"
        onClose={() => setDialogOpen(false)}
        initialFocusRef={cancelRef}
      >
        <p>
          This immediately records the alert and notifies Homeplate moderators.{' '}
          {hasContact
            ? 'Delivery to your emergency contact will also be attempted by email.'
            : 'No emergency contact is on file, so only moderators will be notified.'}
        </p>
        <div className={styles.dialogActions}>
          <Button ref={cancelRef} variant="secondary" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" busy={raising} onClick={confirmRaise}>
            Yes, raise the alert
          </Button>
        </div>
      </Dialog>

      {outcome && (
        <Card as="section" aria-labelledby="alert-raised-heading" className={styles.outcome}>
          <h2 id="alert-raised-heading">Alert raised</h2>
          <ul>
            <li>Your alert has been recorded — it is saved and cannot be lost.</li>
            <li>
              Homeplate moderators have been notified: the alert is already visible in their review
              queue and stays there until it is handled.
            </li>
            <li>
              {hasContact ? (
                'Delivery to your emergency contact is being attempted by email. If an attempt fails, it is retried automatically.'
              ) : (
                <>
                  No emergency contact is on file, so no emergency-contact delivery was attempted.
                  You can add one in <Link to="/account">your account settings</Link>.
                </>
              )}
            </li>
          </ul>
        </Card>
      )}
    </>
  );
}
