// client/src/features/community/MessagesPage.jsx — U6-COMMUNITY: the FR-06 booking thread
// (route 'bookings/:bookingId/messages'; SPMP WA-4; build-plan G.4 6A).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-06 — participants-only messaging within a booking. The thread reads through
//     GET /api/bookings/:id/messages and writes through POST (api.messages, U5-API-CLIENT).
//     A sent message is DELIVERED IMMEDIATELY: the 201 body renders into the list at once,
//     and nothing here waits on or displays a moderation verdict (ADR-002 — private
//     messages deliver first, are scanned asynchronously; only a rejection hides a message,
//     and the server already filters rejected messages out of the GET — AB-04).
//   FR-08 — the "checked for safety afterwards" copy is the user-facing face of the ADR-002
//     scan; no per-message moderation state is ever rendered.
//   NFR-07 — one h1 + document.title (usePageTitle); the send control is labelled through
//     FormField; send success, background arrivals and every failure are announced through
//     the shell's aria-live regions (useAnnounce); typed refusals (403 NOT_PARTICIPANT,
//     409 BOOKING_CANCELLED, 404, 401, transport) render as real human messages per code,
//     never a stringified body (build-plan G.2).
//   NFR-02 — reads stay inside the server's capped pagination (PAGE_SIZE ≤ the schema cap);
//     a long thread shows its LATEST page with an honest "showing N of T" note instead of
//     demanding an unbounded page.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api/index.js';
import { useSession } from '../../session/index.js';
import usePageTitle from '../../layout/usePageTitle.js';
import { Button, Card, FormField, Spinner, TextArea, useAnnounce } from '../../ui/index.js';
import { messageForError } from './components/communityMessages.js';
import styles from './MessagesPage.module.css';

/** Background-refresh cadence for the thread (FR-06 "periodic refresh"). */
export const REFRESH_INTERVAL_MS = 15000;

/** Messages fetched per read — inside the server's capped pagination (NFR-02; cap 100). */
const PAGE_SIZE = 50;

/** Screen-specific refusal copy on top of the shared community map (G.2 typed codes). */
const MESSAGE_OVERRIDES = {
  BOOKING_CANCELLED: 'This booking is cancelled, so its conversation is closed.',
  NOT_PARTICIPANT:
    "Only this booking's guest or host can read or send messages in this conversation.",
};

/** Human timestamp beside the machine-readable <time dateTime> (NFR-07). */
function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function MessagesPage() {
  usePageTitle('Booking conversation');
  const { bookingId } = useParams();
  const { user } = useSession();
  const { announce, announceError } = useAnnounce();

  const [thread, setThread] = useState({ phase: 'loading' });
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [sending, setSending] = useState(false);
  // Ids already rendered — lets a background refresh announce ONLY genuinely new arrivals
  // (aria-live etiquette: stay silent when nothing changed).
  const knownIdsRef = useRef(null);

  const load = useCallback(
    async ({ background = false } = {}) => {
      try {
        const first = await api.messages.list(bookingId, { page: 1, pageSize: PAGE_SIZE });
        let items = first.items;
        let truncated = false;
        if (first.total > items.length) {
          // Long thread: show the LATEST page of the oldest-first server order, honestly
          // labelled — never an uncapped request (NFR-02).
          const lastPage = Math.ceil(first.total / first.pageSize);
          const latest = await api.messages.list(bookingId, {
            page: lastPage,
            pageSize: PAGE_SIZE,
          });
          items = latest.items;
          truncated = true;
        }
        const known = knownIdsRef.current;
        if (background && known) {
          const fresh = items.filter((message) => !known.has(message.id)).length;
          if (fresh === 1) announce('One new message in the conversation.');
          if (fresh > 1) announce(`${fresh} new messages in the conversation.`);
        }
        knownIdsRef.current = new Set(items.map((message) => message.id));
        setThread({ phase: 'ready', items, total: first.total, truncated });
      } catch (err) {
        if (background) return; // transient poll failure: keep the last good thread view
        const message = messageForError(err, MESSAGE_OVERRIDES);
        setThread({ phase: 'error', message });
        announceError(message);
      }
    },
    [bookingId, announce, announceError]
  );

  useEffect(() => {
    load();
  }, [load]);

  // FR-06 periodic refresh: poll so the other participant's messages arrive without a
  // manual reload; a failed background poll never destroys the visible thread.
  useEffect(() => {
    const timer = setInterval(() => {
      load({ background: true });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function handleSend(event) {
    event.preventDefault();
    const body = draft.trim();
    if (body === '') {
      const message = 'Enter a message before sending.';
      setFieldError(message);
      announceError(message);
      return;
    }
    setFieldError(null);
    setSendError(null);
    setSending(true);
    try {
      const { message } = await api.messages.send(bookingId, body);
      // FR-06/ADR-002: the 201 body IS the delivered message — render it immediately.
      if (knownIdsRef.current) knownIdsRef.current.add(message.id);
      setThread((prev) =>
        prev.phase === 'ready'
          ? {
              ...prev,
              items: [...prev.items.filter((m) => m.id !== message.id), message],
              total: prev.total + 1,
            }
          : prev
      );
      setDraft('');
      announce('Message sent.');
    } catch (err) {
      const message = messageForError(err, MESSAGE_OVERRIDES);
      setSendError(message);
      announceError(message);
    } finally {
      setSending(false);
    }
  }

  function senderLabel(message) {
    return user && message.senderId === user.id ? 'You' : 'Other participant';
  }

  return (
    <>
      <h1>Booking conversation</h1>
      <p>
        Messages are shared between this booking&apos;s guest and host only. They are delivered
        immediately and checked for safety afterwards.
      </p>

      {thread.phase === 'loading' && <Spinner label="Loading the conversation" />}

      {thread.phase === 'error' && (
        <Card as="section" aria-labelledby="thread-error-heading">
          <h2 id="thread-error-heading">Conversation unavailable</h2>
          <p>{thread.message}</p>
        </Card>
      )}

      {thread.phase === 'ready' && (
        <>
          <section aria-labelledby="thread-heading" className={styles.thread}>
            <h2 id="thread-heading">Messages</h2>
            {thread.truncated && (
              <p className={styles.truncationNote}>
                Showing the latest {thread.items.length} of {thread.total} messages.
              </p>
            )}
            {thread.items.length === 0 ? (
              <p>No messages yet — start the conversation below.</p>
            ) : (
              <ul className={styles.messageList}>
                {thread.items.map((message) => (
                  <li
                    key={message.id}
                    className={`${styles.message} ${
                      user && message.senderId === user.id ? styles.messageMine : ''
                    }`}
                  >
                    <p className={styles.messageMeta}>
                      <span className={styles.messageSender}>{senderLabel(message)}</span>{' '}
                      <time dateTime={message.createdAt}>{formatWhen(message.createdAt)}</time>
                    </p>
                    <p className={styles.messageBody}>{message.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="send-heading">
            <h2 id="send-heading">Send a message</h2>
            {/* noValidate: the browser's native required-field bubble would block submit
                BEFORE handleSend runs and is never announced via aria-live; the custom
                validation below owns the empty-send refusal instead (NFR-07 — errors are
                rendered in place AND announced). The native `required` semantics stay on
                the control for assistive technology. */}
            <form onSubmit={handleSend} noValidate>
              <FormField
                id="message-body"
                label="Message"
                required
                hint="Delivered to the other participant immediately."
                error={fieldError}
              >
                <TextArea
                  rows={3}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </FormField>
              {sendError && <p className={styles.sendError}>{sendError}</p>}
              <Button type="submit" busy={sending}>
                Send message
              </Button>
            </form>
          </section>
        </>
      )}
    </>
  );
}
