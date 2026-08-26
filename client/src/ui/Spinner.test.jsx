// client/src/ui/Spinner.test.jsx — U5-UI-KIT specs (NFR-07): the loading state is a polite
// live region with a TEXT alternative; the animated circle is hidden from assistive tech.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Spinner from './Spinner.jsx';

describe('Spinner (NFR-07)', () => {
  it('is a role="status" live region with a default text alternative', () => {
    render(<Spinner />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading');
  });

  it('lets screens say WHAT is loading', () => {
    render(<Spinner label="Searching nearby meals" />);
    expect(screen.getByRole('status')).toHaveTextContent('Searching nearby meals');
  });

  it('hides the animated circle from assistive technology', () => {
    const { container } = render(<Spinner />);
    const hidden = container.querySelector('[aria-hidden="true"]');
    expect(hidden).not.toBeNull();
    expect(hidden).toHaveTextContent('');
  });
});
