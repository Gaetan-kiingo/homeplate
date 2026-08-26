// client/src/App.test.jsx — shell integration specs (U5-SHELL / U5-SHELL-WIRE; vitest +
// testing-library). Asserts the NFR-07 structure the wave-7 audit will measure — landmarks,
// labelled nav, single h1, skip link first, document.title — plus the 5C wiring: the
// SessionProvider is ambient, the nav is session-aware (display only; NFR-03/AB-05 state
// comes from stubbed API RESPONSES, never a cookie), the aria-live StatusAnnouncer is
// mounted exactly once, and styles/tokens.css is imported exactly once, by App.jsx — all on
// the REAL app root (<App />, module-scope browser router), exactly as main.jsx mounts it.
// House rule carried from the backend suite: the client suite must never pass vacuously.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.jsx';

const USER = {
  id: 'u1',
  email: 'gaia@example.com',
  emailVerified: true,
  fullName: 'Gaia Tester',
  roles: ['user'],
};

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
      throw new Error(`App.test: unexpected fetch ${init.method} ${url}`);
    })
  );
}

beforeEach(() => {
  // Default: hydration transport failure — session status stays 'unknown', no state update,
  // so the structural specs are deterministic. Session-state specs override per test.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('App.test: no network in specs');
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App shell (SRS §2.1.2, NFR-07 groundwork)', () => {
  it('renders the landmark structure: banner, labelled nav, main#main, contentinfo', () => {
    render(<App />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    // Programmatic focus target for the skip link and for focus-on-route-change.
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('has exactly one h1 and sets document.title on the home route', () => {
    render(<App />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('Homeplate');
  });

  it('ships a skip-to-content link pointing at #main as the first link in the document', () => {
    render(<App />);
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveTextContent(/skip to main content/i);
    expect(links[0]).toHaveAttribute('href', '#main');
  });

  it('puts the skip link first in the Tab order (NFR-07 keyboard entry point)', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.tab();
    expect(screen.getByRole('link', { name: /skip to main content/i })).toHaveFocus();
  });

  it('renders no dead links: every link targets the home route or #main in wave 5', () => {
    render(<App />);
    for (const link of screen.getAllByRole('link')) {
      expect(['#main', '/']).toContain(link.getAttribute('href'));
    }
  });
});

describe('5C wiring: aria-live announcer (NFR-07 "errors announced via aria-live")', () => {
  it('mounts the StatusAnnouncer exactly once: one polite region, one assertive region', () => {
    render(<App />);
    // getByRole throws on zero AND on more than one match — this pins "exactly once".
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
  });

  it('keeps the live regions empty at mount and OUT of the Tab order (skip link stays first)', async () => {
    // The announcer mounts BEFORE the router (App.jsx: sibling effect order — its listener
    // must exist before any first-commit announcement), so pin that it cannot preempt the
    // NFR-07 keyboard entry point: nothing in it is focusable, first Tab = skip link.
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).not.toHaveAttribute('tabindex');
    expect(screen.getByRole('status')).not.toHaveAttribute('tabindex');
    await user.tab();
    expect(screen.getByRole('link', { name: /skip to main content/i })).toHaveFocus();
  });
});

describe('5C wiring: session-aware nav (NFR-03/AB-05 — state from responses only)', () => {
  it('claims nothing about the session while hydration has not answered (status unknown)', async () => {
    render(<App />);
    await act(async () => {}); // let the rejected hydration settle
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).not.toHaveTextContent(/signed in/i);
    expect(nav).not.toHaveTextContent(/not signed in/i);
  });

  it('shows "Not signed in" once GET /api/users/me answers 401 (anonymous)', async () => {
    stubMe(
      jsonResponse(401, {
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in.', correlationId: 'c1' },
      })
    );
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await waitFor(() => expect(nav).toHaveTextContent('Not signed in'));
    expect(nav).not.toHaveTextContent(/signed in as/i);
  });

  it('shows "Signed in as <fullName>" once GET /api/users/me answers 200', async () => {
    stubMe(jsonResponse(200, { user: USER }));
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await waitFor(() => expect(nav).toHaveTextContent('Signed in as Gaia Tester'));
  });

  it('adds no links in any session state: login-state display only until wave 6', async () => {
    stubMe(jsonResponse(200, { user: USER }));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveTextContent(/signed in as/i)
    );
    for (const link of screen.getAllByRole('link')) {
      expect(['#main', '/']).toContain(link.getAttribute('href'));
    }
  });
});

describe('5C wiring: design tokens (NFR-07 contrast/focus/spacing single source)', () => {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));

  function walkSources(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkSources(full, out);
      else if (/\.(js|jsx|css)$/.test(entry.name) && !entry.name.endsWith('tokens.css'))
        out.push(full);
    }
    return out;
  }

  it('imports styles/tokens.css exactly once across client/src — in App.jsx (the shell)', () => {
    const importers = walkSources(srcDir).filter((file) =>
      /import\s+['"][^'"]*styles\/tokens\.css['"]/.test(fs.readFileSync(file, 'utf8'))
    );
    expect(importers).toEqual([path.join(srcDir, 'App.jsx')]);
  });
});
