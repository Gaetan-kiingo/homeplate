// client/src/ui/Dialog.jsx — modal dialog (U5-UI-KIT; NFR-07 / WCAG 2.1 AA modal pattern):
//   - role="dialog" + aria-modal="true", labelled by its required title (rendered as the
//     panel's own h2 via aria-labelledby);
//   - on open: the previously focused element is remembered and focus moves INTO the dialog
//     (the panel itself, or `initialFocusRef` for e.g. a primary action / first field);
//   - focus TRAP: Tab / Shift+Tab cycle inside the panel and pull focus back if it ever
//     lands outside (document-level capture listener, attached only while open);
//   - Escape calls onClose; closing (or unmounting while open) RESTORES focus to the
//     element that opened the dialog, so keyboard users are never dropped at document top.
// Closing is the CALLER's state change: render <Dialog open={open} onClose={...}>; the kit
// renders nothing when closed. Callers provide their own close/confirm Buttons as children —
// backdrop clicking is deliberately not a close path (Escape and the buttons are).
// Rendered through a portal so no ancestor overflow/z-index can clip the modal.
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import styles from './Dialog.module.css';

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Dialog({ open, title, onClose, initialFocusRef, children }) {
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);
  const titleId = useId();

  // Focus management: capture the opener on open, restore it on close/unmount (NFR-07).
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    previousFocusRef.current = document.activeElement;
    const target = (initialFocusRef && initialFocusRef.current) || panelRef.current;
    if (target) {
      target.focus();
    }
    return () => {
      const opener = previousFocusRef.current;
      if (opener && typeof opener.focus === 'function' && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open, initialFocusRef]);

  // Keyboard contract: Escape closes; Tab is trapped inside the panel. A document-level
  // capture listener (attached only while open) also recovers focus that escaped the panel.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    function handleKeyDown(event) {
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const focusables = panel.querySelectorAll(FOCUSABLE);
      if (focusables.length === 0) {
        // Nothing tabbable inside: keep focus pinned on the panel itself.
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inPanel = panel.contains(active);
      if (event.shiftKey) {
        if (!inPanel || active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inPanel || active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div className={styles.overlay}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        className={styles.panel}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body
  );
}
