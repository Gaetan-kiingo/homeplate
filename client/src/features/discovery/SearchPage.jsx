// client/src/features/discovery/SearchPage.jsx — the FR-01 search/browse screen
// (U6-DISCOVERY; SPMP WA-9; the NFR-07 "search/browse" interface at /search).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-01 — filterable discovery over GET /api/listings/search via api.search(): location
//     (+radiusKm), from/to time window, cuisine and hostId — exactly the filters
//     src/schemas/search.js accepts, nothing invented. An empty query is a plain browse.
//     Filters live in the URL query string, so results are shareable and the back button
//     works; the hostId filter arrives by link from a host profile and shows as a clearable
//     active-filter notice (users never type UUIDs).
//   NFR-09 — ALL THREE api.search() states are rendered and announced: 'ok' (fresh results +
//     result count), 'degraded' (the STALE results still render, under a visible explanation
//     that is also announced politely), 'unavailable' (the server's SEARCH_DEGRADED
//     user-facing message with a retry control). A terminal state is never a bare spinner
//     and never a crash; transport failure (NETWORK_ERROR) renders the same way.
//   NFR-07 — one h1 + document.title per route; every filter is labelled via the kit's
//     FormField; client-side field errors follow the ErrorSummary pattern (role=alert,
//     programmatic focus, per-field links); async results and failures are announced via
//     the app-wide aria-live channel (useAnnounce).
//   AB-08 — the endpoint is session-gated server-side: a 401 redirects to /login with a
//     `next` parameter instead of dead-ending. Results carry ADR-010 coarse location only.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/index.js';
import { Button, ErrorSummary, FormField, Spinner, TextInput } from '../../ui/index.js';
import { useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import ListingCard from './components/ListingCard.jsx';
import { loginPath } from './components/paths.js';
import { isoToLocalInput } from './components/format.js';
import styles from './discovery.module.css';

/** NFR-09 degraded-state explanation — shown next to the stale results AND announced. */
export const DEGRADED_EXPLANATION =
  'Live location search is temporarily unavailable, so these results come from recently ' +
  'saved data and may be out of date.';

/** The form's editable fields, initialized from (and written back to) the URL query. */
function formFromParams(params) {
  return {
    location: params.get('location') || '',
    radiusKm: params.get('radiusKm') || '',
    from: isoToLocalInput(params.get('from')),
    to: isoToLocalInput(params.get('to')),
    cuisine: params.get('cuisine') || '',
  };
}

/** URL query → api.search() params (src/schemas/search.js keys only; empty values absent). */
function queryFromParams(params) {
  const query = {};
  for (const key of ['location', 'radiusKm', 'from', 'to', 'cuisine', 'hostId', 'page']) {
    const value = params.get(key);
    if (value !== null && value !== '') query[key] = value;
  }
  return query;
}

/** Client-side pre-submit checks — shape-level only; the server schema stays authoritative. */
function validateForm(form) {
  const errors = [];
  if (form.radiusKm.trim() !== '') {
    const radius = Number(form.radiusKm);
    if (!Number.isFinite(radius) || radius <= 0) {
      errors.push({
        fieldId: 'filter-radius',
        message: 'Search radius must be a positive number of kilometres.',
      });
    }
  }
  const from = form.from ? new Date(form.from) : null;
  const to = form.to ? new Date(form.to) : null;
  if (from && Number.isNaN(from.getTime())) {
    errors.push({ fieldId: 'filter-from', message: 'Enter a valid date and time.' });
  }
  if (to && Number.isNaN(to.getTime())) {
    errors.push({ fieldId: 'filter-to', message: 'Enter a valid date and time.' });
  }
  if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from > to) {
    errors.push({
      fieldId: 'filter-to',
      message: '“Available until” must not be before “Available from”.',
    });
  }
  return errors;
}

export default function SearchPage() {
  usePageTitle('Find a meal');
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { announce, announceError } = useAnnounce();

  const [form, setForm] = useState(() => formFromParams(searchParams));
  const [fieldErrors, setFieldErrors] = useState([]);
  const [phase, setPhase] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [result, setResult] = useState(null); // api.search() state object (NFR-09)
  const [error, setError] = useState(null); // ApiError for failures api.search() throws

  // Keep the form in step with the URL (submit, pagination, back/forward navigation).
  useEffect(() => {
    setForm(formFromParams(searchParams));
  }, [searchParams]);

  // Run the search whenever the URL query changes. The URL is the single source of truth.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      setPhase('loading');
      setError(null);
      try {
        const outcome = await api.search(queryFromParams(searchParams));
        if (cancelled) return;
        setResult(outcome);
        setPhase('ready');
        if (outcome.state === 'ok') {
          const count = Number.isFinite(outcome.total) ? outcome.total : outcome.listings.length;
          announce(
            count === 0
              ? 'No meals matched your search.'
              : `${count} ${count === 1 ? 'meal' : 'meals'} found.`
          );
        } else if (outcome.state === 'degraded') {
          announce(DEGRADED_EXPLANATION);
        } else {
          announceError(outcome.error.message);
        }
      } catch (err) {
        if (cancelled) return;
        if (err && err.status === 401) {
          // AB-08: search is session-gated — send the user to sign in, keeping their query.
          navigate(loginPath(location), { replace: true });
          return;
        }
        setError(err);
        setPhase('error');
        announceError(err && err.message ? err.message : 'The search failed.');
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [searchParams, navigate, location, announce, announceError]);

  function fieldError(fieldId) {
    const entry = fieldErrors.find((e) => e.fieldId === fieldId);
    return entry ? entry.message : undefined;
  }

  function setField(name, value) {
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function onSubmit(event) {
    event.preventDefault();
    const errors = validateForm(form);
    setFieldErrors(errors);
    if (errors.length > 0) return; // ErrorSummary takes focus and announces (role=alert).
    const next = new URLSearchParams();
    if (form.location.trim()) next.set('location', form.location.trim());
    if (form.radiusKm.trim()) next.set('radiusKm', form.radiusKm.trim());
    // datetime-local values carry no timezone; the ISO instant does (src/schemas/search.js
    // requires timezone-carrying datetimes — ADR-009: the server never guesses a zone).
    if (form.from) next.set('from', new Date(form.from).toISOString());
    if (form.to) next.set('to', new Date(form.to).toISOString());
    if (form.cuisine.trim()) next.set('cuisine', form.cuisine.trim());
    const hostId = searchParams.get('hostId');
    if (hostId) next.set('hostId', hostId); // the active host filter survives re-filtering
    setSearchParams(next); // page resets to 1 (no page key)
  }

  function clearHostFilter() {
    const next = new URLSearchParams(searchParams);
    next.delete('hostId');
    next.delete('page');
    setSearchParams(next);
  }

  function goToPage(nextPage) {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(nextPage));
    setSearchParams(next);
  }

  function retry() {
    setSearchParams(new URLSearchParams(searchParams));
  }

  const hostFilterActive = searchParams.get('hostId') !== null;

  let content;
  if (phase === 'loading') {
    content = <Spinner label="Searching for meals" />;
  } else if (phase === 'error') {
    content = (
      <section aria-labelledby="search-error-heading" className={styles.errorBox}>
        <h2 id="search-error-heading">Search failed</h2>
        <p>{error.message}</p>
        {error.code === 'VALIDATION_FAILED' ? (
          <p>Check the filter values above and search again.</p>
        ) : null}
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </section>
    );
  } else if (result.state === 'unavailable') {
    // NFR-09: no answer is possible right now — the server's typed SEARCH_DEGRADED message.
    content = (
      <section aria-labelledby="search-unavailable-heading" className={styles.errorBox}>
        <h2 id="search-unavailable-heading">Search is unavailable</h2>
        <p>{result.error.message}</p>
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      </section>
    );
  } else {
    // 'ok' or 'degraded' — degraded still renders the (stale) results, with an explanation.
    const listings = result.listings;
    const page = Number.isFinite(result.page) ? result.page : 1;
    const totalPages =
      Number.isFinite(result.total) && Number.isFinite(result.pageSize) && result.pageSize > 0
        ? Math.max(1, Math.ceil(result.total / result.pageSize))
        : 1;
    content = (
      <section aria-labelledby="search-results-heading">
        <h2 id="search-results-heading">Results</h2>
        {result.state === 'degraded' ? (
          <p className={styles.stateBox}>{DEGRADED_EXPLANATION}</p>
        ) : null}
        {listings.length === 0 ? (
          <p className={styles.stateBox}>
            No meals matched your search. Try widening the time window, increasing the radius, or
            clearing a filter.
          </p>
        ) : (
          <ul className={styles.resultsList}>
            {listings.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </ul>
        )}
        {totalPages > 1 ? (
          <nav aria-label="Search result pages" className={styles.pager}>
            <Button variant="secondary" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
              Previous page
            </Button>
            <p className={styles.pageStatus}>
              Page {page} of {totalPages}
            </p>
            <Button
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => goToPage(page + 1)}
            >
              Next page
            </Button>
          </nav>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <h1>Find a meal</h1>
      <p className={styles.lede}>
        Browse home-cooked meals shared by approved hosts near you. Every filter is optional —
        search with none to see everything that is coming up.
      </p>
      <ErrorSummary errors={fieldErrors} />
      <form
        role="search"
        aria-label="Meal filters"
        onSubmit={onSubmit}
        className={styles.searchForm}
      >
        <FormField
          id="filter-location"
          label="Location"
          hint="Neighbourhood or city, for example La Jolla"
        >
          <TextInput
            value={form.location}
            onChange={(e) => setField('location', e.target.value)}
            autoComplete="off"
          />
        </FormField>
        <FormField
          id="filter-radius"
          label="Search radius (km)"
          hint="Kilometres around the location, for example 10"
          error={fieldError('filter-radius')}
        >
          <TextInput
            inputMode="decimal"
            value={form.radiusKm}
            onChange={(e) => setField('radiusKm', e.target.value)}
            autoComplete="off"
          />
        </FormField>
        <FormField id="filter-from" label="Available from" error={fieldError('filter-from')}>
          <TextInput
            type="datetime-local"
            value={form.from}
            onChange={(e) => setField('from', e.target.value)}
          />
        </FormField>
        <FormField id="filter-to" label="Available until" error={fieldError('filter-to')}>
          <TextInput
            type="datetime-local"
            value={form.to}
            onChange={(e) => setField('to', e.target.value)}
          />
        </FormField>
        <FormField id="filter-cuisine" label="Cuisine" hint="For example Ethiopian, Mexican">
          <TextInput
            value={form.cuisine}
            onChange={(e) => setField('cuisine', e.target.value)}
            autoComplete="off"
          />
        </FormField>
        <div className={styles.formActions}>
          <Button type="submit">Search</Button>
        </div>
      </form>
      {hostFilterActive ? (
        <div className={styles.filterChip}>
          <p>Showing meals from a single host only.</p>
          <Button variant="secondary" onClick={clearHostFilter}>
            Show meals from all hosts
          </Button>
        </div>
      ) : null}
      {content}
    </>
  );
}
