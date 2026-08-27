// client/src/features/moderation/AlertsPage.jsx — U6-ACCOUNT-MOD: the FR-07 safety-alert
// moderator view (delivery lifecycle + AB-04 escalation).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-07 (TC-07, IT-04) — GET /api/moderation/alerts lists every raised alert with its
//     delivery status; an alert stays listed HOWEVER its delivery ends, including the
//     terminal 'failed' state the outbox worker records when retries are exhausted and the
//     job dead-letters — this screen names that state honestly so a moderator can follow
//     up manually. Status vocabulary transcribed from src/schemas/safety.js
//     (ALERT_DELIVERY_STATUSES).
//   AB-04 — POST /api/moderation/alerts escalates flagged content by raising a real alert
//     on the booking behind it (bookingId only, free text deliberately absent). The 201
//     comes back BEFORE any delivery (ADR-001/003: the worker delivers), so the
//     confirmation says "recorded", never "delivered".
//   AB-08 — the queue serves IDs, lifecycle state and timestamps only; the screen renders
//     exactly that and requests nothing wider (no address, name or contact value exists in
//     the payload).
//   FR-08 role gate — ModeratorGate client-side is UX; the server's 403 is the enforcement
//     and renders the same clean 403 screen.
//   NFR-07 — one h1 + document.title; the filter and the escalation field are labelled;
//     list semantics with per-alert headings; loading, empty, error and escalation
//     outcomes all announced through the shell's aria-live channel.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  ErrorSummary,
  FormField,
  Select,
  Spinner,
  TextInput,
  useAnnounce,
} from '../../ui/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import { api, ApiError } from '../../api/index.js';
import ModeratorGate, { ForbiddenScreen } from './components/ModeratorGate.jsx';
import { messageForModerationError } from './components/errorCopy.js';
import styles from './moderation.module.css';

// Transcribed from src/schemas/safety.js ALERT_DELIVERY_STATUSES; the 'failed' terminal
// state is what an exhausted, dead-lettered outbox job leaves behind
// (src/outbox/handlers/safetyAlert.js) — named as such for honest moderator follow-up.
const DELIVERY_STATES = {
  pending: {
    label: 'Pending',
    detail: 'Queued — the background worker will email the emergency contact.',
  },
  retrying: {
    label: 'Retrying',
    detail: 'A delivery attempt failed; the worker is retrying with backoff.',
  },
  delivered: {
    label: 'Delivered',
    detail: 'The emergency-contact email was delivered.',
  },
  failed: {
    label: 'Failed (dead-lettered)',
    detail:
      'Every delivery attempt failed and the job is dead-lettered — the alert stays listed here; follow up manually.',
  },
  no_channel: {
    label: 'No channel',
    detail: 'The raiser has no emergency contact on file, so there was nothing to email.',
  },
};
const PAGE_SIZE = 20;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function statusClass(status) {
  if (status === 'failed') return styles.statusFailed;
  if (status === 'delivered') return styles.statusDelivered;
  return undefined;
}

/** AB-04 escalation: a moderator raises a real alert on the booking behind flagged content. */
function EscalationForm({ onEscalated }) {
  const { announce, announceError } = useAnnounce();
  const [bookingId, setBookingId] = useState('');
  const [fieldErrors, setFieldErrors] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const cleanId = bookingId.trim();
    if (!UUID_SHAPE.test(cleanId)) {
      setFieldErrors([
        {
          fieldId: 'escalate-booking-id',
          message: 'Enter the booking ID as a UUID (as shown on the flagged content)',
        },
      ]);
      return;
    }
    setFieldErrors([]);
    setBusy(true);
    try {
      await api.safety.escalateAlert({ bookingId: cleanId });
      // ADR-001/003: recorded, not delivered — the worker delivers in the background. The
      // confirmation is visible text AND announced (the queue-reload announcement follows).
      const message = `Safety alert recorded for booking ${cleanId}. Delivery to the emergency contact happens in the background — watch its delivery status in this queue.`;
      setNotice(message);
      announce(message);
      setBookingId('');
      onEscalated();
    } catch (err) {
      const message = messageForModerationError(err);
      setError(message);
      announceError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="escalate-heading">
      <h2 id="escalate-heading">Escalate flagged content</h2>
      <p className={styles.lead}>
        Escalating raises a real safety alert on the booking behind flagged content (AB-04): the
        emergency-contact email is queued and the alert joins this list. Only the booking ID travels
        — no free text.
      </p>
      <ErrorSummary errors={fieldErrors} />
      {error !== null && <p className={styles.errorBox}>{error}</p>}
      {notice !== null && <p className={styles.noticeBox}>{notice}</p>}
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <FormField
          id="escalate-booking-id"
          label="Booking ID"
          required
          error={fieldErrors.length > 0 ? fieldErrors[0].message : undefined}
        >
          <TextInput value={bookingId} onChange={(event) => setBookingId(event.target.value)} />
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" busy={busy}>
            Raise safety alert
          </Button>
        </div>
      </form>
    </section>
  );
}

function AlertsContent() {
  const { announce, announceError } = useAnnounce();
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [reloadTick, setReloadTick] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api.safety
      .listModerationAlerts({
        status: statusFilter || undefined,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((data) => {
        if (cancelled) return;
        setResult(data);
        setLoading(false);
        announce(
          `Safety alerts loaded — ${data.total} alert${data.total === 1 ? '' : 's'} for this filter.`
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setLoadError(err);
        if (!(err instanceof ApiError && err.status === 403)) {
          announceError(messageForModerationError(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, page, reloadTick, announce, announceError]);

  if (loadError instanceof ApiError && loadError.status === 403) {
    return <ForbiddenScreen />;
  }

  const total = result ? result.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <EscalationForm
        onEscalated={() => {
          setPage(1);
          setReloadTick((tick) => tick + 1);
        }}
      />

      <div className={styles.filters}>
        <FormField id="alerts-filter-status" label="Delivery status">
          <Select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All delivery statuses</option>
            {Object.keys(DELIVERY_STATES).map((value) => (
              <option key={value} value={value}>
                {DELIVERY_STATES[value].label}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      {loading ? (
        <Spinner label="Loading safety alerts" />
      ) : loadError !== null ? (
        <>
          <p className={styles.errorBox}>{messageForModerationError(loadError)}</p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
              Try again
            </Button>
          </div>
        </>
      ) : result.alerts.length === 0 ? (
        <p className={styles.noticeBox}>No safety alerts for this filter.</p>
      ) : (
        <>
          <ul className={styles.itemList}>
            {result.alerts.map((alert) => {
              const state = DELIVERY_STATES[alert.deliveryStatus] || {
                label: alert.deliveryStatus,
                detail: '',
              };
              const headingId = `alert-${alert.id}-heading`;
              return (
                <Card as="li" key={alert.id} aria-labelledby={headingId}>
                  <h3 id={headingId}>
                    Safety alert —{' '}
                    <span className={statusClass(alert.deliveryStatus)}>{state.label}</span>
                  </h3>
                  {state.detail !== '' && <p className={styles.meta}>{state.detail}</p>}
                  <dl className={styles.metaList}>
                    <dt>Booking</dt>
                    <dd>
                      {alert.bookingId}
                      {alert.bookingStatus ? ` (${alert.bookingStatus})` : ''}
                    </dd>
                    <dt>Listing</dt>
                    <dd>{alert.listingId}</dd>
                    <dt>Raised by</dt>
                    <dd>{alert.raisedByUserId}</dd>
                    <dt>Raised at</dt>
                    <dd>{formatInstant(alert.createdAt)}</dd>
                    <dt>Delivered at</dt>
                    <dd>
                      {alert.deliveredAt ? formatInstant(alert.deliveredAt) : 'Not delivered'}
                    </dd>
                  </dl>
                </Card>
              );
            })}
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
              Page {page} of {totalPages} ({total} alert{total === 1 ? '' : 's'})
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

export default function AlertsPage() {
  usePageTitle('Safety alerts');
  return (
    <>
      <h1>Safety alerts</h1>
      <nav aria-label="Moderation views" className={styles.subnav}>
        <Link to="/moderation">Review queue</Link>
        <Link to="/moderation/alerts" aria-current="page">
          Safety alerts
        </Link>
      </nav>
      <p className={styles.lead}>
        Every raised alert (FR-07) is listed here for review whatever happened to its
        emergency-contact delivery — pending, retrying, delivered, failed after exhausted retries
        (dead-lettered), or without a channel.
      </p>
      <ModeratorGate>
        <AlertsContent />
      </ModeratorGate>
    </>
  );
}
