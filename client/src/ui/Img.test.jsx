// client/src/ui/Img.test.jsx — U5-UI-KIT specs for alt enforcement (NFR-07: "all images
// carry alt text"). The load-bearing assertions: an <Img> without alt and without an
// explicit `decorative` prop FAILS LOUDLY in dev/test (throws), and in a production build
// degrades to alt="" with a console.error instead of crashing — never an unlabelled image.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Img from './Img.jsx';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Img (NFR-07 alt enforcement)', () => {
  it('renders an image with its required alt text', () => {
    render(<Img src="/media/paella.jpg" alt="Seafood paella served in the pan" />);
    expect(
      screen.getByRole('img', { name: 'Seafood paella served in the pan' })
    ).toBeInTheDocument();
  });

  it('decorative: emits alt="" so assistive tech skips it', () => {
    const { container } = render(<Img src="/media/divider.png" decorative />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('alt', '');
    expect(screen.queryByRole('img')).not.toBeInTheDocument(); // alt="" removes img semantics
  });

  it('throws in dev when alt is missing and decorative is not declared', () => {
    // React logs the thrown error too; keep spec output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Img src="/media/paella.jpg" />)).toThrow(/alt.*required|required.*alt/i);
  });

  it('throws in dev on a whitespace-only alt (an unlabelled image in disguise)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Img src="/media/paella.jpg" alt="   " />)).toThrow(/alt/i);
  });

  it('throws in dev when decorative and a real alt contradict each other', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Img src="/media/paella.jpg" alt="A paella" decorative />)).toThrow(
      /contradict/i
    );
  });

  it('production build: missing alt degrades to alt="" with a console.error, never a crash', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalDev = import.meta.env.DEV;
    import.meta.env.DEV = false;
    try {
      const { container } = render(<Img src="/media/paella.jpg" />);
      const img = container.querySelector('img');
      expect(img).toHaveAttribute('alt', '');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('alt'));
    } finally {
      import.meta.env.DEV = originalDev;
    }
  });
});
