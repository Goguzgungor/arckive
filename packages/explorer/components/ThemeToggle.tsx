'use client';

import { useEffect, useState } from 'react';
import { THEME_KEY } from '../lib/theme.js';

type Theme = 'light' | 'dark';

// The theme on screen: the reader's pick (data-theme on <html>), else the system's.
function shown(): Theme {
  const picked = document.documentElement.dataset['theme'];
  if (picked === 'light' || picked === 'dark') return picked;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Day or night edition. The pick is kept in this browser only; without one
// the page follows the system (app/globals.css).
export function ThemeToggle() {
  // the server cannot know the theme: the label is settled once mounted
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(shown()), []);
  const flip = (): void => {
    const next: Theme = shown() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset['theme'] = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage refused (a private window): the pick lasts this page only
    }
    setTheme(next);
  };
  const label = theme === 'dark' ? 'Switch to the day edition' : 'Switch to the night edition';
  return (
    <button type="button" className="theme" onClick={flip} aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M8 1.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" />
      </svg>
    </button>
  );
}
