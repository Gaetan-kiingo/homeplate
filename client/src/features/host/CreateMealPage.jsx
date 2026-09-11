// client/src/features/host/CreateMealPage.jsx — /host/meals/new: a host publishes a meal
// (FR-11 create; closes verification finding OBS-B3, team decision 2026-09-11).
//
// Requirement traceability (SRS Appendix B):
//   FR-11 — POST /api/listings with the schema's body; the MEHKO caps are the server's
//     (ADR-009): a 422 MEHKO_* refusal is rendered from the payload's own numbers.
//   FR-09 — the session's canPublishListing flag gates the form up front (the server gate is
//     still the authority: a 403 NOT_ELIGIBLE lists the reason codes with the account fix path).
//   FR-08 — the new listing is PENDING until a moderator approves it; the success message says
//     so and the host lands on the listing page, which shows the pending state.
//   ADR-004 — optional photos ride the published media supply path (mint target → PUT bytes →
//     attach with kind 'listing' and the new listing id). A failed upload never loses the
//     listing: it is created first, the photo failure is reported honestly.
//   NFR-07 — one h1 + document.title; anonymous visitors get sign-in links instead of a dead
//     form; every outcome is announced through the shell's aria-live channel.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/index.js';
import { useSession } from '../../session/index.js';
import { Spinner, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import MealForm, { BODY_FIELD_IDS } from './components/MealForm.jsx';
import {
  ACCOUNT_PATH,
  PUBLISH_REASONS,
  hostErrorMessage,
  validationIssues,
} from './components/hostErrors.js';
import styles from './host.module.css';

/** The ADR-004 supply path for each chosen photo, attached to the new listing. */
async function uploadPhotos(listingId, files) {
  for (const file of files) {
    const target = await api.media.createUploadTarget({
      kind: 'listing',
      contentType: file.type,
      sizeBytes: file.size,
    });
    await api.media.uploadToTarget(target, file);
    await api.media.attach({
      storageKey: target.storageKey,
      kind: 'listing',
      entityId: listingId,
      contentType: file.type,
      sizeBytes: file.size,
    });
  }
}

export default function CreateMealPage() {
  usePageTitle('Host a meal');
  const navigate = useNavigate();
  const { user, status } = useSession();
  const { announce, announceError } = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [serverIssues, setServerIssues] = useState([]);
  const [general, setGeneral] = useState(null);
  const [reasons, setReasons] = useState(null);

  async function handleSubmit({ body, files }) {
    setBusy(true);
    setServerIssues([]);
    setGeneral(null);
    setReasons(null);
    let listing;
    try {
      ({ listing } = await api.listings.create(body));
    } catch (err) {
      setBusy(false);
      if (err && err.code === 'NOT_ELIGIBLE') {
        setReasons((err.details && err.details.reasons) || []);
        announceError(
          'You are not eligible to publish a listing yet. What is missing is listed on this page.'
        );
        return;
      }
      if (err && err.code === 'VALIDATION_FAILED') {
        const issues = validationIssues(err, BODY_FIELD_IDS);
        setServerIssues(issues.fieldErrors);
        setGeneral(issues.general);
        announceError('The server rejected some fields. Each problem is listed on this page.');
        return;
      }
      const message = hostErrorMessage(err);
      setGeneral(message);
      announceError(message);
      return;
    }
    // The listing exists from here on; a photo failure is reported, never fatal.
    let photoNote = '';
    try {
      await uploadPhotos(listing.id, files);
    } catch (err) {
      photoNote = ` ${hostErrorMessage({ ...err, code: 'MEDIA_UPLOAD_FAILED' })}`;
    }
    setBusy(false);
    announce(
      'Meal created. It is pending moderation review and becomes visible to guests once approved.' +
        photoNote
    );
    navigate(`/listings/${encodeURIComponent(listing.id)}`);
  }

  return (
    <>
      <h1>Host a meal</h1>

      {status === 'unknown' ? <Spinner label="Checking your session" /> : null}

      {status === 'anonymous' ? (
        <p>
          <Link to="/login">Sign in</Link> or <Link to="/signup">create an account</Link> to host a
          meal. Hosting needs a verified email, a complete profile and the host agreement.
        </p>
      ) : null}

      {status === 'authenticated' && !(user && user.canPublishListing) ? (
        <div className={styles.noticeBox}>
          <p>
            Your account cannot publish listings yet. The{' '}
            <Link to={ACCOUNT_PATH}>account page</Link> lists what is outstanding — a verified
            email, your name and phone, a host bio and the host agreement — and how to fix each.
          </p>
        </div>
      ) : null}

      {status === 'authenticated' && user && user.canPublishListing ? (
        <>
          <p className={styles.lead}>
            Describe the meal, when it happens and where. New listings are reviewed by a moderator
            before guests can see them. California MEHKO limits apply: one listing per day, and caps
            on meals per day and per week — Homeplate checks them when you publish.
          </p>

          {reasons !== null ? (
            <div className={styles.errorBox} role="status">
              <p>You are not eligible to publish a listing yet:</p>
              <ul className={styles.reasonList}>
                {reasons.map((code) => (
                  <li key={code}>{PUBLISH_REASONS[code] || code}</li>
                ))}
              </ul>
              <p>
                Fix these on your <Link to={ACCOUNT_PATH}>account page</Link>, then come back.
              </p>
            </div>
          ) : null}
          {general ? <p className={styles.errorBox}>{general}</p> : null}

          <MealForm
            withPhotos
            submitLabel="Publish this meal"
            busyLabel="Publishing…"
            busy={busy}
            serverIssues={serverIssues}
            onSubmit={handleSubmit}
          />
        </>
      ) : null}
    </>
  );
}
