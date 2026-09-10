// client/src/features/discovery/components/ListingCard.jsx — one search-result / example-dish
// card (U6-DISCOVERY; used by SearchPage FR-01 and HostProfilePage FR-03).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-01 — each result shows the dish, when it happens, seats remaining, cuisine and the
//     coarse area, and links to the FR-02 detail route.
//   ADR-010 / AB-08 — location context comes exclusively from the coarse fields (areaLabel +
//     city/region): the public payload carries no precise field and this card renders none.
//   NFR-07 — the image uses the kit's <Img> (non-empty alt enforced; alt derived from the
//     dish title), the card is an <article> whose h3 sits under the page's h2 section
//     heading, and the link name is the dish title (meaningful link text). Icons are
//     decorative and sit beside the words they illustrate, never replacing them.
//
// Design review (2026-08-26) §3B/§3C/§3D and the recommended information order:
//   image → title → neighbourhood + cuisine → date/time + seats.
// The whole card is the click target via a stretched link over the title: the accessibility
// tree still sees ONE link with the dish title as its name, so nothing is duplicated for a
// screen-reader or keyboard user, while a pointer user can hit anywhere on the card.
import { Link } from 'react-router-dom';
import { Card, Icon, Img } from '../../../ui/index.js';
import { areaShort, formatDateTime, seatsStatus } from './format.js';
import { listingPath } from './paths.js';
import styles from '../discovery.module.css';

export default function ListingCard({ listing }) {
  const image =
    Array.isArray(listing.images) && listing.images.length > 0 ? listing.images[0] : null;
  const area = areaShort(listing);
  const seats = seatsStatus(listing);

  return (
    <li>
      <Card as="article" className={styles.resultCard}>
        {/* The image slot is ALWAYS reserved: rendering it only when a photo exists made every
            card a different height and the grid ragged. The fallback is decorative — a
            listing without a photo is not information to announce. */}
        <div className={styles.cardImageWrap}>
          {image ? (
            <Img src={image.url} alt={`Photo of ${listing.title}`} className={styles.cardImage} />
          ) : (
            <div className={styles.cardImagePlaceholder} aria-hidden="true">
              <Icon name="cuisine" className={styles.cardImageGlyph} />
            </div>
          )}
          {/* Seats as STATUS (§3D), pinned to the image corner so availability is the first
              thing the eye lands on. The label carries the meaning in words (WCAG 1.4.1). */}
          <p className={`${styles.cardBadge} ${styles[`cardBadge_${seats.tone}`]}`}>
            <Icon name="seats" /> {seats.label}
          </p>
        </div>

        <div className={styles.cardBody}>
          <h3 className={styles.cardTitle}>
            <Link to={listingPath(listing.id)} className={styles.cardLink}>
              {listing.title}
            </Link>
          </h3>

          <p className={styles.cardContext}>
            {area ? (
              <span className={styles.cardContextItem}>
                <Icon name="location" /> {area}
              </span>
            ) : null}
            {listing.cuisine ? (
              <span className={styles.cardContextItem}>
                <Icon name="cuisine" /> {listing.cuisine}
              </span>
            ) : null}
          </p>

          <p className={styles.cardWhen}>
            <Icon name="calendar" />{' '}
            <time dateTime={String(listing.scheduledStart)}>
              {formatDateTime(listing.scheduledStart)}
            </time>
          </p>
        </div>
      </Card>
    </li>
  );
}
