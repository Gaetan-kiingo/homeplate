// client/src/main.jsx — entry point of the responsive React WEB client (SRS §2.1.2 — web, not
// React Native; SRS wins over SPMP §5.2.1, recorded at WA-9). U5-SHELL. The mount contract is
// stable: this file renders <App /> into #root and nothing else — the router lives in App.jsx,
// the route tree in routes.jsx, and 5C's SessionProvider/StatusAnnouncer wiring happens inside
// App, so this file is not edited again in wave 5.
import React from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
