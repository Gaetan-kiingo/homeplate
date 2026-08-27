// client/src/features/booking/BookingsListPage.jsx — U6-BOOKING: /bookings — the caller's
// bookings, both roles (SPMP WA-9; part of the NFR-07 "booking flow" interface).
//
// Requirement traceability (SRS Appendix B):
//   FR-12 / AB-08 — GET /api/bookings serves the caller's own bookings only; this screen
//     filters by role ('guest' = seats I reserved, 'host' = bookings on my listings) and by
//     lifecycle status, and links each row to its detail page.
//   FR-13 — lifecycle status is surfaced as text on every row (statusLabel); the detail page
//     carries the email-notification statement.
//   NFR-07 — one h1; document.title; labelled filter controls (FormField + native Select);
//     result counts and failures announced via the kit's aria-live channel; a real list
//     (<ul>/<li>) so assistive tech can enumerate rows; the anonymous state offers sign-in
//     links instead of firing requests that can only 401.
//   NFR-03 / AB-05 — signed-in state read from useSession() (response-inferred), never a
//     cookie.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/index.js';
import { useSession } from '../../session/index.js';
import { Button, Card, FormField, Select, Spinner, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import SignInPrompt from './components/SignInPrompt.jsx';
import { bookingErrorMessage } from './components/bookingErrors.js';
import { formatWhen, statusLabel } from './components/formatters.js';
import styles from './booking.module.css';

const FIRST_PAGE = 1;

export default function BookingsListPage() {
  usePageTitle('Your bookings');
  const { status: sessionStatus } = useSession();
  const { announce, announceError } = useAnnounce();

  const [role, setRole] = useState('any');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(FIRST_PAGE);
  const [result, setResult] = useState({
    phase: 'loading',
    bookings: [],
    pageSize: null,
    message: '',
  });

  useEffect(() => {
    // 'anonymous' is definitive — render the sign-in prompt instead of a doomed request.
    // 'unknown' (still hydrating) proceeds: the cookie may be live, and a 401 both flips the
    // session store (src/api/http.js broadcast) and lands in the error branch below.
    if (sessionStatus === 'anonymous') return undefined;
    let cancelled = false;
    setResult((prev) => ({ ...prev, phase: 'loading', message: '' }));
    const query = { role };
    if (status !== '') query.status = status;
    query.page = page;
    api.bookings.list(query).then(
      ({ bookings, pageSize }) => {
        if (cancelled) return;
        setResult({ phase: 'ready', bookings, pageSize, message: '' });
        announce(
          bookings.length === 0
            ? 'No bookings to show.'
            : `${bookings.length} booking${bookings.length === 1 ? '' : 's'} shown.`
        );
      },
      (err) => {
        if (cancelled) return;
        if (err && (err.code === 'NO_SESSION' || err.code === 'AUTHENTICATION_REQUIRED')) {
          // The 401 broadcast has already flipped the session store to 'anonymous'; the
          // sign-in prompt renders on that state — nothing more to report here.
          setResult({ phase: 'idle', bookings: [], pageSize: null, message: '' });
          return;
        }
        const message = bookingErrorMessage(err);
        setResult({ phase: 'error', bookings: [], pageSize: null, message });
        announceError(message);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [role, status, page, sessionStatus, announce, announceError]);

  const hasNextPage =
    result.phase === 'ready' &&
    result.pageSize != null &&
    result.bookings.length >= result.pageSize;
  const unfiltered = role === 'any' && status === '' && page === FIRST_PAGE;

  return (
    <>
      <h1>Your bookings</h1>

      {sessionStatus === 'anonymous' ? (
        <SignInPrompt purpose="to see your bookings" />
      ) : (
        <>
          <div className={styles.filters}>
            <FormField id="bookings-filter-role" label="Show">
              <Select
                value={role}
                onChange={(event) => {
                  setRole(event.target.value);
                  setPage(FIRST_PAGE);
                }}
              >
                <option value="any">All my bookings</option>
                <option value="guest">Seats I reserved (as guest)</option>
                <option value="host">Bookings on my listings (as host)</option>
              </Select>
            </FormField>
            <FormField id="bookings-filter-status" label="Status">
              <Select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(FIRST_PAGE);
                }}
              >
                <option value="">Any status</option>
                <option value="pending">Reserved — upcoming</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </FormField>
          </div>

          {result.phase === 'loading' ? <Spinner label="Loading your bookings" /> : null}
          {result.phase === 'error' ? <p className={styles.errorText}>{result.message}</p> : null}

          {result.phase === 'ready' && result.bookings.length === 0 ? (
            unfiltered ? (
              <p>
                You have no bookings yet. <Link to="/search">Browse the available meals</Link> to
                reserve your first seat.
              </p>
            ) : (
              <p>No bookings match these filters.</p>
            )
          ) : null}

          {result.phase === 'ready' && result.bookings.length > 0 ? (
            <ul className={styles.bookingList}>
              {result.bookings.map((booking) => (
                <Card as="li" key={booking.id}>
                  <h2 className={styles.bookingItemHeading}>
                    <Link to={`/bookings/${booking.id}`}>{booking.listing.title}</Link>
                  </h2>
                  <p>{formatWhen(booking.listing.scheduledStart)}</p>
                  <p>
                    {statusLabel(booking.status)} ·{' '}
                    {booking.role === 'host' ? 'you are the host' : 'you are the guest'}
                  </p>
                </Card>
              ))}
            </ul>
          ) : null}

          {page > FIRST_PAGE || hasNextPage ? (
            <nav aria-label="Bookings pages" className={styles.actions}>
              <Button
                variant="secondary"
                disabled={page <= FIRST_PAGE}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous page
              </Button>
              <span>Page {page}</span>
              <Button
                variant="secondary"
                disabled={!hasNextPage}
                onClick={() => setPage((current) => current + 1)}
              >
                Next page
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </>
  );
}
