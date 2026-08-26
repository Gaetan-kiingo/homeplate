// client/src/layout/usePageTitle.js — one document.title per route (NFR-07; build-plan §6.1
// 5A.4). U5-SHELL. Every page component calls this hook exactly once so assistive tech and
// browser history always name the current screen: usePageTitle('Page not found') →
// "Page not found — Homeplate"; usePageTitle() on the home page → "Homeplate".
import { useEffect } from 'react';

export default function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} — Homeplate` : 'Homeplate';
  }, [title]);
}
