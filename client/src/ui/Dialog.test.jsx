// client/src/ui/Dialog.test.jsx — U5-UI-KIT specs (NFR-07 modal contract): aria-modal
// dialog labelled by its title, focus moves in on open, Tab is trapped both directions,
// Escape closes, and focus is RESTORED to the opener on close.
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dialog from './Dialog.jsx';
import Button from './Button.jsx';

function Harness({ useInitialFocus = false, dialogChildren }) {
  const [open, setOpen] = useState(false);
  const confirmRef = useRef(null);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog
        open={open}
        title="Cancel this booking?"
        onClose={() => setOpen(false)}
        initialFocusRef={useInitialFocus ? confirmRef : undefined}
      >
        {dialogChildren || (
          <>
            <p>The host will be notified.</p>
            <Button onClick={() => setOpen(false)}>Keep booking</Button>
            <Button ref={confirmRef} variant="danger">
              Cancel booking
            </Button>
          </>
        )}
      </Dialog>
    </>
  );
}

describe('Dialog (NFR-07 modal pattern)', () => {
  it('renders nothing while closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('open: role="dialog", aria-modal, labelled by its title heading', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Cancel this booking?');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Cancel this booking?' })
    ).toBeInTheDocument();
  });

  it('moves focus into the dialog on open (panel by default)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
  });

  it('honours initialFocusRef', async () => {
    const user = userEvent.setup();
    render(<Harness useInitialFocus />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel booking' })).toHaveFocus()
    );
  });

  it('traps Tab: from the last focusable it wraps to the first', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const last = screen.getByRole('button', { name: 'Cancel booking' });
    last.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Keep booking' })).toHaveFocus();
  });

  it('traps Shift+Tab: from the first focusable it wraps to the last', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const first = screen.getByRole('button', { name: 'Keep booking' });
    first.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toHaveFocus();
  });

  it('keeps focus pinned on the panel when the dialog has no focusable children', async () => {
    const user = userEvent.setup();
    render(<Harness dialogChildren={<p>Read-only notice.</p>} />);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
    await user.tab();
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('Escape closes the dialog and focus RETURNS to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('closing via a button inside the dialog also restores focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Keep booking' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('Escape does nothing once closed (listener detached)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open={false} title="Never shown" onClose={onClose}>
        <p>never</p>
      </Dialog>
    );
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
