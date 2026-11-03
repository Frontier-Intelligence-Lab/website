import { useEffect, useState } from 'react';

// Without a stored choice the CSS follows the system setting; a stored choice sets data-theme on <html>.
const KEY = 'valcairn-theme';
const root = document.documentElement;
const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');

const stored = () => {
  try { return localStorage.getItem(KEY); } catch { return null; }
};
const current = () => root.dataset.theme ?? (systemQuery.matches ? 'dark' : 'light');

export function applyStoredTheme() {
  const theme = stored();
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
}

export function ThemeToggle({ className = 'icon-btn' }) {
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    const follow = () => setTheme(current());
    systemQuery.addEventListener('change', follow);
    return () => systemQuery.removeEventListener('change', follow);
  }, []);

  const next = theme === 'dark' ? 'light' : 'dark';
  const toggle = () => {
    root.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* storage unavailable: choice lasts for this page only */ }
    setTheme(next);
  };

  return (
    <button type="button" className={className} onClick={toggle} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === 'dark'
          ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>
          : <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />}
      </svg>
    </button>
  );
}
