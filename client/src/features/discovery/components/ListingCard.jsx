// client/src/features/discovery/components/ListingCard.jsx — one search-result / example-dish
// card (U6-DISCOVERY; used by SearchPage FR-01 and HostProfilePage FR-03).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-01 — each result shows the dish, when it happens, seats remaining, cuisine and the
//     coarse area, and links to the FR-02 detail route.
//   ADR-010 / AB-08 — location context comes exclusively from format.areaText (areaLabel +
//     city/region): the public payload carries no precise field and this card renders none.
//   NFR-07 — the image uses the kit's <Img> (non-empty alt enforced; alt derived from the
//     dish title), the card is an <article> whose h3 sits under the page's h2 section
//     heading, and the link name is the dish title (meaningful link text).
import { Link } from 'react-router-dom';
import { Card, Img } from '../../../ui/index.js';
import { areaText, formatDateTime, seatsText } from './format.js';
import { listingPath } from './paths.js';
import styles from '../discovery.module.css';

export default function ListingCard({ listing }) {
  const image =
    Array.isArray(listing.images) && listing.images.length > 0 ? listing.images[0] : null;
  return (
    <li>
      <Card as="article" className={styles.resultCard}>
        {/* The image slot is ALWAYS reserved. Rendering it only when a photo exists made every
            card a different height, so a grid row sized to whichever card had one and the
            results looked ragged. The placeholder is decorative and aria-hidden: a listing
            without a photo is not information a screen-reader user needs announced. */}
        {image ? (
          <Img src={image.url} alt={`Photo of ${listing.title}`} className={styles.cardImage} />
        ) : (
          <div className={styles.cardImagePlaceholder} aria-hidden="true" />
        )}
        <h3 className={styles.cardTitle}>
          <Link to={listingPath(listing.id)}>{listing.title}</Link>
        </h3>
        <p className={styles.cardDate}>
          <time dateTime={String(listing.scheduledStart)}>
            {formatDateTime(listing.scheduledStart)}
          </time>
        </p>
        <p className={styles.cardMeta}>Approximate area: {areaText(listing) || 'not specified'}</p>
        <p className={styles.cardSeats}>{seatsText(listing)}</p>
        {listing.cuisine ? <p className={styles.cardMeta}>Cuisine: {listing.cuisine}</p> : null}
      </Card>
    </li>
  );
}
