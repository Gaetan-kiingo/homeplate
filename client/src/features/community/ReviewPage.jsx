// client/src/features/community/ReviewPage.jsx — U6-COMMUNITY: the FR-05 review form on a
// completed booking (route 'bookings/:bookingId/review'; SPMP WA-4; build-plan G.4 6A).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-05 — rating is an INTEGER 1..5 (native <select>, so no other value can be chosen)
//     and the comment is REQUIRED, min 1 character — the team's RATIFIED 2026-08-26 reading
//     of FR-05 (report W4-F2, src/schemas/reviews.js). Both requirements are marked on the
//     form BEFORE submit, and a photo-only submission is blocked CLIENT-SIDE with an
//     explanation (the server's 422 remains the enforcement; this screen just never lets an
//     honest user discover the rule as a server error). Photos are optional and travel the
//     published ADR-004 media supply path: api.media.createUploadTarget → uploadToTarget →
//     attach, then their storage keys ride the review POST as imageKeys.
//   FR-08 — a created review is born PENDING (ADR-002): the success state says "pending
//     moderation — not public until approved", never "published".
//   NFR-07 — one h1 + document.title; every control labelled through FormField with the
//     required marker; pre-submit violations render as a focused ErrorSummary (role=alert,
//     one link per field); server refusals (409 REVIEW_EXISTS, 409 BOOKING_NOT_COMPLETED,
//     422 VALIDATION_FAILED, 403, 404, MEDIA_UPLOAD_FAILED with its own message) render as
//     real human messages per code and are announced via aria-live (build-plan G.2).
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import {
  Button,
  Card,
  ErrorSummary,
  FormField,
  Select,
  TextArea,
  TextInput,
  useAnnounce,
} from '../../ui/index.js';
import { messageForError } from './components/communityMessages.js';
import styles from './ReviewPage.module.css';

/** Stable control ids so the ErrorSummary links can move focus to the offending field. */
const RATING_FIELD_ID = 'review-rating';
const COMMENT_FIELD_ID = 'review-comment';
const PHOTOS_FIELD_ID = 'review-photos';

/** Screen-specific refusal copy on top of the shared community map (G.2 typed codes). */
const REVIEW_OVERRIDES = {
  REVIEW_EXISTS: 'You have already reviewed this booking — each participant can leave one review.',
  BOOKING_NOT_COMPLETED:
    'This booking is not completed yet. You can leave a review once the meal is completed.',
  MEDIA_UPLOAD_FAILED:
    'A photo could not be uploaded, so your review was not submitted. Remove the photo or try again.',
  MEDIA_KEY_FORBIDDEN:
    'One of the photos does not belong to your account, so the review was refused. Remove it and try again.',
};

export default function ReviewPage() {
  usePageTitle('Leave a review');
  const { bookingId } = useParams();
  const { announce, announceError } = useAnnounce();

  const [rating, setRating] = useState('');
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState([]);
  const [formErrors, setFormErrors] = useState([]);
  const [serverError, setServerError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function fieldError(fieldId) {
    const found = formErrors.find((entry) => entry.fieldId === fieldId);
    return found ? found.message : undefined;
  }

  /** ADR-004 supply path, exactly as published: mint target → PUT bytes → attach key. */
  async function uploadPhotos() {
    const imageKeys = [];
    for (const file of files) {
      const target = await api.media.createUploadTarget({
        kind: 'review',
        contentType: file.type,
        sizeBytes: file.size,
      });
      await api.media.uploadToTarget(target, file);
      await api.media.attach({
        storageKey: target.storageKey,
        kind: 'review',
        contentType: file.type,
        sizeBytes: file.size,
      });
      imageKeys.push(target.storageKey);
    }
    return imageKeys;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    // FR-05 pre-submit validation (ratified comment-required rule): a rating-less or
    // photo-only review is blocked HERE, with an explanation, before any request leaves.
    const problems = [];
    if (rating === '') {
      problems.push({ fieldId: RATING_FIELD_ID, message: 'Choose a rating from 1 to 5.' });
    }
    if (comment.trim() === '') {
      problems.push({
        fieldId: COMMENT_FIELD_ID,
        message:
          files.length > 0
            ? 'Write a comment — photos alone cannot be submitted: every review needs at least one character of text.'
            : 'Write a comment — every review needs at least one character of text.',
      });
    }
    setFormErrors(problems);
    if (problems.length > 0) return; // the ErrorSummary renders, takes focus and announces

    setServerError(null);
    setSubmitting(true);
    try {
      const imageKeys = await uploadPhotos();
      await api.reviews.create(bookingId, {
        rating: Number.parseInt(rating, 10),
        comment: comment.trim(),
        imageKeys,
      });
      setSubmitted(true);
      announce('Review submitted. It is pending moderation and will not be public until approved.');
    } catch (err) {
      const message = messageForError(err, REVIEW_OVERRIDES);
      setServerError(message);
      announceError(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <>
        <h1>Leave a review</h1>
        <Card as="section" aria-labelledby="review-done-heading">
          <h2 id="review-done-heading">Review submitted — pending moderation</h2>
          <p>
            Your review has been recorded but is not public yet: every review is checked by
            Homeplate moderation first and appears only once approved.
          </p>
          <p>
            <Link to="/bookings">Back to your bookings</Link>
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <h1>Leave a review</h1>
      <p>
        Share how the meal went. A rating and a written comment are required; photos are optional.
      </p>

      <ErrorSummary errors={formErrors} />

      {/* noValidate: the browser's native required-field bubbles would block submit BEFORE
          handleSubmit runs, so the FR-05 explanations (rating missing / photo-only blocked)
          would never render or be announced. The custom validation in handleSubmit owns the
          refusal via the focused ErrorSummary (GDS pattern); the native `required` semantics
          stay on the controls for assistive technology. */}
      <form onSubmit={handleSubmit} noValidate className={styles.form}>
        <FormField id={RATING_FIELD_ID} label="Rating" required error={fieldError(RATING_FIELD_ID)}>
          <Select value={rating} onChange={(event) => setRating(event.target.value)}>
            <option value="">Choose a rating</option>
            <option value="1">1 — Poor</option>
            <option value="2">2 — Fair</option>
            <option value="3">3 — Good</option>
            <option value="4">4 — Very good</option>
            <option value="5">5 — Excellent</option>
          </Select>
        </FormField>

        <FormField
          id={COMMENT_FIELD_ID}
          label="Comment"
          required
          hint="Required — describe your experience in at least one character. Photos can never replace the comment."
          error={fieldError(COMMENT_FIELD_ID)}
        >
          <TextArea rows={5} value={comment} onChange={(event) => setComment(event.target.value)} />
        </FormField>

        <FormField
          id={PHOTOS_FIELD_ID}
          label="Photos (optional)"
          hint="Add photos of the meal if you like."
        >
          <TextInput
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files || []))}
          />
        </FormField>
        {files.length > 0 && (
          <p className={styles.fileNote}>
            {files.length === 1 ? '1 photo selected.' : `${files.length} photos selected.`}
          </p>
        )}

        {serverError && <p className={styles.serverError}>{serverError}</p>}

        <Button type="submit" busy={submitting}>
          Submit review
        </Button>
      </form>
    </>
  );
}
