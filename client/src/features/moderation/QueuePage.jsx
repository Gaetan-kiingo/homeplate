// client/src/features/moderation/QueuePage.jsx — U6-ACCOUNT-MOD: the FR-08 moderator review
// queue (the NFR-07 "moderator queue" interface).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-08 (TC-08) — GET /api/moderation/queue with status/content-type filters and paging;
//     POST /api/moderation/queue/:id/decision records approve/reject + category + optional
//     note (the human stage of the ADR-002 pipeline — approved content publishes, rejected
//     never does; the queue lists ALL FOUR content types incl. safety_alert, W4-F1). The
//     filter/category vocabularies below are transcribed from src/schemas/moderation.js —
//     the server schema stays the enforcement.
//   AB-08 — the screen renders exactly what the allowlist serializer serves (IDs, excerpt,
//     lifecycle state) and requests nothing wider; no address, coordinate or author
//     identity is ever displayed because none is ever served.
//   FR-08 role gate — ModeratorGate client-side is UX; the server's 403 is the enforcement
//     and renders the same clean 403 screen (non-moderators never see queue content).
//   NFR-07 — one h1 + document.title; filters and decision controls labelled via
//     FormField/Select; list semantics (ul/li with per-item headings); loading, empty,
//     error and decision outcomes all announced through the shell's aria-live channel.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, FormField, Select, Spinner, TextArea, useAnnounce } from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import { api, ApiError } from '../../api/index.js';
import ModeratorGate, { ForbiddenScreen } from './components/ModeratorGate.jsx';
import { messageForModerationError } from './components/errorCopy.js';
import styles from './moderation.module.css';

// Transcribed from src/schemas/moderation.js (QUEUE_STATUSES / CONTENT_TYPES / CATEGORIES).
const STATUS_LABELS = { open: 'Open', in_review: 'In review', resolved: 'Resolved' };
const TYPE_LABELS = {
  listing: 'Listing',
  review: 'Review',
  message: 'Message',
  safety_alert: 'Safety alert',
};
const CATEGORIES = ['offensive', 'spam', 'fraudulent', 'benign'];
const PAGE_SIZE = 20;

function formatInstant(iso) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return String(iso);
  return parsed.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

/** One queue entry with its own decision form (open items) or its resolution record. */
function QueueItem({ item, onDecided }) {
  const { announce, announceError } = useAnnounce();
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [categoryError, setCategoryError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // 'approve' | 'reject' | null

  const headingId = `queue-item-${item.id}-heading`;
  const resolved = item.status === 'resolved';

  async function decide(decision) {
    if (category === '') {
      setCategoryError('Choose a category before recording a decision');
      return;
    }
    setCategoryError(null);
    setError(null);
    setBusy(decision);
    try {
      const body = { decision, category };
      if (note.trim() !== '') {
        body.note = note.trim();
      }
      const result = await api.moderation.decide(item.id, body);
      announce(
        `Decision recorded: ${decision === 'approve' ? 'approved' : 'rejected'} as ${category}.`
      );
      onDecided(result.item);
    } catch (err) {
      const message = messageForModerationError(err);
      setError(message);
      announceError(message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card as="li" aria-labelledby={headingId}>
      <h3 id={headingId}>
        {TYPE_LABELS[item.contentType] || item.contentType} —{' '}
        {STATUS_LABELS[item.status] || item.status}
      </h3>
      <p className={styles.meta}>
        Queued {formatInstant(item.createdAt)} · Reason: {item.reason || 'flagged'} · Content{' '}
        {item.contentId}
      </p>
      {item.excerpt ? (
        <p className={styles.excerpt}>{item.excerpt}</p>
      ) : item.contentType === 'safety_alert' ? (
        <p className={styles.excerpt}>
          Safety alert — it carries no text content by design. Delivery details are in the{' '}
          <Link to="/moderation/alerts">safety alerts view</Link>.
        </p>
      ) : (
        <p className={styles.excerpt}>No text excerpt available for this item.</p>
      )}
      {item.latestDecision !== null && item.latestDecision !== undefined && (
        <p className={styles.meta}>
          Latest decision: {item.latestDecision.outcome} ({item.latestDecision.category}
          {item.latestDecision.confidence !== null
            ? `, confidence ${item.latestDecision.confidence}`
            : ''}
          ) on {formatInstant(item.latestDecision.createdAt)}
        </p>
      )}
      {error !== null && <p className={styles.errorBox}>{error}</p>}
      {resolved ? (
        <p className={styles.meta}>
          Resolved {item.resolvedAt ? formatInstant(item.resolvedAt) : ''} — no further action
          possible here.
        </p>
      ) : (
        <div className={styles.decisionForm}>
          <FormField
            id={`queue-item-${item.id}-category`}
            label="Category"
            required
            error={categoryError}
          >
            <Select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">Choose a category…</option>
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            id={`queue-item-${item.id}-note`}
            label="Note (optional)"
            hint="Stored with the decision record; never shown publicly."
          >
            <TextArea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </FormField>
          <div className={styles.actions}>
            <Button busy={busy === 'approve'} onClick={() => decide('approve')}>
              Approve
            </Button>
            <Button variant="danger" busy={busy === 'reject'} onClick={() => decide('reject')}>
              Reject
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function QueueContent() {
  const { announce, announceError } = useAnnounce();
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [reloadTick, setReloadTick] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api.moderation
      .queue({
        status: statusFilter || undefined,
        contentType: typeFilter || undefined,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((data) => {
        if (cancelled) return;
        setResult(data);
        setLoading(false);
        announce(
          `Moderation queue loaded — ${data.total} item${data.total === 1 ? '' : 's'} for these filters.`
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setLoadError(err);
        // The 403 renders as the ForbiddenScreen below; announcing it twice would be noise.
        if (!(err instanceof ApiError && err.status === 403)) {
          announceError(messageForModerationError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, typeFilter, page, reloadTick, announce, announceError]);

  // Server-side enforcement surfaced honestly: the API refused this account (AB-08).
  if (loadError instanceof ApiError && loadError.status === 403) {
    return <ForbiddenScreen />;
  }

  function handleDecided(updatedItem) {
    setResult((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((existing) =>
          existing.id === updatedItem.id
            ? {
                ...existing,
                ...updatedItem,
                // The decision response reloads no content row; keep what we already had.
                excerpt: updatedItem.excerpt ?? existing.excerpt,
                contentStatus: updatedItem.contentStatus ?? existing.contentStatus,
              }
            : existing
        ),
      };
    });
  }

  const total = result ? result.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className={styles.filters}>
        <FormField id="queue-filter-status" label="Status">
          <Select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {Object.keys(STATUS_LABELS).map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField id="queue-filter-type" label="Content type">
          <Select
            value={typeFilter}
            onChange={(event) => {
              setTypeFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All content types</option>
            {Object.keys(TYPE_LABELS).map((value) => (
              <option key={value} value={value}>
                {TYPE_LABELS[value]}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      {loading ? (
        <Spinner label="Loading the moderation queue" />
      ) : loadError !== null ? (
        <>
          <p className={styles.errorBox}>{messageForModerationError(loadError)}</p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
              Try again
            </Button>
          </div>
        </>
      ) : result.items.length === 0 ? (
        <p className={styles.noticeBox}>
          Nothing awaiting review for these filters — the queue is empty.
        </p>
      ) : (
        <>
          <ul className={styles.itemList}>
            {result.items.map((item) => (
              <QueueItem key={item.id} item={item} onDecided={handleDecided} />
            ))}
          </ul>
          <div className={styles.pager}>
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous page
            </Button>
            <span>
              Page {page} of {totalPages} ({total} item{total === 1 ? '' : 's'})
            </span>
            <Button
              variant="secondary"
              disabled={page >= totalPages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next page
            </Button>
          </div>
        </>
      )}
    </>
  );
}

export default function QueuePage() {
  usePageTitle('Moderation queue');
  return (
    <>
      <h1>Moderation queue</h1>
      <nav aria-label="Moderation views" className={styles.subnav}>
        <Link to="/moderation" aria-current="page">
          Review queue
        </Link>
        <Link to="/moderation/alerts">Safety alerts</Link>
      </nav>
      <p className={styles.lead}>
        Content flagged by the two-stage pipeline (FR-08) waits here as <em>pending</em> and is
        never public until approved. Decisions are recorded with a category; rejections never
        publish.
      </p>
      <ModeratorGate>
        <QueueContent />
      </ModeratorGate>
    </>
  );
}
