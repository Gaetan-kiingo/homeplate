// client/src/ui/Button.test.jsx — U5-UI-KIT specs (NFR-07): real button semantics, accessible
// name, safe default type, and the aria-busy busy state (announced, non-activating, but
// still focusable — focus must never be dropped mid-action).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Button from './Button.jsx';

describe('Button (NFR-07)', () => {
  it('renders a real <button> with an accessible name and a safe default type', () => {
    render(<Button>Reserve a seat</Button>);
    const button = screen.getByRole('button', { name: 'Reserve a seat' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button'); // never an accidental form submit
  });

  it('honours an explicit type="submit"', () => {
    render(<Button type="submit">Publish listing</Button>);
    expect(screen.getByRole('button', { name: 'Publish listing' })).toHaveAttribute(
      'type',
      'submit'
    );
  });

  it('fires onClick on activation when idle', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('busy: sets aria-busy and aria-disabled, suppresses activation, but stays focusable', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Reserving…
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Reserving…' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled(); // natively enabled: keyboard focus is preserved

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
    // The click landed focus ON the button — proof it stays in the focus order while busy
    // (a natively disabled button could never receive focus).
    expect(button).toHaveFocus();
  });

  it('idle: exposes neither aria-busy nor aria-disabled', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('disabled: native disabled semantics, no click', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Unavailable
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Unavailable' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
