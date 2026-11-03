import { Link, redirect } from 'react-router';
import { api } from '../api.js';
import { ThemeToggle } from '../theme.jsx';

const PATHS = {
  building: <><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" /><path d="M15 9h4a1 1 0 0 1 1 1v11" /><path d="M8 8h3M8 12h3M8 16h3M3 21h18" /></>,
  study: <><path d="m2 9 10-5 10 5-10 5z" /><path d="M6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" /><path d="M22 9v6" /></>,
  upload: <><path d="M12 15V4" /><path d="m7 9 5-5 5 5" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  data: <><path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" /><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  bank: <><path d="M3 10 12 4l9 6" /><path d="M5 10v8M12 10v8M19 10v8M3 21h18" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M17 8h5M19.5 5.5v5" /></>,
  check: <path d="m5 12 5 5 9-10" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v5h1" /></>,
  shield: <><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  tag: <><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><path d="M7.5 7.5h.01" /></>,
  store: <><path d="M3 9h18l-1.5-5h-15z" /><path d="M5 9v11h14V9" /><path d="M10 20v-6h4v6" /></>,
  question: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  link: <><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>,
  minus: <path d="M5 12h14" />,
  updown: <path d="m7 10 5-5 5 5M7 14l5 5 5-5" />,
};

export function Icon({ name, size = 20, stroke = 1.8 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function Tile({ icon, tone, size }) {
  const px = size === 'lg' ? 24 : size === 'sm' ? 15 : 20;
  return <span className={`tile tile--${tone}${size ? ` tile--${size}` : ''}`} aria-hidden="true"><Icon name={icon} size={px} stroke={size === 'sm' ? 2 : 1.8} /></span>;
}

export const initials = (name) => String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

/** Top bar used by every setup screen. */
export function SetupShell({ context, exit = { to: '/start', label: 'Exit setup' }, status = 'Draft saved', tone, steps, current, children }) {
  return (
    <div className={`ob${tone ? ` ob--${tone}` : ''}`}>
      <header className="ob-top">
        <Link className="ob-brand" to="/start">
          <span className="dash-mark" aria-hidden="true" />
          <strong>Valcairn</strong>
          {context && <small>{context}</small>}
        </Link>
        <div className="ob-top-meta">
          {status && <span>{status}</span>}
          {exit && <Link to={exit.to}>{exit.label}</Link>}
          <ThemeToggle />
        </div>
      </header>
      {steps && (
        <ol className="ob-steps" aria-label="Setup steps">
          {steps.map((label, i) => (
            <li key={label} aria-current={i === current ? 'step' : undefined} className={i < current ? 'is-done' : undefined}>
              <span aria-hidden="true">{i < current ? <Icon name="check" size={12} stroke={3} /> : i + 1}</span>{label}
            </li>
          ))}
        </ol>
      )}
      {children}
    </div>
  );
}

export function FieldError({ id, children }) {
  return children ? <p className="ob-error" id={id}>{children}</p> : null;
}

// Where a signed-in person should land, based on what they have set up so far.
export function nextPath(account) {
  if (!account?.user) return '/signup';
  if (!account.user.emailVerifiedAt) return '/verify';
  if (account.match) return '/setup/match';
  const first = account.workspaces[0];
  return first ? `/w/${first.slug}` : '/start';
}

export async function requireVerified() {
  const account = await api.account();
  if (!account.user) throw redirect('/signin');
  if (!account.user.emailVerifiedAt) throw redirect('/verify');
  return account;
}

/** Loader helper for /w/:slug/... routes: the workspace must be one of the person's memberships. */
export async function requireWorkspace(slug) {
  const account = await requireVerified();
  const entry = account.workspaces.find((w) => w.slug === slug);
  if (!entry) throw redirect('/start');
  return { account, entry };
}
