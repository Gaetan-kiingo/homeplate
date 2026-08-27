// client/src/layout/AppLayout.test.jsx — layout behaviour specs (U5-SHELL / U5-SHELL-WIRE;
// NFR-07 clauses checkable without the wave-7 browser audit): focus-to-#main on route change
// (and ONLY on route change — initial load must leave the skip link first), document.title
// per route, the session-aware nav display (NFR-03/AB-05: state from stubbed API responses,
// never a cookie), and the top-level error boundary's landmark-preserving fallback plus its
// aria-live announcement through the shell-mounted StatusAnnouncer.
// AppLayout consumes useSession(), so every render here wraps the ambient <SessionProvider>
// exactly as App.jsx does; the default fetch stub rejects (a transport failure), which pins
// session status at 'unknown' with no async state updates.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { buildRoutes } from '../routes.jsx';
import { SessionProvider } from '../session/index.js';
import { StatusAnnouncer } from '../ui/index.js';

function demoFeature() {
  return [
    {
      path: 'demo',
      element: (
        <>
          <h1>Demo feature screen</h1>
        </>
      ),
    },
  ];
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

/** GET /api/users/me responds as given; everything else is an unexpected call. */
function stubMe(response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      if (init.method === 'GET' && url.split('?')[0] === '/api/users/me') return response;
      throw new Error(`AppLayout.test: unexpected fetch ${init.method} ${url}`);
    })
  );
}

/** Render a router tree under the ambient SessionProvider, exactly as App.jsx wires it. */
function renderShell(router, { strict = false, announcer = false } = {}) {
  // Announcer BEFORE the router, exactly as App.jsx mounts it: sibling effects run in
  // order, so its listener registers before any first-commit announcement fires.
  const tree = (
    <SessionProvider>
      {announcer && <StatusAnnouncer />}
      <RouterProvider router={router} />
    </SessionProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('AppLayout.test: no network in specs');
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AppLayout focus management (NFR-07)', () => {
  it('does not steal focus on initial load, even under StrictMode double-mount', () => {
    const router = createMemoryRouter(buildRoutes(), { initialEntries: ['/'] });
    renderShell(router, { strict: true });
    expect(screen.getByRole('main')).not.toHaveFocus();
    expect(document.body).toHaveFocus(); // focus is at the document start; first Tab = skip link
  });

  it('moves focus to #main on a route change', async () => {
    const router = createMemoryRouter(buildRoutes(demoFeature()), { initialEntries: ['/'] });
    renderShell(router);
    expect(screen.getByRole('main')).not.toHaveFocus();

    await act(async () => {
      await router.navigate('/demo');
    });

    expect(screen.getByRole('heading', { name: 'Demo feature screen' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });

  it('navigating home via the brand link renders home and focuses #main', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(buildRoutes(demoFeature()), { initialEntries: ['/demo'] });
    renderShell(router);

    await user.click(screen.getByRole('link', { name: 'Homeplate' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Homeplate' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
    expect(document.title).toBe('Homeplate');
  });
});

describe('AppLayout session-aware nav (5C: display only; NFR-03/AB-05 response-inferred)', () => {
  it('shows nothing about the session while status is unknown (hydration unanswered)', async () => {
    const router = createMemoryRouter(buildRoutes(), { initialEntries: ['/'] });
    renderShell(router);
    await act(async () => {}); // let the rejected hydration settle
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).not.toHaveTextContent(/signed in/i);
  });

  it('shows "Not signed in" for an anonymous session (401 from /api/users/me)', async () => {
    stubMe(
      jsonResponse(401, {
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in.', correlationId: 'c1' },
      })
    );
    const router = createMemoryRouter(buildRoutes(), { initialEntries: ['/'] });
    renderShell(router);
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveTextContent('Not signed in')
    );
  });

  it('shows the fullName for an authenticated session, falling back to email if blank', async () => {
    stubMe(
      jsonResponse(200, {
        user: { id: 'u1', email: 'gaia@example.com', emailVerified: true, fullName: '' },
      })
    );
    const router = createMemoryRouter(buildRoutes(), { initialEntries: ['/'] });
    renderShell(router);
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveTextContent(
        'gaia@example.com'
      )
    );
  });
});

describe('RootErrorBoundary (top-level error boundary, build-plan §6.1 5A.3 + 5C.1)', () => {
  function Boom() {
    throw new Error('deliberate render failure (spec fixture)');
  }

  it('catches a page render error and keeps the full landmark structure', () => {
    // React and the boundary both log the error by design; keep the spec output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = createMemoryRouter(buildRoutes([{ path: 'boom', element: <Boom /> }]), {
      initialEntries: ['/boom'],
    });
    renderShell(router, { announcer: true });

    expect(
      screen.getByRole('heading', { level: 1, name: 'Something went wrong' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // The fallback carries its own landmarks — an error never lands on a landmark-free page.
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(document.title).toBe('Something went wrong — Homeplate');
    // The recovery control is a REAL full-document link, not a dead button.
    expect(screen.getByRole('link', { name: /return to the home page/i })).toHaveAttribute(
      'href',
      '/'
    );
  });

  it('announces the failure through the assertive live region (NFR-07, 5C wiring)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = createMemoryRouter(buildRoutes([{ path: 'boom', element: <Boom /> }]), {
      initialEntries: ['/boom'],
    });
    // StatusAnnouncer is a SIBLING of the router (App.jsx wiring), so it is still mounted
    // when the routed tree has been replaced by the boundary — the announcement is heard.
    renderShell(router, { announcer: true });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /something went wrong: homeplate hit an unexpected error/i
      )
    );
    // The polite region stays quiet: an error is assertive, not chatter.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
