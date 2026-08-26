// client/src/pages/HomePage.jsx — the home page (U5-SHELL; SRS §2.1.2, WA-9). Product
// introduction only in wave 5: the session-aware login-state display landed in the layout
// nav (5C, U5-SHELL-WIRE via useSession()), and the marketplace screens — the only real
// things to link to — are wave 6, so this page ships NO dead links and promises nothing it
// cannot do yet.
// NFR-07: exactly one h1; document.title via usePageTitle (home is the bare product name).
import usePageTitle from '../layout/usePageTitle.js';

export default function HomePage() {
  usePageTitle();

  return (
    <>
      <h1>Homeplate</h1>
      <p>
        Home-cooked meals, shared locally. Homeplate connects approved home hosts with guests who
        want a seat at a real table: hosts publish a meal with a date and seat count, guests browse
        what is nearby and reserve a seat, and reviews follow the meal.
      </p>
      <p>
        The interactive marketplace screens — search, listings, bookings, messaging — arrive with
        the next build waves of this prototype.
      </p>
    </>
  );
}
