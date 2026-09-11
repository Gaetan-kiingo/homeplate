// client/src/features/host/CreateMealPage.test.jsx — /host/meals/new (FR-11 create; FR-09
// publish gate; ADR-009 cap refusals rendered from the payload; FR-08 pending-until-approved
// messaging; NFR-07 labelled controls and focused error summary).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppLayout from '../../layout/AppLayout.jsx';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import hostRoutes from './routes.jsx';

const HOST = Object.freeze({
  id: 'u-host',
  email: 'rosa@example.com',
  emailVerified: true,
  fullName: 'Rosa Host',
  phone: '+16195550100',
  emergencyContact: null,
  canReserveSeat: true,
  canPublishListing: true,
  roles: ['user'],
  hostProfile: { displayName: 'Rosa', bio: 'Cooking for years.' },
  createdAt: '2026-08-01T00:00:00.000Z',
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}
function errorResponse(status, code, message, details) {
  return jsonResponse(status, {
    error: { code, message, correlationId: 'corr-test', ...(details !== undefined && { details }) },
  });
}

function stubFetch(handlers) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const method = init.method || 'GET';
      const path = String(url).split('?')[0];
      const key = `${method} ${path}`;
      const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ key, url: String(url), body });
      const handler = handlers[key];
      if (!handler) throw new Error(`CreateMealPage.test: unexpected fetch ${key}`);
      return typeof handler === 'function' ? handler({ url: String(url), body }) : handler;
    })
  );
  return calls;
}

function renderAt(path) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppLayout />,
        children: [
          ...hostRoutes,
          { path: 'listings/:id', element: <p>listing-detail-route</p> },
          { path: '*', element: <p>route-miss</p> },
        ],
      },
    ],
    { initialEntries: [path] }
  );
  render(
    <SessionProvider>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </SessionProvider>
  );
  return router;
}

const anonMe = errorResponse(401, 'NO_SESSION', 'Authentication required');
const hostMe = jsonResponse(200, { user: HOST });

/** Fill every required control with valid values (LA wall-clock time in the future). */
async function fillValidForm(user) {
  const main = within(screen.getByRole('main'));
  await user.type(main.getByLabelText(/^Title/), 'Carnitas Night');
  await user.type(main.getByLabelText(/^Description/), 'Slow-cooked pork, fresh tortillas.');
  await user.type(main.getByLabelText(/^Cuisine/), 'Mexican');
  await user.type(main.getByLabelText(/^Ingredients/), 'Pork shoulder\nCorn tortillas, Lime');
  await user.type(main.getByLabelText(/^Allergens/), 'None');
  fireEvent.change(main.getByLabelText(/^Date and time/), {
    target: { value: '2099-09-13T18:30' },
  });
  await user.type(main.getByLabelText(/^Street address/), '742 Evergreen Terrace');
  await user.clear(main.getByLabelText(/^City/));
  await user.type(main.getByLabelText(/^City/), 'San Diego');
  await user.type(main.getByLabelText(/^ZIP code/), '92104');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CreateMealPage — /host/meals/new (FR-11)', () => {
  it('anonymous: offers sign-in and sign-up instead of a dead form', async () => {
    stubFetch({ 'GET /api/users/me': anonMe });
    renderAt('/host/meals/new');
    expect(screen.getByRole('heading', { level: 1, name: 'Host a meal' })).toBeInTheDocument();
    const main = within(await screen.findByRole('main'));
    await waitFor(() => expect(main.getByRole('link', { name: 'Sign in' })).toBeInTheDocument());
    expect(main.getByRole('link', { name: 'create an account' })).toHaveAttribute(
      'href',
      '/signup'
    );
    expect(main.queryByRole('button', { name: /Publish/ })).toBeNull();
  });

  it('a signed-in user who may not publish is sent to the account page, not the form (FR-09)', async () => {
    stubFetch({
      'GET /api/users/me': jsonResponse(200, { user: { ...HOST, canPublishListing: false } }),
    });
    renderAt('/host/meals/new');
    const main = within(await screen.findByRole('main'));
    await waitFor(() =>
      expect(main.getByRole('link', { name: 'account page' })).toHaveAttribute('href', '/account')
    );
    expect(main.queryByLabelText(/^Title/)).toBeNull();
  });

  it('refuses an incomplete form client-side with a focused error summary and no request', async () => {
    const calls = stubFetch({ 'GET /api/users/me': hostMe });
    renderAt('/host/meals/new');
    const user = userEvent.setup();
    const publish = await screen.findByRole('button', { name: 'Publish this meal' });
    await user.click(publish);
    // The form's ErrorSummary (inside <main>) — the shell's live announcer is also role=alert.
    const alert = await within(screen.getByRole('main')).findByRole('alert');
    expect(alert).toHaveTextContent(/title of at least 3 characters/i);
    expect(alert).toHaveTextContent(/date and time/i);
    expect(alert).toHaveTextContent(/street address/i);
    expect(calls.filter((c) => c.key === 'POST /api/listings')).toHaveLength(0);
  });

  it('posts the schema body with the LA time as a UTC instant, then lands on the pending listing', async () => {
    const calls = stubFetch({
      'GET /api/users/me': hostMe,
      'POST /api/listings': jsonResponse(201, {
        listing: { id: 'listing-new', title: 'Carnitas Night', moderationStatus: 'pending' },
      }),
    });
    const router = renderAt('/host/meals/new');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Publish this meal' });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Publish this meal' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/listings/listing-new'));
    const posts = calls.filter((c) => c.key === 'POST /api/listings');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      title: 'Carnitas Night',
      description: 'Slow-cooked pork, fresh tortillas.',
      cuisine: 'Mexican',
      ingredients: ['Pork shoulder', 'Corn tortillas', 'Lime'],
      allergens: ['None'],
      scheduledStart: '2099-09-14T01:30:00.000Z', // 18:30 America/Los_Angeles (PDT)
      durationMinutes: 120,
      seatCapacity: 4,
      addressLine1: '742 Evergreen Terrace',
      city: 'San Diego',
      region: 'CA',
      postalCode: '92104',
      country: 'US',
    });
    // FR-08: the outcome says the listing is pending review (announced through the shell).
    expect(screen.getByRole('status')).toHaveTextContent(/pending moderation review/i);
  });

  it('renders a MEHKO cap refusal from the payload numbers (ADR-009) and keeps the form', async () => {
    stubFetch({
      'GET /api/users/me': hostMe,
      'POST /api/listings': errorResponse(
        422,
        'MEHKO_DAILY_MEAL_LIMIT',
        'Seat capacity exceeds the configured daily MEHKO meal limit for this host.',
        { localDate: '2099-09-13', limit: 30, alreadyScheduled: 28 }
      ),
    });
    renderAt('/host/meals/new');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Publish this meal' });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Publish this meal' }));
    const main = within(screen.getByRole('main'));
    await waitFor(() =>
      expect(main.getByText(/MEHKO limit of 30 meals/)).toHaveTextContent(
        /28 seat\(s\) are already scheduled that day/
      )
    );
    // The form is still there to correct — nothing navigated away.
    expect(main.getByRole('button', { name: 'Publish this meal' })).toBeInTheDocument();
  });

  it('maps a server 422 issue list onto the fields it names', async () => {
    stubFetch({
      'GET /api/users/me': hostMe,
      'POST /api/listings': errorResponse(422, 'VALIDATION_FAILED', 'Request validation failed.', {
        fields: [
          { path: 'body.seatCapacity', code: 'too_small', message: 'must be an integer' },
          { path: 'body.somethingElse', code: 'custom', message: 'is not allowed' },
        ],
      }),
    });
    renderAt('/host/meals/new');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Publish this meal' });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Publish this meal' }));
    const alert = await within(screen.getByRole('main')).findByRole('alert');
    expect(alert).toHaveTextContent('must be an integer');
    expect(
      within(screen.getByRole('main')).getByText(/somethingElse: is not allowed/)
    ).toBeInTheDocument();
  });

  it('renders the FR-09 reason codes with the account fix path on a 403 NOT_ELIGIBLE', async () => {
    stubFetch({
      'GET /api/users/me': hostMe,
      'POST /api/listings': errorResponse(403, 'NOT_ELIGIBLE', 'Not eligible.', {
        reasons: ['HOST_AGREEMENT_MISSING', 'PHONE_MISSING'],
      }),
    });
    renderAt('/host/meals/new');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Publish this meal' });
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Publish this meal' }));
    const main = within(screen.getByRole('main'));
    await waitFor(() => expect(main.getByText(/Accept the host agreement/)).toBeInTheDocument());
    expect(main.getByText(/Add a phone number/)).toBeInTheDocument();
    expect(main.getByRole('link', { name: 'account page' })).toHaveAttribute('href', '/account');
  });
});
