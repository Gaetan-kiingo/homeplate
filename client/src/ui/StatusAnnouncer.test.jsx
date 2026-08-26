// client/src/ui/StatusAnnouncer.test.jsx — U5-UI-KIT specs for the NFR-07 announcement
// channel: the live-region PAIR exists from mount (regions must pre-exist their content for
// assistive tech to announce changes), polite vs assertive routing, re-announcement of an
// identical message, and the mount-discipline dev warnings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StatusAnnouncer, { useAnnounce } from './StatusAnnouncer.jsx';

function Talker({ message, error = false }) {
  const { announce, announceError } = useAnnounce();
  return (
    <button type="button" onClick={() => (error ? announceError(message) : announce(message))}>
      speak
    </button>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatusAnnouncer (NFR-07 aria-live channel)', () => {
  it('mounts BOTH live regions up front: polite role="status" and assertive role="alert"', () => {
    render(<StatusAnnouncer />);
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toBeEmptyDOMElement();
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveAttribute('aria-atomic', 'true');
    expect(alert).toBeEmptyDOMElement();
  });

  it('announce() lands in the polite region only', async () => {
    const user = userEvent.setup();
    render(
      <>
        <StatusAnnouncer />
        <Talker message="Search results updated" />
      </>
    );
    await user.click(screen.getByRole('button', { name: 'speak' }));
    expect(screen.getByRole('status')).toHaveTextContent('Search results updated');
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('announceError() lands in the assertive region only', async () => {
    const user = userEvent.setup();
    render(
      <>
        <StatusAnnouncer />
        <Talker message="No seats left for this meal" error />
      </>
    );
    await user.click(screen.getByRole('button', { name: 'speak' }));
    expect(screen.getByRole('alert')).toHaveTextContent('No seats left for this meal');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('re-announcing the IDENTICAL message still changes the DOM (so it is re-spoken)', async () => {
    const user = userEvent.setup();
    render(
      <>
        <StatusAnnouncer />
        <Talker message="Saved" />
      </>
    );
    const button = screen.getByRole('button', { name: 'speak' });
    await user.click(button);
    const first = screen.getByRole('status').textContent;
    await user.click(button);
    const second = screen.getByRole('status').textContent;
    expect(first).toBe('Saved');
    expect(second).toBe('Saved\u00A0'); // invisible, unspoken suffix — pure change signal
    expect(second).not.toBe(first);
  });

  it('ignores empty and non-string messages', async () => {
    const user = userEvent.setup();
    render(
      <>
        <StatusAnnouncer />
        <Talker message="   " />
      </>
    );
    await user.click(screen.getByRole('button', { name: 'speak' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('returns a stable api object (safe in dependency arrays)', () => {
    let a;
    let b;
    function Probe() {
      a = useAnnounce();
      b = useAnnounce();
      return null;
    }
    render(<Probe />);
    expect(a).toBe(b);
    expect(typeof a.announce).toBe('function');
    expect(typeof a.announceError).toBe('function');
  });

  it('warns in dev when an announcement fires with no announcer mounted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<Talker message="lost words" />); // no <StatusAnnouncer />
    await user.click(screen.getByRole('button', { name: 'speak' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no <StatusAnnouncer />'));
  });

  it('warns in dev when a second announcer mounts (announcements would double-speak)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <>
        <StatusAnnouncer />
        <StatusAnnouncer />
      </>
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('more than one <StatusAnnouncer />'));
  });
});
