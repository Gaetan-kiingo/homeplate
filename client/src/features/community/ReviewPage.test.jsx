// client/src/features/community/ReviewPage.test.jsx — U6-COMMUNITY acceptance specs for
// the FR-05 review form (plus the NFR-07 clauses checkable in jsdom).
// Pins: rating AND comment are marked required BEFORE submit and an empty submit is blocked
// client-side by a focused ErrorSummary (no request leaves); a photo-only review is blocked
// with an explanation (the ratified 2026-08-26 comment-required rule, report W4-F2) and
// uploads nothing; a successful submit posts {rating int, comment, imageKeys} and states
// the review is PENDING moderation (FR-08 born-pending — never "published"); photos travel
// the published ADR-004 media supply path (mint → PUT → attach) and MEDIA_UPLOAD_FAILED
// gets its own message with the review NOT submitted; typed server refusals
// (REVIEW_EXISTS / BOOKING_NOT_COMPLETED / VALIDATION_FAILED) render real messages and are
// announced via the assertive aria-live region (build-plan G.2).
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../session/index.js';
import { StatusAnnouncer } from '../../ui/index.js';
import ReviewPage from './ReviewPage.jsx';

const BOOKING_ID = 'b0000000-0000-4000-8000-000000000002';
const GUEST = {
  id: 'u-guest',
  email: 'guest@example.com',
  emailVerified: true,
  fullName: 'Gaia Guest',
  roles: ['user'],
  emergencyContact: null,
};

const ME_KEY = 'GET /api/users/me';
const REVIEW_KEY = `POST /api/bookings/${BOOKING_ID}/reviews`;
const UPLOADS_KEY = 'POST /api/media/uploads';
const ATTACH_KEY = 'POST /api/media';
const STORAGE_URL = 'https://storage.local/homeplate/review-key-1';
const STORAGE_KEY = 'users/u-guest/review/review-key-1.png';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function apiError(status, code, message) {
  return jsonResponse(status, { error: { code, message, correlationId: 'corr-1' } });
}

/** Route-by-URL fetch stub: handlers = { 'METHOD /path': response | (url, init) => resp }. */
function stubFetch(handlers) {
  const fn = vi.fn(async (url, init) => {
    const key = `${init.method} ${String(url).split('?')[0]}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`ReviewPage.test: unexpected fetch ${key}`);
    return typeof handler === 'function' ? handler(url, init) : handler;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPage(handlers) {
  const fn = stubFetch({ [ME_KEY]: jsonResponse(200, { user: GUEST }), ...handlers });
  const router = createMemoryRouter(
    [{ path: '/bookings/:bookingId/review', element: <ReviewPage /> }],
    { initialEntries: [`/bookings/${BOOKING_ID}/review`] }
  );
  render(
    <SessionProvider>
      <StatusAnnouncer />
      <RouterProvider router={router} />
    </SessionProvider>
  );
  return fn;
}

/** The StatusAnnouncer region for one politeness level (ErrorSummary excluded). */
function liveRegion(politeness) {
  const role = politeness === 'assertive' ? 'alert' : 'status';
  return screen.getAllByRole(role).find((el) => el.getAttribute('aria-live') === politeness);
}

/** The focused form-level ErrorSummary (role=alert with the GDS heading). */
function errorSummary() {
  return screen.getAllByRole('alert').find((el) => el.textContent.includes('There is a problem'));
}

function reviewCalls(fn) {
  return fn.mock.calls.filter(
    ([url, init]) => init.method === 'POST' && String(url).includes('/reviews')
  );
}

/** Find text rendered in the PAGE (excluding the aria-live mirror, which repeats it). */
async function findRendered(matcher) {
  const matches = await screen.findAllByText(matcher);
  const rendered = matches.filter((el) => !el.closest('[aria-live]'));
  expect(rendered.length).toBeGreaterThan(0);
  return rendered[0];
}

async function fillValidForm(user) {
  await user.selectOptions(screen.getByRole('combobox', { name: /rating/i }), '4');
  await user.type(
    screen.getByRole('textbox', { name: /comment/i }),
    'Wonderful pasta, lovely host.'
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('required-before-submit (FR-05 ratified comment rule, NFR-07)', () => {
  it('marks rating and comment required, blocks an empty submit with a focused summary, sends nothing', async () => {
    const fn = renderPage({});
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Leave a review' })
    ).toBeInTheDocument();
    expect(document.title).toBe('Leave a review — Homeplate');
    // Both controls are marked required BEFORE any submit (native + visible label marker).
    expect(screen.getByRole('combobox', { name: /rating/i })).toBeRequired();
    expect(screen.getByRole('textbox', { name: /comment/i })).toBeRequired();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Submit review' }));

    const summary = errorSummary();
    expect(summary).toBeTruthy();
    expect(summary).toHaveFocus();
    expect(
      within(summary).getByRole('link', { name: 'Choose a rating from 1 to 5.' })
    ).toHaveAttribute('href', '#review-rating');
    expect(within(summary).getByRole('link', { name: /write a comment/i })).toHaveAttribute(
      'href',
      '#review-comment'
    );
    // Nothing left the browser: the only traffic is the session hydration call.
    expect(fn.mock.calls.every(([url]) => String(url).includes('/api/users/me'))).toBe(true);
  });

  it('blocks a photo-only review client-side with an explanation and uploads nothing', async () => {
    const fn = renderPage({});
    await screen.findByRole('heading', { level: 1, name: 'Leave a review' });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: /rating/i }), '5');
    await user.upload(
      screen.getByLabelText(/photos/i),
      new File(['img-bytes'], 'meal.png', { type: 'image/png' })
    );
    await user.click(screen.getByRole('button', { name: 'Submit review' }));

    const summary = errorSummary();
    expect(summary).toBeTruthy();
    expect(
      within(summary).getByRole('link', {
        name: /photos alone cannot be submitted: every review needs at least one character of text/i,
      })
    ).toHaveAttribute('href', '#review-comment');
    // No media call, no review call — the explanation came before any request.
    expect(fn.mock.calls.every(([url]) => String(url).includes('/api/users/me'))).toBe(true);
  });
});

describe('submit (FR-05 → FR-08 born pending)', () => {
  it('posts {rating, comment, imageKeys: []} and states the review is pending moderation', async () => {
    const fn = renderPage({
      [REVIEW_KEY]: jsonResponse(201, {
        review: { id: 'r1', bookingId: BOOKING_ID, moderationStatus: 'pending' },
      }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Leave a review' });
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.click(screen.getByRole('button', { name: 'Submit review' }));

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Review submitted — pending moderation',
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/not public yet/i)).toBeInTheDocument();
    expect(liveRegion('polite')).toHaveTextContent(
      'Review submitted. It is pending moderation and will not be public until approved.'
    );
    // The form is gone — no double submit path.
    expect(screen.queryByRole('button', { name: 'Submit review' })).not.toBeInTheDocument();
    const posts = reviewCalls(fn);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({
      rating: 4,
      comment: 'Wonderful pasta, lovely host.',
      imageKeys: [],
    });
  });

  it('uploads photos through the published media supply path and sends their keys', async () => {
    const fn = renderPage({
      [UPLOADS_KEY]: jsonResponse(201, {
        storageKey: STORAGE_KEY,
        uploadUrl: STORAGE_URL,
        headers: { 'content-type': 'image/png' },
        expiresAt: '2026-08-27T00:00:00.000Z',
      }),
      [`PUT ${STORAGE_URL}`]: { ok: true, status: 200, text: async () => '' },
      [ATTACH_KEY]: jsonResponse(201, { media: { id: 'md1' } }),
      [REVIEW_KEY]: jsonResponse(201, { review: { id: 'r1' } }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Leave a review' });
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.upload(
      screen.getByLabelText(/photos/i),
      new File(['img-bytes'], 'meal.png', { type: 'image/png' })
    );
    expect(screen.getByText('1 photo selected.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit review' }));

    await screen.findByRole('heading', { level: 2, name: 'Review submitted — pending moderation' });
    // Mint carried the file's kind/type/size.
    const mint = fn.mock.calls.find(([url]) => String(url).includes('/api/media/uploads'));
    expect(JSON.parse(mint[1].body)).toEqual({
      kind: 'review',
      contentType: 'image/png',
      sizeBytes: 9,
    });
    // Bytes went STRAIGHT to storage, without the API session cookie (AB-05).
    const put = fn.mock.calls.find(([, init]) => init.method === 'PUT');
    expect(String(put[0])).toBe(STORAGE_URL);
    expect(put[1].credentials).toBe('omit');
    // The attach recorded the minted key, and the review carried it as imageKeys.
    const attach = fn.mock.calls.find(
      ([url, init]) => init.method === 'POST' && String(url).split('?')[0] === '/api/media'
    );
    expect(JSON.parse(attach[1].body).storageKey).toBe(STORAGE_KEY);
    expect(JSON.parse(reviewCalls(fn)[0][1].body).imageKeys).toEqual([STORAGE_KEY]);
  });

  it('gives MEDIA_UPLOAD_FAILED its own message and does NOT submit the review', async () => {
    const fn = renderPage({
      [UPLOADS_KEY]: jsonResponse(201, {
        storageKey: STORAGE_KEY,
        uploadUrl: STORAGE_URL,
        headers: {},
        expiresAt: '2026-08-27T00:00:00.000Z',
      }),
      [`PUT ${STORAGE_URL}`]: { ok: false, status: 500, text: async () => '' },
    });
    await screen.findByRole('heading', { level: 1, name: 'Leave a review' });
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.upload(
      screen.getByLabelText(/photos/i),
      new File(['img-bytes'], 'meal.png', { type: 'image/png' })
    );
    await user.click(screen.getByRole('button', { name: 'Submit review' }));

    expect(
      await findRendered(
        'A photo could not be uploaded, so your review was not submitted. Remove the photo or try again.'
      )
    ).toBeInTheDocument();
    expect(liveRegion('assertive')).toHaveTextContent(/photo could not be uploaded/);
    expect(reviewCalls(fn)).toHaveLength(0);
    // Still on the form — the user can retry.
    expect(screen.getByRole('button', { name: 'Submit review' })).toBeInTheDocument();
  });

  it.each([
    [
      'REVIEW_EXISTS',
      409,
      'A review for this booking already exists.',
      /already reviewed this booking/i,
    ],
    [
      'BOOKING_NOT_COMPLETED',
      409,
      'Reviews are only accepted on completed bookings.',
      /not completed yet/i,
    ],
    [
      'VALIDATION_FAILED',
      422,
      'rating must be an integer between 1 and 5',
      /rating must be an integer between 1 and 5/i,
    ],
    // Finding U6VC-F1: the live 401 code is NO_SESSION — the actionable sign-in copy must
    // render, never the terse server envelope message.
    [
      'NO_SESSION',
      401,
      'Session is invalid or expired',
      /go to the login page, sign in, then come back here/i,
    ],
  ])(
    'maps a %s refusal to a real rendered + announced message',
    async (code, status, serverMsg, expected) => {
      renderPage({ [REVIEW_KEY]: apiError(status, code, serverMsg) });
      await screen.findByRole('heading', { level: 1, name: 'Leave a review' });
      const user = userEvent.setup();
      await fillValidForm(user);
      await user.click(screen.getByRole('button', { name: 'Submit review' }));

      expect(await findRendered(expected)).toBeInTheDocument();
      expect(liveRegion('assertive')).toHaveTextContent(expected);
      // The form survives a refusal: nothing pretended to succeed.
      expect(screen.getByRole('button', { name: 'Submit review' })).toBeInTheDocument();
    }
  );
});
