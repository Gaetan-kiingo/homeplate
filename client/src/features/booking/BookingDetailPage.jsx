// client/src/features/booking/BookingDetailPage.jsx — U6-BOOKING: /bookings/:bookingId —
// lifecycle, dual completion, cancel-before-start (SPMP WA-9; the NFR-07 "booking flow"
// interface's detail screen).
//
// Requirement traceability (SRS Appendix B):
//   FR-04 — shows BOTH completion flags (guest / host, with "(you)" on the caller's row) and
//     offers the caller's confirm action only while the meal is in progress and their own
//     flag is unset; the response's awaitingOtherParty / completed transition is announced.
//   FR-14 — cancel is offered ONLY on a pending booking strictly before the scheduled start,
//     behind a confirm Dialog; success announces seat-restored + participants-notified. At or
//     after the start the action is absent and the screen says why.
//   FR-13 — status changes are surfaced as text, and the screen states plainly that email
//     notifications are sent to both participants on every status change (ADR-011 channel).
//   FR-12 / AB-08 — participant-only data: a foreign booking is the server's 403/404 by
//     design, rendered here as typed messages.
//   ADR-010 — the embedded listing is the coarse PUBLIC reference (ListingSummary); the
//     exact address lives only on the privileged listing-detail path, linked below.
//   NFR-07 — one h1, sectioned headings, labelled Spinner, kit Dialog (focus trap +
//     restore), and every outcome announced via the aria-live channel AND rendered visibly.
// Cross-feature links are URL strings only (wave-6 rule): messages / reviews / safety-alert
// screens are U6-COMMUNITY's; the listing page is U6-DISCOVERY's.
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/index.js';
import { Button, Card, Dialog, Spinner, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import ListingSummary from './components/ListingSummary.jsx';
import SignInPrompt from './components/SignInPrompt.jsx';
import { bookingErrorMessage } from './components/bookingErrors.js';
import { formatWhen, statusLabel } from './components/formatters.js';
import styles from './booking.module.css';

export default function BookingDetailPage() {
  usePageTitle('Booking details');
  const { bookingId } = useParams();
  const { announce, announceError } = useAnnounce();

  const [load, setLoad] = useState({ phase: 'loading', booking: null, message: '', code: '' });
  const [action, setAction] = useState({ kind: null, busy: false, message: '' });
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const keepBookingRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ phase: 'loading', booking: null, message: '', code: '' });
    api.bookings.getBooking(bookingId).then(
      ({ booking }) => {
        if (!cancelled) setLoad({ phase: 'ready', booking, message: '', code: '' });
      },
      (err) => {
        if (cancelled) return;
        const message = bookingErrorMessage(err);
        setLoad({ phase: 'error', booking: null, message, code: (err && err.code) || '' });
        announceError(message);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [bookingId, announceError]);

  async function onConfirmCompletion() {
    setAction({ kind: 'complete', busy: true, message: '' });
    try {
      const { booking, awaitingOtherParty } = await api.bookings.confirmCompletion(bookingId);
      setLoad((prev) => ({ ...prev, booking }));
      setAction({ kind: null, busy: false, message: '' });
      announce(
        awaitingOtherParty
          ? 'Your confirmation is recorded. The booking completes when the other participant ' +
              'confirms too — both of you are notified by email.'
          : 'Meal completed — both participants have confirmed. Email notifications are on ' +
              'their way.'
      );
    } catch (err) {
      const message = bookingErrorMessage(err);
      setAction({ kind: 'complete', busy: false, message });
      announceError(message);
    }
  }

  async function onConfirmCancel() {
    setAction({ kind: 'cancel', busy: true, message: '' });
    try {
      const { booking } = await api.bookings.cancel(bookingId);
      setConfirmingCancel(false);
      setLoad((prev) => ({ ...prev, booking }));
      setAction({ kind: null, busy: false, message: '' });
      announce(
        'Booking cancelled — the seat was returned to the listing, and both participants ' +
          'are notified by email.'
      );
    } catch (err) {
      const message = bookingErrorMessage(err);
      setConfirmingCancel(false);
      setAction({ kind: 'cancel', busy: false, message });
      announceError(message);
    }
  }

  const booking = load.booking;
  const listing = booking && booking.listing;
  const role = booking && booking.role;
  const startMs = listing ? Date.parse(listing.scheduledStart) : NaN;
  const beforeStart = Number.isFinite(startMs) && startMs > Date.now();
  const canCancel = booking && booking.status === 'pending' && beforeStart;
  const ownConfirmed =
    booking &&
    (role === 'host' ? booking.hostConfirmedCompletion : booking.guestConfirmedCompletion);

  return (
    <>
      <h1>Booking details</h1>

      {load.phase === 'loading' ? <Spinner label="Loading the booking" /> : null}

      {load.phase === 'error' ? (
        <>
          <p className={styles.errorText}>{load.message}</p>
          {load.code === 'NO_SESSION' || load.code === 'AUTHENTICATION_REQUIRED' ? (
            <SignInPrompt purpose="to view this booking" />
          ) : (
            <p>
              <Link to="/bookings">Back to your bookings</Link>
            </p>
          )}
        </>
      ) : null}

      {load.phase === 'ready' ? (
        <>
          <p>
            {role === 'host'
              ? 'A guest reserved a seat at your listing.'
              : 'You reserved a seat at this meal.'}
          </p>

          <Card
            as="section"
            aria-labelledby="booking-listing-title"
            className={`${styles.section} ${styles.listingCard}`}
          >
            <h2 id="booking-listing-title">{listing.title}</h2>
            <ListingSummary listing={listing} />
            <p>
              <Link to={`/listings/${listing.id}`}>View the full listing</Link>
            </p>
          </Card>

          <section aria-labelledby="booking-status-heading" className={styles.section}>
            <h2 id="booking-status-heading">Status</h2>
            <p className={`${styles.statusLine} ${styles[`badge_${booking.status}`] || ''}`}>
              Status: {statusLabel(booking.status)}.
            </p>
            <p>Reserved on {formatWhen(booking.createdAt)}.</p>
            {booking.cancelledAt ? <p>Cancelled on {formatWhen(booking.cancelledAt)}.</p> : null}
            {booking.completedAt ? <p>Completed on {formatWhen(booking.completedAt)}.</p> : null}
            <p className={styles.mutedText}>
              Email notifications are sent to both participants whenever this booking&rsquo;s status
              changes — reservation, cancellation and completion.
            </p>
          </section>

          <section aria-labelledby="booking-completion-heading" className={styles.section}>
            <h2 id="booking-completion-heading">Meal completion</h2>
            <p>A booking completes when both participants confirm the meal took place.</p>
            <ul>
              <li>
                Guest{role === 'guest' ? ' (you)' : ''}:{' '}
                {booking.guestConfirmedCompletion ? 'confirmed' : 'not confirmed yet'}
              </li>
              <li>
                Host{role === 'host' ? ' (you)' : ''}:{' '}
                {booking.hostConfirmedCompletion ? 'confirmed' : 'not confirmed yet'}
              </li>
            </ul>
            {booking.status === 'completed' ? (
              <p>Both participants confirmed — this booking is complete.</p>
            ) : null}
            {booking.status === 'in_progress' && !ownConfirmed ? (
              <div className={styles.actions}>
                <Button
                  busy={action.kind === 'complete' && action.busy}
                  onClick={onConfirmCompletion}
                >
                  Confirm the meal is complete
                </Button>
              </div>
            ) : null}
            {booking.status === 'in_progress' && ownConfirmed ? (
              <p>You have confirmed — waiting for the other participant.</p>
            ) : null}
            {booking.status === 'pending' ? (
              <p className={styles.mutedText}>
                Completion can be confirmed once the meal is in progress.
              </p>
            ) : null}
            {action.kind === 'complete' && action.message !== '' ? (
              <p className={styles.errorText}>{action.message}</p>
            ) : null}
          </section>

          <section aria-labelledby="booking-cancel-heading" className={styles.section}>
            <h2 id="booking-cancel-heading">Cancellation</h2>
            {booking.status === 'cancelled' ? (
              <p>This booking is cancelled. The seat was returned to the listing.</p>
            ) : canCancel ? (
              <>
                <p>
                  Cancelling before the meal starts returns the seat to the listing and notifies
                  both participants by email.
                </p>
                <div className={styles.actions}>
                  <Button variant="danger" onClick={() => setConfirmingCancel(true)}>
                    Cancel this booking
                  </Button>
                </div>
              </>
            ) : booking.status === 'in_progress' ||
              (booking.status === 'pending' && Number.isFinite(startMs)) ? (
              <p>The meal has started — this booking can no longer be cancelled.</p>
            ) : booking.status === 'pending' ? (
              // Finding F-B2: a degenerate payload whose scheduledStart does not parse must
              // never claim the meal started — stay neutral; the server stays the enforcer.
              <p>Cancellation is currently unavailable for this booking.</p>
            ) : (
              <p className={styles.mutedText}>Only upcoming reserved bookings can be cancelled.</p>
            )}
            {action.kind === 'cancel' && action.message !== '' ? (
              <p className={styles.errorText}>{action.message}</p>
            ) : null}
          </section>

          <nav aria-labelledby="booking-related-heading" className={styles.section}>
            <h2 id="booking-related-heading">Messages and more</h2>
            <ul className={styles.relatedList}>
              <li>
                <Link to={`/bookings/${booking.id}/messages`}>
                  Messages with the {role === 'host' ? 'guest' : 'host'}
                </Link>
              </li>
              {booking.status === 'completed' ? (
                <li>
                  <Link to={`/bookings/${booking.id}/review`}>Write a review of this meal</Link>
                </li>
              ) : null}
              <li>
                <Link to={`/bookings/${booking.id}/safety-alert`}>Report a safety concern</Link>
              </li>
            </ul>
          </nav>

          <Dialog
            open={confirmingCancel}
            title="Cancel this booking?"
            onClose={() => setConfirmingCancel(false)}
            initialFocusRef={keepBookingRef}
          >
            <p>
              The seat returns to the listing and both participants are notified by email. This
              cannot be undone.
            </p>
            <div className={styles.actions}>
              <Button
                ref={keepBookingRef}
                variant="secondary"
                onClick={() => setConfirmingCancel(false)}
              >
                Keep the booking
              </Button>
              <Button
                variant="danger"
                busy={action.kind === 'cancel' && action.busy}
                onClick={onConfirmCancel}
              >
                Cancel the booking
              </Button>
            </div>
          </Dialog>
        </>
      ) : null}
    </>
  );
}
