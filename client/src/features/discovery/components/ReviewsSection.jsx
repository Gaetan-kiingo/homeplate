// client/src/features/discovery/components/ReviewsSection.jsx — the paged approved-review
// list (U6-DISCOVERY; used by ListingDetailPage FR-02 and HostProfilePage FR-03).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-02 / FR-03 — the first page of approved reviews arrives embedded in the detail/host
//     payload (a bounded preview, TCC-04); further pages come from GET /api/hosts/:id/reviews
//     via api.hosts.reviews with the SAME page size, so page boundaries line up. reviewCount /
//     reviewsTotal from the payload is the total — nothing is invented client-side.
//   FR-05 — a review renders its numeric rating as text ("rated this host 4 out of 5"),
//     author display name (the backend substitutes a neutral name for erased authors,
//     NFR-12) and comment body when present.
//   NFR-07 — the pager is a labelled <nav>; page changes and load failures are announced
//     through the app-wide aria-live channel (useAnnounce); the busy state keeps the
//     buttons focusable (kit Button `busy`, never a focus-dropping hard disable mid-action).
import { useState } from 'react';
import { api } from '../../../api/index.js';
import { Button, Card, useAnnounce } from '../../../ui/index.js';
import { formatDate } from './format.js';
import styles from '../discovery.module.css';

export default function ReviewsSection({ hostId, initialReviews, total, pageSize }) {
  const seed = Array.isArray(initialReviews) ? initialReviews : [];
  // Page size: the payload's declared preview cap (listing detail carries reviewsPageSize);
  // the host page's embedded preview IS its first page, so its length is the cap there.
  const effectivePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : seed.length;
  const totalCount = Number.isFinite(total) ? total : seed.length;
  const totalPages =
    effectivePageSize > 0 ? Math.max(1, Math.ceil(totalCount / effectivePageSize)) : 1;

  const [page, setPage] = useState(1);
  const [reviews, setReviews] = useState(seed);
  const [busy, setBusy] = useState(false);
  const { announce, announceError } = useAnnounce();

  async function goTo(nextPage) {
    if (busy || nextPage < 1 || nextPage > totalPages) return;
    setBusy(true);
    try {
      const result = await api.hosts.reviews(hostId, {
        page: nextPage,
        pageSize: effectivePageSize,
      });
      setPage(nextPage);
      setReviews(Array.isArray(result.reviews) ? result.reviews : []);
      announce(`Showing reviews page ${nextPage} of ${totalPages}.`);
    } catch (err) {
      announceError(err && err.message ? err.message : 'The reviews could not be loaded.');
    } finally {
      setBusy(false);
    }
  }

  if (totalCount === 0) {
    return <p>No reviews yet.</p>;
  }

  return (
    <>
      <ul className={styles.reviewList}>
        {reviews.map((review) => (
          <li key={review.id}>
            <Card as="article" className={styles.reviewCard}>
              <p className={styles.reviewHead}>
                <strong>{review.authorDisplayName}</strong> rated this host {review.rating} out of 5
              </p>
              {review.createdAt ? (
                <p className={styles.cardMeta}>
                  <time dateTime={String(review.createdAt)}>{formatDate(review.createdAt)}</time>
                </p>
              ) : null}
              {review.body ? <p className={styles.reviewBody}>{review.body}</p> : null}
            </Card>
          </li>
        ))}
      </ul>
      {totalPages > 1 ? (
        <nav aria-label="Review pages" className={styles.pager}>
          <Button
            variant="secondary"
            disabled={page <= 1}
            busy={busy}
            onClick={() => goTo(page - 1)}
          >
            Previous reviews
          </Button>
          <p className={styles.pageStatus}>
            Page {page} of {totalPages}
          </p>
          <Button
            variant="secondary"
            disabled={page >= totalPages}
            busy={busy}
            onClick={() => goTo(page + 1)}
          >
            Next reviews
          </Button>
        </nav>
      ) : null}
    </>
  );
}
