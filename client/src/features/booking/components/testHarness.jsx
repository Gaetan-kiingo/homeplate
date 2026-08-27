// client/src/features/booking/components/testHarness.jsx — U6-BOOKING: shared spec harness
// for the booking screens (imported by the *.test.jsx files ONLY — routes.jsx never imports
// it, so it ships in no build).
//
// The house pattern (client/src/App.test.jsx): stub global fetch and exercise the REAL
// wave-5 stack — API client (typed ApiError codes, 401 broadcast), SessionProvider
// (response-inferred state; NFR-03/AB-05 — no cookie is ever read) and StatusAnnouncer (the
// NFR-07 aria-live channel) — so every spec proves the integration, not a mock of it.
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { expect, vi } from 'vitest';
import { SessionProvider } from '../../../session/index.js';
import { StatusAnnouncer } from '../../../ui/index.js';
import bookingRoutes from '../routes.jsx';

/** A complete SessionUser (AB-08 owner allowlist shape — src/api/types.js). */
export const GUEST = Object.freeze({
  id: 'u-guest',
  email: 'guest@example.com',
  emailVerified: true,
  fullName: 'Gaia Guest',
  phone: '+1 619 555 0100',
  emergencyContact: null,
  canReserveSeat: true,
  canPublishListing: false,
  roles: ['user'],
  hostProfile: null,
  createdAt: '2026-08-01T00:00:00.000Z',
});

/** Minimal Response-alike accepted by src/api/http.js (which only uses ok/status/text). */
export function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

/** The API's typed error envelope (src/middleware/errorHandler.js shape). */
export function errorResponse(status, code, message, details) {
  return jsonResponse(status, {
    error: {
      code,
      message,
      correlationId: 'corr-test',
      ...(details === undefined ? {} : { details }),
    },
  });
}

/**
 * Stub global fetch with a "METHOD /path" handler map. Handlers are a prepared response or
 * a function of the recorded call ({ method, pathname, search, body }). Returns the call
 * log for request-shape assertions. An unhandled call fails loudly.
 */
export function installFetch(handlers) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      const [pathname, search = ''] = String(url).split('?');
      const call = {
        method,
        pathname,
        search,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      };
      calls.push(call);
      const handler = handlers[`${method} ${pathname}`];
      if (!handler) {
        throw new TypeError(`booking spec: unhandled fetch ${method} ${pathname}`);
      }
      return typeof handler === 'function' ? handler(call) : handler;
    })
  );
  return calls;
}

/** GET /api/users/me handlers: pass a user for 'authenticated', null for 'anonymous'. */
export function sessionHandler(user) {
  return {
    'GET /api/users/me': user
      ? jsonResponse(200, { user })
      : errorResponse(401, 'NO_SESSION', 'Authentication required'),
  };
}

/**
 * Mount the REAL feature routes (routes.jsx) in a memory router inside the ambient
 * SessionProvider + StatusAnnouncer, exactly as App.jsx composes them. The catch-all stands
 * in for routes other features own (cross-feature navigation is by URL string only).
 */
export function renderBooking(initialPath) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        children: [...bookingRoutes, { path: '*', element: <p>outside the booking feature</p> }],
      },
    ],
    { initialEntries: [initialPath] }
  );
  render(
    <SessionProvider>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </SessionProvider>
  );
  return router;
}

/**
 * Assert that the aria-live channel spoke `pattern` (NFR-07): role 'status' = polite
 * confirmations/progress, role 'alert' = assertive errors. Scoped to the live REGIONS so a
 * visible copy of the same sentence elsewhere on the page can never satisfy the assertion.
 */
export async function expectAnnounced(regionRole, pattern) {
  await waitFor(() => {
    const regions = screen.getAllByRole(regionRole);
    expect(regions.some((region) => pattern.test(region.textContent))).toBe(true);
  });
}
