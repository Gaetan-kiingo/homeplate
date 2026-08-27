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
import { Img, Spinner, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import ReviewsSection from './components/ReviewsSection.jsx';
import { hostPath, loginPath, newBookingPath } from './components/paths.js';
import { areaText, formatDateTime, ratingText, seatsText } from './components/format.js';
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

export default function ListingDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { announceError } = useAnnounce();

  const [phase, setPhase] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);

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

  return (
    <article>
      <h1>{listing.title}</h1>

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

      {reservable ? (
        <p>
          <Link className={styles.reserveCta} to={newBookingPath(listing.id)}>
            Reserve a seat
          </Link>
        </p>
      ) : null}
      {listing.status === 'active' &&
      listing.moderationStatus === 'approved' &&
      listing.seatsRemaining <= 0 ? (
        <p className={styles.stateBox}>No seats remaining for this meal.</p>
      ) : null}

      <section aria-labelledby="listing-about-heading" className={styles.section}>
        <h2 id="listing-about-heading">About this meal</h2>
        <p>{listing.description}</p>
        {listing.cuisine ? <p>Cuisine: {listing.cuisine}</p> : null}
        <h3>Ingredients</h3>
        <p>{listing.ingredients}</p>
        <p className={styles.allergy}>
          <strong>Allergy warning: </strong>
          {listing.allergens || 'No allergen information provided by the host.'}
        </p>
      </section>

      <section aria-labelledby="listing-when-heading" className={styles.section}>
        <h2 id="listing-when-heading">When and where</h2>
        <dl className={styles.metaList}>
          <div className={styles.metaGroup}>
            <dt>Date and time</dt>
            <dd>
              <time dateTime={String(listing.scheduledStart)}>
                {formatDateTime(listing.scheduledStart)}
              </time>
            </dd>
          </div>
          <div className={styles.metaGroup}>
            <dt>Duration</dt>
            <dd>{listing.durationMinutes} minutes</dd>
          </div>
          <div className={styles.metaGroup}>
            <dt>Seats</dt>
            <dd>{seatsText(listing)}</dd>
          </div>
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

      {Array.isArray(listing.images) && listing.images.length > 0 ? (
        <section aria-labelledby="listing-photos-heading" className={styles.section}>
          <h2 id="listing-photos-heading">Photos</h2>
          <ul className={styles.gallery}>
            {listing.images.map((image, index) => (
              <li key={image.id}>
                <Img
                  src={image.url}
                  alt={`${listing.title} — photo ${index + 1} of ${listing.images.length}`}
                  className={styles.galleryImage}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="listing-host-heading" className={styles.section}>
        <h2 id="listing-host-heading">Your host</h2>
        <p>
          <Link to={hostPath(listing.hostId)}>{listing.host.displayName}</Link>
        </p>
        {listing.host.bio ? <p>{listing.host.bio}</p> : null}
        <p>{ratingText(listing.host.averageRating, listing.host.reviewCount)}</p>
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
    </article>
  );
}
