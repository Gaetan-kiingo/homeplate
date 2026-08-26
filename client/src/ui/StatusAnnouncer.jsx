// client/src/ui/StatusAnnouncer.jsx — the app-wide aria-live channel (U5-UI-KIT; NFR-07:
// "errors are announced via aria-live"). One <StatusAnnouncer /> is mounted by the shell
// (5C) and stays mounted for the whole session, so BOTH live regions exist in the DOM before
// anything is announced — assistive technology only tracks regions that were present before
// their content changed. The pair:
//   role="status"  aria-live="polite"    — progress/status ("Search results updated");
//   role="alert"   aria-live="assertive" — errors (the ApiError-code messages, FR-level
//                                          failures like NO_CAPACITY / SEARCH_DEGRADED).
// useAnnounce() is how every screen (and the API-client error path) speaks:
//   const { announce, announceError } = useAnnounce();
// The hook talks to the mounted region through a module-scope dispatcher, NOT context, so it
// works from any depth without a provider wrapping the tree. Re-announcing the SAME text
// must still be spoken, so the region alternates an invisible trailing no-break space —
// the DOM text changes every time, the visible/spoken message does not.
import { useEffect, useState } from 'react';
import vhStyles from './VisuallyHidden.module.css';

const listeners = new Set();
let mountedAnnouncers = 0;

function isDev() {
  // Vite statically replaces import.meta.env.DEV (true in dev and vitest, false in builds).
  return import.meta.env.DEV === true || import.meta.env.DEV === 'true';
}

function dispatch(channel, message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) {
    return;
  }
  if (listeners.size === 0 && isDev()) {
    console.warn(
      'Homeplate UI: useAnnounce() fired with no <StatusAnnouncer /> mounted — the message ' +
        `was not announced (${channel}: "${text}"). The shell must mount StatusAnnouncer once.`
    );
  }
  for (const listener of listeners) {
    listener(channel, text);
  }
}

const announceApi = Object.freeze({
  /** Polite status announcement (role="status"): progress, confirmations, result counts. */
  announce: (message) => dispatch('polite', message),
  /** Assertive error announcement (role="alert"): failures the user must hear now. */
  announceError: (message) => dispatch('assertive', message),
});

/** The NFR-07 announcement channel. Stable identity — safe in dependency arrays. */
export function useAnnounce() {
  return announceApi;
}

function regionText({ text, tick }) {
  if (!text) {
    return '';
  }
  // Alternate an invisible no-break space so repeating a message still changes the DOM
  // (screen readers only re-announce on change); U+00A0 is neither visible nor spoken.
  return tick % 2 === 0 ? `${text}\u00A0` : text;
}

export default function StatusAnnouncer() {
  const [status, setStatus] = useState({ text: '', tick: 0 });
  const [error, setError] = useState({ text: '', tick: 0 });

  useEffect(() => {
    function listener(channel, text) {
      if (channel === 'assertive') {
        setError((prev) => ({ text, tick: prev.tick + 1 }));
      } else {
        setStatus((prev) => ({ text, tick: prev.tick + 1 }));
      }
    }
    listeners.add(listener);
    mountedAnnouncers += 1;
    if (mountedAnnouncers > 1 && isDev()) {
      console.warn(
        'Homeplate UI: more than one <StatusAnnouncer /> is mounted — every announcement ' +
          'will be spoken once per instance. Mount it exactly once, in the shell.'
      );
    }
    return () => {
      listeners.delete(listener);
      mountedAnnouncers -= 1;
    };
  }, []);

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className={vhStyles.visuallyHidden}>
        {regionText(status)}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className={vhStyles.visuallyHidden}
      >
        {regionText(error)}
      </div>
    </>
  );
}
