// client/src/routes.test.jsx — route-discovery contract specs (U5-SHELL; build-plan §6.1
// 5A.3). Proves the wave-6 extension contract with SYNTHETIC glob results (the real
// features/ directory is empty in wave 5 by design) plus the real default tree: home first,
// catch-all 404 last, everything under AppLayout with the root error boundary.
// Rendering specs wrap the ambient <SessionProvider> (AppLayout consumes useSession() since
// 5C) with a rejecting fetch stub, so session status stays 'unknown' with no async updates.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import routes, { buildRoutes, mountFeatureRoutes } from './routes.jsx';
import { SessionProvider } from './session/index.js';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('routes.test: no network in specs');
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mountFeatureRoutes (wave-6 extension contract)', () => {
  it('returns an empty array for an empty glob result (the wave-5 state)', () => {
    expect(mountFeatureRoutes({})).toEqual([]);
  });

  it('flattens default-exported route arrays in deterministic (path-sorted) order', () => {
    const globbed = {
      './features/search/routes.jsx': { default: [{ path: 'search' }, { path: 'browse' }] },
      './features/bookings/routes.jsx': { default: [{ path: 'bookings' }] },
    };
    expect(mountFeatureRoutes(globbed)).toEqual([
      { path: 'bookings' }, // ./features/bookings/… sorts before ./features/search/…
      { path: 'search' },
      { path: 'browse' },
    ]);
  });

  it('rejects a feature module that does not default-export an array, naming the file', () => {
    expect(() =>
      mountFeatureRoutes({ './features/broken/routes.jsx': { default: { path: 'broken' } } })
    ).toThrow(/features\/broken\/routes\.jsx must default-export an ARRAY/);
    expect(() => mountFeatureRoutes({ './features/empty/routes.jsx': {} })).toThrow(
      /features\/empty\/routes\.jsx must default-export an ARRAY/
    );
  });

  it('rejects non-object route entries, naming the file', () => {
    expect(() => mountFeatureRoutes({ './features/bad/routes.jsx': { default: [null] } })).toThrow(
      /features\/bad\/routes\.jsx default-exports a non-object route entry/
    );
  });
});

describe('buildRoutes tree shape', () => {
  it('mounts home as the index route and the 404 catch-all LAST, under the root layout', () => {
    const [root] = routes; // the real, glob-discovered default export
    expect(root.path).toBe('/');
    expect(root.errorElement).toBeTruthy();
    expect(root.children[0].index).toBe(true);
    expect(root.children[root.children.length - 1].path).toBe('*');
  });

  it('mounts injected feature routes between home and the catch-all', () => {
    const [root] = buildRoutes([{ path: 'demo', element: <p>Demo feature screen</p> }]);
    const paths = root.children.map((child) => (child.index ? '<index>' : child.path));
    expect(paths).toEqual(['<index>', 'demo', '*']);
  });
});

describe('routing behaviour (NFR-07: every route inside the landmark layout)', () => {
  it('serves an auto-mounted feature route inside the layout landmarks', () => {
    const router = createMemoryRouter(
      buildRoutes([{ path: 'demo', element: <p>Demo feature screen</p> }]),
      { initialEntries: ['/demo'] }
    );
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    );
    const main = screen.getByRole('main');
    expect(within(main).getByText('Demo feature screen')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('renders the 404 page for an unknown path: one h1, its own document.title, a real way home', () => {
    const router = createMemoryRouter(buildRoutes(), {
      initialEntries: ['/definitely-not-a-page'],
    });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('Page not found — Homeplate');
    expect(screen.getByRole('link', { name: /homeplate home page/i })).toHaveAttribute('href', '/');
    // Still inside the full landmark layout.
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });
});
