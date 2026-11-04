import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api.js';
import { ThemeToggle } from '../theme.jsx';
import { Icon, Tile, initials } from './ui.jsx';
import { forgetConnections } from './memory.js';

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const roleName = (role) => role[0].toUpperCase() + role.slice(1);

const SIDEBAR_KEY = 'valcairn-sidebar';
const storedCollapsed = () => {
  try { return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'; } catch { return false; }
};

// Dataset pages of one project, shown under Projects while you are inside it.
const DATASET_PAGES = [
  ['dataset', 'Dataset', ''],
  ['annotate', 'Annotate', '/annotate'],
  ['resolve', 'Resolve', '/resolve'],
  ['import', 'Import', '/import'],
  ['versions', 'Versions', '/versions'],
];

// Models pages, shown under Models while you are in one of them.
const MODEL_PAGES = [
  ['models-catalog', 'Catalog', ''],
  ['models-mine', 'My models', '/mine'],
  ['models-runs', 'Enhance runs', '/runs'],
];

/**
 * Sidebar and main column for every workspace page. The sidebar collapses to icons (remembered per browser);
 * on narrow screens it is a scrolling row instead.
 */
export function WorkspaceShell({ account, entry, role, title, current = 'projects', project, openIssues = 0, children }) {
  const navigate = useNavigate();
  const [signOutState, setSignOutState] = useState('idle');
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  async function signOut() {
    setSignOutState('pending');
    const res = await api.signout().catch(() => null);
    if (!res?.ok) return setSignOutState('failed');
    // The signed-in person is gone from this tab, so its local-memory keys go too; the memories stay in the store.
    forgetConnections();
    navigate('/signin');
  }
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'open'); } catch { /* storage unavailable: lasts for this page only */ }
  };
  const projectBase = project && `/w/${entry.slug}/projects/${project.id}`;
  const withData = project && project.startingPoint !== 'model' && project.startingPoint !== 'unsure';
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <div className="ob ob-shell">
      <title>{`${title} — Valcairn`}</title>
      <aside className={`ob-side${collapsed ? ' ob-side--collapsed' : ''}`} aria-label="Sidebar">
        <div className="ob-side-head">
          <div className="ob-brand"><span className="dash-mark" aria-hidden="true" /><strong>Valcairn</strong></div>
          <button type="button" className="ob-side-toggle" onClick={toggle} aria-expanded={!collapsed} aria-label={toggleLabel} title={toggleLabel}><Icon name="panel" size={16} stroke={2} /></button>
        </div>
        <Link className="ob-org-switch" to="/start" aria-label="Switch or add a workspace" title={entry.name}>
          <span className="ob-monogram ob-monogram--sm" aria-hidden="true">{initials(entry.name)}</span>
          <span className="ob-org-text" style={{ flex: 1, minWidth: 0 }}><strong style={{ display: 'block', fontSize: 14 }}>{entry.name}</strong><span className="ob-muted" style={{ fontSize: 12 }}>{entry.kind === 'personal' ? 'Personal' : roleName(role)}</span></span>
          <Icon name="updown" size={14} />
        </Link>
        <nav aria-label="Workspace">
          <Link to={`/w/${entry.slug}`} title="Projects" aria-current={current === 'projects' ? 'page' : undefined}><Tile icon="grid" tone="orange" size="sm" /><span className="ob-side-label">Projects</span></Link>
          {project && (
            <div className="ob-side-sub">
              <Link to={projectBase} aria-current={current === 'project' ? 'page' : undefined} title={project.name} className="ob-side-project">{project.name}</Link>
              {withData && DATASET_PAGES.map(([id, label, suffix]) => (
                <Link key={id} to={`${projectBase}/dataset${suffix}`} aria-current={current === id ? 'page' : undefined}>
                  {label}{id === 'resolve' && openIssues > 0 && <span className="ob-badge tile--orange">{openIssues}</span>}
                </Link>
              ))}
            </div>
          )}
          <Link to={`/w/${entry.slug}/models`} title="Models"><Tile icon="layers" tone="blue" size="sm" /><span className="ob-side-label">Models</span></Link>
          {current.startsWith('models') && (
            <div className="ob-side-sub">
              {MODEL_PAGES.map(([id, label, suffix]) => (
                <Link key={id} to={`/w/${entry.slug}/models${suffix}`} aria-current={current === id ? 'page' : undefined}>{label}</Link>
              ))}
            </div>
          )}
          <Link to={`/w/${entry.slug}/device`} title="Run on this device" aria-current={current === 'device' ? 'page' : undefined}><Tile icon="play" tone="green" size="sm" /><span className="ob-side-label">Run on this device</span></Link>
          <Link to={`/w/${entry.slug}/memory`} title="Memory" aria-current={current === 'memory' ? 'page' : undefined}><Tile icon="data" tone="teal" size="sm" /><span className="ob-side-label">Memory</span></Link>
          {entry.kind === 'organization' && <a aria-disabled="true" title="Financing: planned, not available yet"><Tile icon="bank" tone="amber" size="sm" /><span className="ob-side-label">Financing</span> <span className="ob-badge">Planned</span></a>}
          {entry.kind === 'organization' && <Link to={`/w/${entry.slug}/setup/team`} title="Team"><Tile icon="people" tone="violet" size="sm" /><span className="ob-side-label">Team</span></Link>}
          {account.isStaff && <Link to="/staff" title="Review queue"><Tile icon="shield" tone="green" size="sm" /><span className="ob-side-label">Review queue</span></Link>}
        </nav>
        <div className="ob-side-foot">
          <ThemeToggle className="icon-btn ob-side-theme" />
          <div className="ob-signout">
            {signOutState === 'failed' && <p className="ob-alert" role="alert">We couldn't sign you out, so you're still signed in. Check your connection and try again.</p>}
            <button type="button" className="btn-text" disabled={signOutState === 'pending'} onClick={signOut}>
              {signOutState === 'pending' ? 'Signing out…' : signOutState === 'failed' ? 'Try signing out again' : 'Sign out'}
            </button>
          </div>
        </div>
      </aside>
      <main className="ob-body">
        {entry.synthetic && <p className="ob-alert ob-alert--info" role="note"><strong>Synthetic demo workspace.</strong> Everything here is generated for demonstration. It is not a real customer, and training, deployment and financing are planned, not running.</p>}
        {children}
      </main>
    </div>
  );
}
