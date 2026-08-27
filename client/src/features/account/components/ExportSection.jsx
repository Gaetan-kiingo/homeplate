// client/src/features/account/components/ExportSection.jsx — U6-ACCOUNT-MOD: the NFR-13
// data-export request + retrieval flow on /account.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-13 (ST-06) — POST /api/users/me/export answers 202 with the request row (the worker
//     assembles the §3.4 register copy; the due date is the statutory 30-day SLA); GET
//     /api/users/me/export/:id serves the owner's view, with `data` present once status is
//     'completed'. The UI mirrors exactly that lifecycle: request → status/due date →
//     check → retrieve. It never pretends the copy is instant.
//   NFR-07 — the retrieved copy renders in a labelled read-only textarea (natively
//     focusable and keyboard-scrollable — no unfocusable scroll region); every state change
//     is announced via the shell's aria-live channel.
import { useState } from 'react';
import { Button, FormField, TextArea, useAnnounce } from '../../../ui/index.js';
import { api } from '../../../api/index.js';
import { messageForAccountError } from './errorCopy.js';
import styles from '../account.module.css';

function formatDateTime(iso) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return String(iso);
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// One label per data_request_status enum value (db/migrations/0001, AMV-W6-03: 'processing'
// is set when the worker picks the job up — src/modules/privacy/repo.js).
const STATUS_LABELS = {
  pending: 'Pending — the copy is being prepared in the background',
  processing: 'Processing — your copy is being assembled',
  completed: 'Completed — your copy is ready',
  failed: 'Failed — please request a new export',
};

export default function ExportSection() {
  const { announce, announceError } = useAnnounce();
  const [request, setRequest] = useState(null); // data_requests row (kind 'export')
  const [exportData, setExportData] = useState(null); // request.data once completed
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  async function handleRequest() {
    setError(null);
    setBusy(true);
    try {
      const { request: row } = await api.users.requestExport();
      setRequest(row);
      announce(
        `Data export requested. It will be ready by ${formatDateTime(row.dueAt)} at the latest.`
      );
    } catch (err) {
      const message = messageForAccountError(err);
      setError(message);
      announceError(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCheck() {
    setError(null);
    setChecking(true);
    try {
      const { export: row } = await api.users.getExport(request.id);
      setRequest(row);
      if (row.status === 'completed' && row.data) {
        setExportData(row.data);
        announce('Your data export is ready — the copy is shown below.');
      } else {
        announce(`${STATUS_LABELS[row.status] || row.status}. The copy is not ready yet.`);
      }
    } catch (err) {
      const message = messageForAccountError(err);
      setError(message);
      announceError(message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <section aria-labelledby="export-heading" className={styles.section}>
      <h2 id="export-heading">Export your data</h2>
      <p className={styles.lead}>
        Request a machine-readable copy of the personal data Homeplate stores about you (NFR-13).
        The copy is prepared in the background; the statutory deadline is 30 days, and it is usually
        much faster.
      </p>
      {error !== null && <p className={styles.errorBox}>{error}</p>}
      {request === null ? (
        <div className={styles.actions}>
          <Button busy={busy} onClick={handleRequest}>
            Request my data export
          </Button>
        </div>
      ) : (
        <>
          <dl className={styles.metaList}>
            <dt>Status</dt>
            <dd>{STATUS_LABELS[request.status] || request.status}</dd>
            <dt>Requested</dt>
            <dd>{formatDateTime(request.createdAt)}</dd>
            <dt>Ready by</dt>
            <dd>{formatDateTime(request.dueAt)} (30-day statutory deadline)</dd>
          </dl>
          {exportData === null && (
            <div className={styles.actions}>
              <Button variant="secondary" busy={checking} onClick={handleCheck}>
                Check export status
              </Button>
            </div>
          )}
          {exportData !== null && (
            <FormField
              id="export-data"
              label="Your exported data (JSON)"
              hint="A machine-readable copy of your §3.4 data register. Select all and copy to save it."
            >
              <TextArea rows={12} readOnly value={JSON.stringify(exportData, null, 2)} />
            </FormField>
          )}
        </>
      )}
    </section>
  );
}
