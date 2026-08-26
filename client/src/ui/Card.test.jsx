// client/src/ui/Card.test.jsx — U5-UI-KIT specs (NFR-07): the grouping container takes the
// semantics the CALLER needs (article/section/plain div), never forcing a generic wrapper.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Card from './Card.jsx';

describe('Card', () => {
  it('renders its children in a plain container by default', () => {
    render(<Card data-testid="card">Paella night</Card>);
    const card = screen.getByTestId('card');
    expect(card.tagName).toBe('DIV');
    expect(card).toHaveTextContent('Paella night');
  });

  it('takes caller-chosen semantics via `as` (e.g. an article per listing result)', () => {
    render(
      <Card as="article" aria-labelledby="listing-1-title">
        <h3 id="listing-1-title">Paella night</h3>
      </Card>
    );
    expect(screen.getByRole('article', { name: 'Paella night' })).toBeInTheDocument();
  });

  it('merges a caller className after the kit class', () => {
    render(
      <Card data-testid="card" className="extra">
        x
      </Card>
    );
    const classes = screen.getByTestId('card').className.split(' ');
    expect(classes).toContain('extra');
    expect(classes.length).toBeGreaterThan(1);
  });
});
