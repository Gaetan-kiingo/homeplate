// client/src/features/discovery/HostProfilePage.jsx — the FR-03 host personal page
// (U6-DISCOVERY; SPMP WA-9; the NFR-07 "host profile" interface at /hosts/:id).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-03 — renders every host-page payload field from GET /api/hosts/:id: display name,
//     member-since date, self-introduction, kitchen/dining photos, example dishes (the
//     host's approved upcoming listings), and the approved reviews with numeric ratings and
//     the average — first page embedded in the payload, further pages via
//     GET /api/hosts/:id/reviews (components/ReviewsSection.jsx).
//   ADR-010 / AB-08 — example dishes arrive in the PUBLIC listing projection (coarse area
//     only, rendered by the shared ListingCard) and the host payload carries no contact or
//     address key at all — this screen renders none. The endpoint is session-gated: a 401
//     redirects to /login with a `next` parameter.
//   FR-01 — links to /search?hostId=<id>, the search screen's host filter, for the host's
//     full upcoming schedule beyond the example-dish preview.
//   NFR-07 — one h1 + document.title in every phase; alt text on every photo (derived from
//     the host's display name); review paging announced via aria-live; load failures
//     announced assertively.
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/index.js';
import { Icon, Img, Spinner, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import ListingCard from './components/ListingCard.jsx';
import ReviewsSection from './components/ReviewsSection.jsx';
import { loginPath, searchByHostPath } from './components/paths.js';
import { formatMonthYear, ratingText } from './components/format.js';
import styles from './discovery.module.css';

function errorTitle(error) {
  return error && error.status === 404 ? 'Host not found' : 'Host profile unavailable';
}

/** Initials for the decorative avatar; the h1 beside it carries the name. */
function initialsFor(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export default function HostProfilePage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { announceError } = useAnnounce();

  const [phase, setPhase] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [host, setHost] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setPhase('loading');
      setHost(null);
      setError(null);
      try {
        const payload = await api.hosts.getHost(id);
        if (cancelled) return;
        setHost(payload.host);
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        if (err && err.status === 401) {
          // AB-08: the host page is session-gated — go sign in, then come back here.
          navigate(loginPath(location), { replace: true });
          return;
        }
        setError(err);
        setPhase('error');
        announceError(err && err.message ? err.message : 'The host profile could not be loaded.');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id, navigate, location, announceError]);

  usePageTitle(
    phase === 'ready' ? host.displayName : phase === 'error' ? errorTitle(error) : 'Host profile'
  );

  if (phase === 'loading') {
    return (
      <>
        <h1>Host profile</h1>
        <Spinner label="Loading host profile" />
      </>
    );
  }

  if (phase === 'error') {
    return (
      <>
        <h1>{errorTitle(error)}</h1>
        <p>{error.message}</p>
        <p>
          <Link to="/search">Browse meals instead</Link>
        </p>
      </>
    );
  }

  const memberSince = formatMonthYear(host.memberSince);
  const images = Array.isArray(host.images) ? host.images : [];
  const exampleDishes = Array.isArray(host.exampleDishes) ? host.exampleDishes : [];

  return (
    <article>
      <header className={styles.hostHeader}>
        <span className={`${styles.hostAvatar} ${styles.hostHeaderAvatar}`} aria-hidden="true">
          {initialsFor(host.displayName)}
        </span>
        <div>
          <h1>{host.displayName}</h1>
          <div className={styles.hostHeaderMeta}>
            <p>
              <Icon name="star" />
              {ratingText(host.averageRating, host.reviewCount)}
            </p>
            {memberSince ? (
              <p className={styles.cardMeta}>
                Member since <time dateTime={String(host.memberSince)}>{memberSince}</time>
              </p>
            ) : null}
          </div>
        </div>
      </header>

      <section aria-labelledby="host-about-heading" className={styles.section}>
        <h2 id="host-about-heading">About this host</h2>
        {host.selfIntroduction ? (
          <p>{host.selfIntroduction}</p>
        ) : (
          <p>This host has not written an introduction yet.</p>
        )}
      </section>

      {images.length > 0 ? (
        <section aria-labelledby="host-photos-heading" className={styles.section}>
          <h2 id="host-photos-heading">Kitchen and dining photos</h2>
          <ul className={styles.gallery}>
            {images.map((image, index) => (
              <li key={image.id}>
                <Img
                  src={image.url}
                  alt={`${host.displayName} — kitchen and dining photo ${index + 1} of ${images.length}`}
                  className={styles.galleryImage}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="host-dishes-heading" className={styles.section}>
        <h2 id="host-dishes-heading">Example dishes</h2>
        {exampleDishes.length === 0 ? (
          <p>No upcoming meals from this host right now.</p>
        ) : (
          <ul className={styles.resultsList}>
            {exampleDishes.map((dish) => (
              <ListingCard key={dish.id} listing={dish} />
            ))}
          </ul>
        )}
        <p>
          <Link to={searchByHostPath(host.id)}>Search all upcoming meals from this host</Link>
        </p>
      </section>

      <section aria-labelledby="host-reviews-heading" className={styles.section}>
        <h2 id="host-reviews-heading">Reviews</h2>
        <ReviewsSection
          hostId={host.id}
          initialReviews={host.reviews}
          total={host.reviewCount}
          pageSize={Array.isArray(host.reviews) ? host.reviews.length : 0}
        />
      </section>
    </article>
  );
}
