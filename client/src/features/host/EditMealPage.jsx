// client/src/features/host/EditMealPage.jsx — /host/meals/:id/edit: the owner updates a meal
// (FR-11 update). Loads the listing through the FR-02 detail read, which returns the
// PRIVILEGED projection to the owner (ADR-010) — so this is the second screen allowed to read
// the precise-address keys, and like the detail page it gates on their presence.
//
//   FR-11 — PATCH /api/listings/:id with ONLY the fields that changed (the update schema
//     requires at least one); the caps are re-checked server-side on schedule/seat changes.
//   FR-08 — a material content change resets moderation to pending; the success message says so.
//   NFR-07 — one h1 + document.title; load/refusal states are real text; outcomes announced.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/index.js';
import { useSession } from '../../session/index.js';
import { Spinner, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import MealForm, {
  BODY_FIELD_IDS,
  EMPTY_VALUES,
  centsToDollars,
  toBody,
} from './components/MealForm.jsx';
import { hostErrorMessage, validationIssues } from './components/hostErrors.js';
import { isoToLaWallClock } from './components/mealTime.js';
import styles from './host.module.css';

/** text[] (current API) or a comma-joined string (older fixtures) → one label per line. */
function labelsText(value) {
  if (Array.isArray(value)) return value.join('\n');
  return typeof value === 'string' ? value : '';
}

/** Form values from the owner's (privileged) listing payload. */
export function valuesFromListing(listing) {
  return {
    ...EMPTY_VALUES,
    title: listing.title || '',
    description: listing.description || '',
    cuisine: listing.cuisine || '',
    ingredients: labelsText(listing.ingredients),
    allergens: labelsText(listing.allergens),
    when: isoToLaWallClock(listing.scheduledStart),
    duration: String(listing.durationMinutes ?? EMPTY_VALUES.duration),
    seats: String(listing.seatCapacity ?? EMPTY_VALUES.seats),
    price: centsToDollars(listing.pricePerSeatCents ?? 0),
    // ADR-010: precise address only when the payload carries it (owner/privileged read).
    street:
      listing.addressLine1 !== undefined && listing.addressLine1 !== null
        ? listing.addressLine1
        : '',
    street2:
      listing.addressLine2 !== undefined && listing.addressLine2 !== null
        ? listing.addressLine2
        : '',
    city: listing.city || '',
    region: listing.region || '',
    zip: listing.postalCode !== undefined && listing.postalCode !== null ? listing.postalCode : '',
    country: listing.country || 'US',
  };
}

/** Only the keys whose value differs from the original body (PATCH: at least one required). */
export function changedFields(originalBody, nextBody) {
  const diff = {};
  const keys = new Set([...Object.keys(originalBody), ...Object.keys(nextBody)]);
  for (const key of keys) {
    const before = JSON.stringify(originalBody[key] ?? null);
    const after = JSON.stringify(nextBody[key] ?? null);
    if (before !== after) diff[key] = nextBody[key];
  }
  return diff;
}

export default function EditMealPage() {
  usePageTitle('Edit your meal');
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, status } = useSession();
  const { announce, announceError } = useAnnounce();
  const [load, setLoad] = useState({ phase: 'loading', listing: null, message: '' });
  const [busy, setBusy] = useState(false);
  const [serverIssues, setServerIssues] = useState([]);
  const [general, setGeneral] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ phase: 'loading', listing: null, message: '' });
    api.listings.getListing(id).then(
      ({ listing }) => {
        if (!cancelled) setLoad({ phase: 'ready', listing, message: '' });
      },
      (err) => {
        if (cancelled) return;
        const message = hostErrorMessage(err);
        setLoad({ phase: 'error', listing: null, message });
        announceError(message);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [id, announceError]);

  const listing = load.listing;
  const isOwner = Boolean(listing && user && listing.hostId === user.id);
  const initial = listing ? valuesFromListing(listing) : null;

  async function handleSubmit({ body }) {
    // Compare against the body the ORIGINAL values would produce, so untouched fields are
    // never sent (an unchanged title must not reset moderation).
    const diff = changedFields(toBody(initial), body);
    if (Object.keys(diff).length === 0) {
      const message = 'Nothing changed — edit a field before saving.';
      setGeneral(message);
      announceError(message);
      return;
    }
    setBusy(true);
    setServerIssues([]);
    setGeneral(null);
    try {
      await api.listings.update(id, diff);
      setBusy(false);
      announce(
        'Meal updated. If you changed the title, description, ingredients, allergens or cuisine, ' +
          'it goes back to moderation review before guests see the change.'
      );
      navigate(`/listings/${encodeURIComponent(id)}`);
    } catch (err) {
      setBusy(false);
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
    }
  }

  return (
    <>
      <h1>Edit your meal</h1>

      {status === 'anonymous' ? (
        <p>
          <Link to="/login">Sign in</Link> to edit a meal you host.
        </p>
      ) : null}

      {status !== 'anonymous' && load.phase === 'loading' ? (
        <Spinner label="Loading your meal" />
      ) : null}

      {load.phase === 'error' ? (
        <>
          <p className={styles.errorBox}>{load.message}</p>
          <p>
            <Link to="/search">Browse meals</Link>
          </p>
        </>
      ) : null}

      {load.phase === 'ready' && status === 'authenticated' && !isOwner ? (
        <p className={styles.errorBox}>
          Only the host who created this meal can edit it.{' '}
          <Link to={`/listings/${encodeURIComponent(id)}`}>View the meal</Link>.
        </p>
      ) : null}

      {load.phase === 'ready' && isOwner ? (
        <>
          <p className={styles.lead}>
            <Link to={`/listings/${encodeURIComponent(id)}`}>Back to the meal</Link>. Changing the
            title, description, ingredients, allergens or cuisine sends the meal back to moderation
            review; schedule and seat changes are re-checked against the MEHKO caps.
          </p>
          {general ? <p className={styles.errorBox}>{general}</p> : null}
          <MealForm
            initial={initial}
            requireFuture={false}
            submitLabel="Save changes"
            busyLabel="Saving…"
            busy={busy}
            serverIssues={serverIssues}
            onSubmit={handleSubmit}
          />
        </>
      ) : null}
    </>
  );
}
