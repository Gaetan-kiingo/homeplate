// client/src/features/booking/ReservePage.jsx — U6-BOOKING: the reserve flow at
// /bookings/new?listing=<id> (SPMP WA-9; the NFR-07 "booking flow" interface entry).
//
// Requirement traceability (SRS Appendix B):
//   FR-12 — fetch the listing summary, let the guest confirm, then api.bookings.create();
//     success is announced and navigates to the new booking's detail page. The atomic seat
//     decrement is the server's; this screen only renders its typed outcomes.
//   FR-09 — a 403 NOT_ELIGIBLE renders <EligibilityNotice> (WHAT is missing + HOW to fix it
//     per reason code, with fix links/actions) — the flagship error UX.
//   FR-12 / AB-02 — NO_CAPACITY and the per-guest pending cap (BOOKING_LIMIT, limit read
//     from the error payload) each render DISTINCT, announced messages (bookingErrors.js).
//   FR-13 — states plainly that booking updates are confirmed by email (ADR-011 channel).
//   ADR-010 — the summary shows coarse location only (ListingSummary); nothing here assumes
//     a precise address exists before a booking is held.
//   NFR-07 — one h1; document.title via usePageTitle; async work has a labelled Spinner and
//     a busy Button; every failure is announced via the kit's aria-live channel AND rendered
//     as visible text; the anonymous state offers sign-in links instead of a dead button.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/index.js';
import { useSession } from '../../session/index.js';
import { Button, Card, Spinner, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import ListingSummary from './components/ListingSummary.jsx';
import SignInPrompt from './components/SignInPrompt.jsx';
import EligibilityNotice from './components/EligibilityNotice.jsx';
import { bookingErrorMessage } from './components/bookingErrors.js';
import styles from './booking.module.css';

export default function ReservePage() {
  usePageTitle('Reserve a seat');
  const [params] = useSearchParams();
  const listingId = params.get('listing');
  const navigate = useNavigate();
  const { status: sessionStatus } = useSession();
  const { announce, announceError } = useAnnounce();

  const [load, setLoad] = useState({ phase: 'loading', listing: null, message: '' });
  const [reserve, setReserve] = useState({ busy: false, message: '', reasons: null });

  useEffect(() => {
    if (!listingId) {
      setLoad({ phase: 'missing', listing: null, message: '' });
      return undefined;
    }
    let cancelled = false;
    setLoad({ phase: 'loading', listing: null, message: '' });
    api.listings.getListing(listingId).then(
      ({ listing }) => {
        if (!cancelled) setLoad({ phase: 'ready', listing, message: '' });
      },
      (err) => {
        if (cancelled) return;
        const message = bookingErrorMessage(err);
        setLoad({ phase: 'error', listing: null, message });
        announceError(message);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [listingId, announceError]);

  async function onReserve() {
    setReserve({ busy: true, message: '', reasons: null });
    try {
      const { booking } = await api.bookings.create(listingId);
      announce(
        'Seat reserved — this booking is now pending. Email confirmations are on their way ' +
          'to you and the host.'
      );
      navigate(`/bookings/${booking.id}`);
    } catch (err) {
      if (err && err.code === 'NOT_ELIGIBLE') {
        const reasons = (err.details && err.details.reasons) || [];
        setReserve({ busy: false, message: '', reasons });
        announceError(
          'You are not eligible to reserve a seat yet. What is missing, and how to fix it, ' +
            'is listed on this page.'
        );
      } else {
        const message = bookingErrorMessage(err);
        setReserve({ busy: false, message, reasons: null });
        announceError(message);
      }
    }
  }

  return (
    <>
      <h1>Reserve a seat</h1>

      {load.phase === 'missing' ? (
        <p>
          No listing was selected. <Link to="/search">Browse the available meals</Link> and choose
          one to reserve.
        </p>
      ) : null}

      {load.phase === 'loading' ? <Spinner label="Loading the listing details" /> : null}

      {load.phase === 'error' ? (
        <>
          <p className={styles.errorText}>{load.message}</p>
          <p>
            <Link to="/search">Browse the available meals</Link>
          </p>
        </>
      ) : null}

      {load.phase === 'ready' ? (
        <>
          <Card as="section" aria-labelledby="reserve-listing-title" className={styles.section}>
            <h2 id="reserve-listing-title">{load.listing.title}</h2>
            {load.listing.host && load.listing.host.displayName ? (
              <p>Hosted by {load.listing.host.displayName}</p>
            ) : null}
            <ListingSummary listing={load.listing} />
            <p>
              <Link to={`/listings/${load.listing.id}`}>View the full listing</Link>
            </p>
          </Card>

          <p>
            Reserving holds a single seat at this meal for you. Booking updates are confirmed by
            email — Homeplate notifies you and the host whenever this booking&rsquo;s status
            changes.
          </p>

          {sessionStatus === 'anonymous' ? (
            <SignInPrompt purpose="to reserve a seat" />
          ) : (
            <div className={styles.actions}>
              <Button busy={reserve.busy} onClick={onReserve}>
                {reserve.busy ? 'Reserving…' : 'Reserve a seat'}
              </Button>
            </div>
          )}

          {reserve.message !== '' ? <p className={styles.errorText}>{reserve.message}</p> : null}
          {reserve.reasons !== null ? (
            <EligibilityNotice reasons={reserve.reasons} actionPhrase="reserve a seat" />
          ) : null}
        </>
      ) : null}
    </>
  );
}
