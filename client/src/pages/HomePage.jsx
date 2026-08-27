// client/src/pages/HomePage.jsx — the home page (U5-SHELL; SRS §2.1.2, WA-9).
//
// Wave 5 shipped this page with no links, on the note that "the marketplace screens — the only
// real things to link to — are wave 6". Wave 6 built all seven of them, but every wave-6 unit
// was scoped to client/src/features/**, so nobody owned this file: the copy still told visitors
// the screens were yet to come, and the front door offered no way in. Corrected 2026-08-27
// together with the layout nav.
//
// NFR-07: exactly one h1; document.title via usePageTitle (home is the bare product name);
// the calls to action are real links to routes that exist, never buttons that go nowhere.
import { Link } from 'react-router-dom';
import { useSession } from '../session/index.js';
import usePageTitle from '../layout/usePageTitle.js';

export default function HomePage() {
  usePageTitle();
  const { status } = useSession();

  return (
    <>
      <h1>Homeplate</h1>
      <p>
        Home-cooked meals, shared locally. Homeplate connects approved home hosts with guests who
        want a seat at a real table: hosts publish a meal with a date and seat count, guests browse
        what is nearby and reserve a seat, and reviews follow the meal.
      </p>

      {/* Rendered only once the session resolves, so a signed-in visitor is never invited to
          create an account they already have. */}
      {status === 'anonymous' && (
        <p>
          <Link to="/signup">Create an account</Link> to reserve a seat or host a meal, or{' '}
          <Link to="/login">sign in</Link> if you already have one. Browsing meals needs an account
          too — host locations are never served to anonymous visitors (NFR-13, AB-08).
        </p>
      )}

      {status === 'authenticated' && (
        <p>
          <Link to="/search">Find a meal</Link> near you, review{' '}
          <Link to="/bookings">your bookings</Link>, or manage{' '}
          <Link to="/account">your account</Link>.
        </p>
      )}
    </>
  );
}
