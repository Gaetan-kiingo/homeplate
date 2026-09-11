// client/src/features/discovery/ListingDetailPage.jsx — the FR-02 listing-detail screen
// (U6-DISCOVERY; SPMP WA-9; the NFR-07 "listing detail" interface at /listings/:id).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-02 — renders every detail-payload field from GET /api/listings/:id: dish title and
//     description, ingredients, allergy warning, date/time + duration, seat capacity and
//     seats remaining, images, the host summary (display name, bio, rating aggregate) and
//     the approved host reviews (a bounded preview, paged onward via GET /api/hosts/:id/
//     reviews — see components/ReviewsSection.jsx). Pending/rejected listings only ever
//     reach their owning host (server rule); the moderation status is surfaced when it
//     rides the payload (FR-08: born pending, never public until approved).
//   ADR-010 / AB-08 — the coarse area (areaLabel/city) is the DEFAULT location display,
//     with a note explaining when the exact address is disclosed. The exact address renders
//     ONLY when the payload itself carries it (owner / pending-or-in-progress guest /
//     FR-07 moderator — the server decides, this screen only feature-tests the field).
//     Precise coordinates are never rendered. A 401 redirects to /login (session-gated).
//   FR-12 — the Reserve CTA links to the booking flow at /bookings/new?listing=<id>
//     (URL string only, U6-BOOKING's route), shown only while seats remain on an active,
//     approved listing.
//   NFR-07 — one h1 + document.title in every phase (loading/ready/error); alt text on
//     every image (derived from the dish title); load failures announced assertively.
//   NFR-09 — a missing image degrades to its text alternative (the kit <Img> always carries
//     one); a failed load renders a typed message, never a blank page or crash.
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/index.js';
import { Button, Icon, Img, Spinner, useAnnounce } from '../../ui/index.js';
import { useOptionalSession } from '../../session/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import ReviewsSection from './components/ReviewsSection.jsx';
import { hostPath, loginPath, newBookingPath } from './components/paths.js';
import {
  areaShort,
  areaText,
  formatDateTime,
  ratingText,
  seatsStatus,
  seatsText,
} from './components/format.js';
import styles from './discovery.module.css';

/** The privileged ADR-010 fields, joined for display — only called when they exist. */
function addressText(listing) {
  return [
    listing.addressLine1,
    listing.addressLine2,
    listing.city,
    listing.region,
    listing.postalCode,
  ]
    .filter(Boolean)
    .join(', ');
}

function errorTitle(error) {
  return error && error.status === 404 ? 'Listing not found' : 'Listing unavailable';
}

/** Ingredients / allergens arrive as text[] from the API (listings.ingredients is text[]);
 *  older fixtures and the FR-02 spec pass a plain string. Render both the same way.
 *  Before this the array was rendered raw, which React joins with NO separator
 *  ("ricevegetablesspices"). */
function listText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return value == null ? '' : String(value);
}

/** The allergen line: the host's own words, or an honest sentence when the API's array is
 *  empty / the single marker "none". */
function allergyText(value) {
  const items = Array.isArray(value) ? value.filter(Boolean) : [];
  if (Array.isArray(value)) {
    if (items.length === 0) return 'No allergen information provided by the host.';
    if (items.every((a) => a.toLowerCase() === 'none')) {
      return 'No common allergens, according to the host. Ask before booking if unsure.';
    }
    return `Contains ${items.join(', ')}.`;
  }
  return listText(value) || 'No allergen information provided by the host.';
}

function listItems(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

/** Initials for the host avatar (decorative; the link beside it carries the name). */
function initialsFor(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export default function ListingDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { announce, announceError } = useAnnounce();
  // Owner affordances (FR-11 manage: edit / cancel) appear only when the viewer IS the host.
  // Optional on purpose: the page's main job needs no session store (see useOptionalSession).
  const session = useOptionalSession();
  const viewer = session && session.status === 'authenticated' ? session.user : null;

  const [phase, setPhase] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [cancelState, setCancelState] = useState('idle'); // 'idle' | 'confirm' | 'busy'
  const [cancelMessage, setCancelMessage] = useState('');

  async function onConfirmCancel() {
    setCancelState('busy');
    setCancelMessage('');
    try {
      await api.listings.cancel(listing.id);
      setListing((current) => ({ ...current, status: 'cancelled' }));
      setCancelState('idle');
      announce(
        'Meal cancelled. Guests with a reservation are being notified by email and their seats released.'
      );
    } catch (err) {
      setCancelState('idle');
      const message =
        err && err.code === 'LISTING_CANCELLED'
          ? 'This meal was already cancelled.'
          : (err && err.message) || 'The meal could not be cancelled. Please try again.';
      setCancelMessage(message);
      announceError(message);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setPhase('loading');
      setListing(null);
      setError(null);
      try {
        const payload = await api.listings.getListing(id);
        if (cancelled) return;
        setListing(payload.listing);
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        if (err && err.status === 401) {
          // AB-08: detail is session-gated — go sign in, then come back here.
          navigate(loginPath(location), { replace: true });
          return;
        }
        setError(err);
        setPhase('error');
        announceError(err && err.message ? err.message : 'The listing could not be loaded.');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id, navigate, location, announceError]);

  usePageTitle(
    phase === 'ready' ? listing.title : phase === 'error' ? errorTitle(error) : 'Listing'
  );

  if (phase === 'loading') {
    return (
      <>
        <h1>Listing</h1>
        <Spinner label="Loading listing" />
      </>
    );
  }

  if (phase === 'error') {
    return (
      <>
        <h1>{errorTitle(error)}</h1>
        <p>{error.message}</p>
        <p>
          <Link to="/search">Browse other meals</Link>
        </p>
      </>
    );
  }

  const hasPreciseAddress =
    listing.addressLine1 !== undefined &&
    listing.addressLine1 !== null &&
    listing.addressLine1 !== '';
  const reservable =
    listing.status === 'active' &&
    listing.moderationStatus === 'approved' &&
    listing.seatsRemaining > 0;

  const seats = seatsStatus(listing);
  const hero =
    Array.isArray(listing.images) && listing.images.length > 0 ? listing.images[0] : null;
  // Chips only for the API's text[] shape; a free-text allergen sentence stays a sentence.
  const allergenItems = Array.isArray(listing.allergens)
    ? listItems(listing.allergens).filter((a) => a.toLowerCase() !== 'none')
    : [];
  const kicker = areaShort(listing);

  return (
    <article>
      <header className={styles.detailHeader}>
        <p className={styles.detailKicker}>
          {listing.cuisine ? (
            <span>
              <Icon name="cuisine" /> {listing.cuisine}
            </span>
          ) : null}
          {kicker ? (
            <span>
              <Icon name="location" /> {kicker}
            </span>
          ) : null}
        </p>
        <h1>{listing.title}</h1>
      </header>

      {listing.moderationStatus === 'pending' ? (
        <p className={styles.stateBox}>
          This listing is pending moderation review and is visible only to you until it is approved.
        </p>
      ) : null}
      {listing.moderationStatus === 'rejected' ? (
        <p className={styles.stateBox}>
          This listing was rejected by moderation and is not publicly visible.
        </p>
      ) : null}
      {listing.status === 'cancelled' ? (
        <p className={styles.stateBox}>This meal has been cancelled by the host.</p>
      ) : null}

      {/* FR-11 manage actions — the host's own listing (2026-09-11, closes OBS-B3). The server
          is the authority (owner-only PATCH/cancel, 403 otherwise); this block only appears
          when the session user is the listing's host. Cancelling asks once, inline, and never
          uses a browser dialog (NFR-07: the confirmation is real, focusable page content). */}
      {viewer && listing.hostId === viewer.id ? (
        <section aria-labelledby="manage-heading" className={styles.stateBox}>
          <h2 id="manage-heading" className={styles.subheading}>
            You host this meal
          </h2>
          {listing.status === 'cancelled' ? (
            <p>It is cancelled; its seats were released and guests were notified.</p>
          ) : (
            <>
              <p>
                <Link to={`/host/meals/${encodeURIComponent(listing.id)}/edit`}>
                  Edit this meal
                </Link>
                {listing.moderationStatus === 'pending'
                  ? ' — it is waiting for moderation review before guests can see it.'
                  : null}
              </p>
              {cancelState === 'idle' ? (
                <Button variant="secondary" onClick={() => setCancelState('confirm')}>
                  Cancel this meal
                </Button>
              ) : null}
              {cancelState !== 'idle' ? (
                <div role="group" aria-labelledby="cancel-confirm-label">
                  <p id="cancel-confirm-label">
                    Cancel this meal? Every reservation is released and each guest is emailed. This
                    cannot be undone.
                  </p>
                  <Button busy={cancelState === 'busy'} onClick={onConfirmCancel}>
                    {cancelState === 'busy' ? 'Cancelling…' : 'Yes, cancel the meal'}
                  </Button>{' '}
                  <Button
                    variant="secondary"
                    onClick={() => setCancelState('idle')}
                    disabled={cancelState === 'busy'}
                  >
                    Keep the meal
                  </Button>
                </div>
              ) : null}
              {cancelMessage !== '' ? <p className={styles.errorBox}>{cancelMessage}</p> : null}
            </>
          )}
        </section>
      ) : null}

      {/* Hero: the first photo, or the branded fallback (design review §4 — never an empty
          grey rectangle). The gallery below still lists every photo with real alt text. */}
      <figure className={styles.detailHero}>
        {hero ? (
          <Img
            src={hero.url}
            alt={`${listing.title} — photo 1 of ${listing.images.length}`}
            className={styles.detailHeroImage}
          />
        ) : (
          <Icon name="cuisine" className={styles.detailHeroGlyph} />
        )}
      </figure>

      <div className={styles.detailGrid}>
        <div className={styles.detailMain}>
          <section aria-labelledby="listing-about-heading" className={styles.section}>
            <h2 id="listing-about-heading">About this meal</h2>
            <p className={styles.description}>{listing.description}</p>

            <h3 className={styles.subheading}>Ingredients</h3>
            <p>{listText(listing.ingredients)}</p>
            {allergenItems.length > 0 ? (
              <ul className={styles.chipRow} aria-label="Allergens">
                {allergenItems.map((a) => (
                  <li key={a} className={`${styles.chip} ${styles.chipMuted}`}>
                    {a}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className={styles.allergy}>
              <strong>Allergy warning: </strong>
              {allergyText(listing.allergens)}
            </p>
          </section>

          <section aria-labelledby="listing-when-heading" className={styles.section}>
            <h2 id="listing-when-heading">Where</h2>
            <dl className={styles.metaList}>
              <div className={styles.metaGroup}>
                <dt>Approximate area</dt>
                <dd>{areaText(listing) || 'Not specified'}</dd>
              </div>
              {hasPreciseAddress ? (
                <div className={styles.metaGroup}>
                  <dt>Address</dt>
                  <dd>{addressText(listing)}</dd>
                </div>
              ) : null}
            </dl>
            {!hasPreciseAddress ? (
              <p className={styles.addressNote}>
                The exact address is shared once you have reserved a seat for this meal.
              </p>
            ) : null}
          </section>

          {Array.isArray(listing.images) && listing.images.length > 1 ? (
            <section aria-labelledby="listing-photos-heading" className={styles.section}>
              <h2 id="listing-photos-heading">Photos</h2>
              <ul className={styles.gallery}>
                {listing.images.slice(1).map((image, index) => (
                  <li key={image.id}>
                    <Img
                      src={image.url}
                      alt={`${listing.title} — photo ${index + 2} of ${listing.images.length}`}
                      className={styles.galleryImage}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="listing-host-heading" className={styles.section}>
            <h2 id="listing-host-heading">Your host</h2>
            <div className={styles.hostCard}>
              <span className={styles.hostAvatar} aria-hidden="true">
                {initialsFor(listing.host.displayName)}
              </span>
              <div>
                <p className={styles.hostName}>
                  <Link to={hostPath(listing.hostId)}>{listing.host.displayName}</Link>
                </p>
                <p className={styles.hostRating}>
                  <Icon name="star" />
                  {ratingText(listing.host.averageRating, listing.host.reviewCount)}
                </p>
                {listing.host.bio ? <p className={styles.hostBio}>{listing.host.bio}</p> : null}
              </div>
            </div>
          </section>

          <section aria-labelledby="listing-reviews-heading" className={styles.section}>
            <h2 id="listing-reviews-heading">Reviews of this host</h2>
            <ReviewsSection
              hostId={listing.hostId}
              initialReviews={listing.reviews}
              total={listing.reviewsTotal}
              pageSize={listing.reviewsPageSize}
            />
          </section>
        </div>

        {/* Sticky reservation panel (design review §5): when, how long, how many seats, where,
            then the one action. Seat availability is stated here ONCE, in words. */}
        <aside className={styles.detailAside} aria-labelledby="listing-reserve-heading">
          <div className={styles.reservePanel}>
            <h2 id="listing-reserve-heading" className={styles.cardTitle}>
              Reserve
            </h2>
            <dl className={styles.reserveFacts}>
              <div className={styles.reserveFact}>
                <Icon name="calendar" />
                <dt>Date and time</dt>
                <dd>
                  <time dateTime={String(listing.scheduledStart)}>
                    {formatDateTime(listing.scheduledStart)}
                  </time>
                </dd>
              </div>
              <div className={styles.reserveFact}>
                <Icon name="clock" />
                <dt>Duration</dt>
                <dd>{listing.durationMinutes} minutes</dd>
              </div>
              <div
                className={`${styles.reserveFact} ${styles[`reserveSeats_${seats.tone}`] || ''}`}
              >
                <Icon name="seats" />
                <dt>Seats</dt>
                <dd>{seatsText(listing)}</dd>
              </div>
              {kicker ? (
                <div className={styles.reserveFact}>
                  <Icon name="location" />
                  <dt>Neighbourhood</dt>
                  <dd>{kicker}</dd>
                </div>
              ) : null}
            </dl>

            {reservable ? (
              <Link
                className={`${styles.reserveCta} ${styles.reserveCtaWide}`}
                to={newBookingPath(listing.id)}
              >
                Reserve a seat
              </Link>
            ) : null}
            {listing.status === 'active' &&
            listing.moderationStatus === 'approved' &&
            listing.seatsRemaining <= 0 ? (
              <p className={styles.stateBox}>No seats remaining for this meal.</p>
            ) : null}
            {!hasPreciseAddress ? (
              <p className={styles.reserveNote}>
                Exact address shared after you reserve. Free to cancel before the meal.
              </p>
            ) : null}
          </div>
        </aside>
      </div>
    </article>
  );
}
