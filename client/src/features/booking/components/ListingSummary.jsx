// client/src/features/booking/components/ListingSummary.jsx — U6-BOOKING: the shared
// listing summary block (reserve flow + booking detail; SPMP WA-9).
//
// Requirement traceability (SRS Appendix B):
//   FR-12 — the reserve flow shows what is being reserved (when, where, how long, seats)
//     before the guest confirms.
//   ADR-010 / NFR-13 — the location line renders the COARSE public fields only (areaLabel /
//     city / region): booking payloads embed the ADR-010 public listing reference by
//     design, and this component never assumes a precise address field exists. It says so
//     honestly — the exact address travels only on the privileged, booking-gated path.
//   NFR-07 — a real definition list (dt/dd), so the pairs are programmatically associated.
import { formatWhen } from './formatters.js';
import styles from '../booking.module.css';

export default function ListingSummary({ listing }) {
  const where = [listing.areaLabel, listing.city, listing.region].filter(Boolean).join(', ');
  return (
    <dl className={styles.metaList}>
      <dt>When</dt>
      <dd>{formatWhen(listing.scheduledStart)}</dd>
      {listing.durationMinutes != null ? (
        <>
          <dt>Duration</dt>
          <dd>{listing.durationMinutes} minutes</dd>
        </>
      ) : null}
      <dt>Where</dt>
      <dd>
        {where === '' ? 'Area shared by the host' : where}
        <span className={styles.mutedText}>
          {' '}
          (approximate area — the exact address is shared with confirmed guests)
        </span>
      </dd>
      {listing.cuisine ? (
        <>
          <dt>Cuisine</dt>
          <dd>{listing.cuisine}</dd>
        </>
      ) : null}
      {listing.seatsRemaining != null ? (
        <>
          <dt>Seats remaining</dt>
          <dd>{listing.seatsRemaining}</dd>
        </>
      ) : null}
    </dl>
  );
}
