// client/src/features/host/MyMealsPage.jsx — /host/meals: the host's upcoming meals in every
// state (FR-11 host dashboard, 2026-09-11), from GET /api/listings/mine.
//
//   FR-11 — each upcoming listing with its moderation state (pending / approved / rejected),
//     its status (active / cancelled), seats booked, price per seat, and links to view and edit.
//   FR-08 — the moderation state is said in words: a pending meal is invisible to guests.
//   NFR-07 — one h1 + document.title; the list is a real list with one heading per meal;
//     status is text, never colour alone (WCAG 1.4.1); anonymous visitors get sign-in links.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/index.js';
import { useSession } from '../../session/index.js';
import { Spinner, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import { hostErrorMessage } from './components/hostErrors.js';
import styles from './host.module.css';

const MEAL_TIME_ZONE = 'America/Los_Angeles';

export function whenText(iso) {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  return instant.toLocaleString('en-US', {
    timeZone: MEAL_TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "$18 per seat" / "$18.50 per seat" / "Free" from whole cents. */
export function priceText(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n < 0) return 'Price not set';
  if (n === 0) return 'Free';
  return `${n % 100 === 0 ? `$${(n / 100).toFixed(0)}` : `$${(n / 100).toFixed(2)}`} per seat`;
}

/** One human status line per listing state (moderation × status). */
export function statusText(listing) {
  if (listing.status === 'cancelled') return 'Cancelled';
  switch (listing.moderationStatus) {
    case 'pending':
      return 'Pending moderation review — not yet visible to guests';
    case 'rejected':
      return 'Rejected by moderation — not visible to guests';
    case 'approved':
      return 'Published — visible to guests';
    default:
      return listing.moderationStatus || 'Unknown state';
  }
}

export default function MyMealsPage() {
  usePageTitle('Your meals');
  const { user, status } = useSession();
  const { announceError } = useAnnounce();
  const [load, setLoad] = useState({ phase: 'idle', listings: [], message: '' });

  useEffect(() => {
    if (status !== 'authenticated') return undefined;
    let cancelled = false;
    setLoad({ phase: 'loading', listings: [], message: '' });
    api.listings.mine().then(
      ({ listings }) => {
        if (!cancelled) setLoad({ phase: 'ready', listings, message: '' });
      },
      (err) => {
        if (cancelled) return;
        const message = hostErrorMessage(err);
        setLoad({ phase: 'error', listings: [], message });
        announceError(message);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [status, announceError]);

  return (
    <>
      <h1>Your meals</h1>

      {status === 'unknown' ? <Spinner label="Checking your session" /> : null}

      {status === 'anonymous' ? (
        <p>
          <Link to="/login">Sign in</Link> or <Link to="/signup">create an account</Link> to see the
          meals you host.
        </p>
      ) : null}

      {status === 'authenticated' ? (
        <>
          <p className={styles.lead}>
            Every upcoming meal you host, in every state. Guests see only the published ones.
          </p>
          <p className={styles.actions}>
            {user && user.canPublishListing ? (
              <Link className={styles.cta} to="/host/meals/new">
                Host a meal
              </Link>
            ) : (
              <span>
                To host a meal, complete the hosting requirements on your{' '}
                <Link to="/account">account page</Link>.
              </span>
            )}
          </p>

          {load.phase === 'loading' ? <Spinner label="Loading your meals" /> : null}
          {load.phase === 'error' ? <p className={styles.errorBox}>{load.message}</p> : null}

          {load.phase === 'ready' && load.listings.length === 0 ? (
            <p className={styles.noticeBox}>You have no upcoming meals yet.</p>
          ) : null}

          {load.phase === 'ready' && load.listings.length > 0 ? (
            <ul className={styles.mealList} aria-label="Your upcoming meals">
              {load.listings.map((listing) => {
                const booked = Math.max(
                  0,
                  Number(listing.seatCapacity) - Number(listing.seatsRemaining)
                );
                const cancelled = listing.status === 'cancelled';
                return (
                  <li key={listing.id} className={styles.mealCard}>
                    <h2 className={styles.mealTitle}>
                      <Link to={`/listings/${encodeURIComponent(listing.id)}`}>
                        {listing.title}
                      </Link>
                    </h2>
                    <p className={styles.mealStatus}>{statusText(listing)}</p>
                    <dl className={styles.mealFacts}>
                      <div>
                        <dt>When</dt>
                        <dd>
                          <time dateTime={String(listing.scheduledStart)}>
                            {whenText(listing.scheduledStart)}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>Seats</dt>
                        <dd>
                          {booked} of {listing.seatCapacity} booked
                        </dd>
                      </div>
                      <div>
                        <dt>Price</dt>
                        <dd>{priceText(listing.pricePerSeatCents)}</dd>
                      </div>
                    </dl>
                    {!cancelled ? (
                      <p className={styles.mealActions}>
                        <Link to={`/host/meals/${encodeURIComponent(listing.id)}/edit`}>Edit</Link>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}
    </>
  );
}
