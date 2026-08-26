// client/src/ui/VisuallyHidden.test.jsx — U5-UI-KIT specs (NFR-07): screen-reader-only text
// stays in the accessibility tree while removed from the visual layout.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import VisuallyHidden from './VisuallyHidden.jsx';

describe('VisuallyHidden', () => {
  it('keeps its text in the accessibility tree', () => {
    render(
      <button type="button">
        <span aria-hidden="true">×</span>
        <VisuallyHidden>Close dialog</VisuallyHidden>
      </button>
    );
    // The hidden text IS the accessible name — proof it reaches assistive technology.
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
  });

  it('renders an element of the caller-chosen type', () => {
    render(<VisuallyHidden as="h2">Results</VisuallyHidden>);
    expect(screen.getByRole('heading', { level: 2, name: 'Results' })).toBeInTheDocument();
  });
});
