import { useState } from 'react';
import { Link, redirect, useNavigate } from 'react-router';
import { api } from '../api.js';
import { Icon, SetupShell, Tile, requireVerified } from './ui.jsx';

export async function personalLoader() {
  const account = await requireVerified();
  const existing = account.workspaces.find((w) => w.kind === 'personal');
  if (existing) throw redirect(`/w/${existing.slug}`);
  return account;
}

const KINDS = [
  { id: 'student', title: 'Student', body: 'Coursework, a thesis or a project' },
  { id: 'researcher', title: 'Researcher', body: 'At a university or institute' },
  { id: 'independent', title: 'Independent', body: 'Building on your own' },
];

export function Personal() {
  const navigate = useNavigate();
  const [kind, setKind] = useState('student');
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState(false);
  const academic = kind !== 'independent';

  async function submit(event) {
    event.preventDefault();
    setPending(true);
    const res = await api.createPersonal({ ...Object.fromEntries(new FormData(event.currentTarget)), kind }).catch(() => null);
    setPending(false);
    if (res?.ok) return navigate(`/w/${res.data.workspace.slug}/projects/new`);
    setMessage(res?.data.error ?? 'Could not create your workspace.');
  }

  return (
    <SetupShell tone="violet" context="Personal workspace" exit={{ to: '/start', label: 'Back' }}>
      <title>Your personal workspace — Valcairn</title>
      <form className="ob-main" onSubmit={submit} noValidate>
        <section className="ob-col">
          <div className="ob-intro">
            <Tile icon="study" tone="violet" size="lg" />
            <h1 className="ob-h1">Your personal workspace</h1>
            <p className="ob-lede">For coursework, research and side projects. It's yours alone, and you can bring it into a lab or company later.</p>
          </div>
          {message && <p className="ob-alert" role="alert">{message}</p>}
          <fieldset>
            <legend className="ob-legend">Which describes you best?</legend>
            <div className="ob-grid ob-grid--tight">
              {KINDS.map((k) => (
                <button key={k.id} type="button" className="ob-option" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>
                  <strong>{k.title}</strong><span>{k.body}</span>
                </button>
              ))}
            </div>
          </fieldset>
          {academic && (
            <div className="ob-grid">
              <div className="ob-field"><label htmlFor="institution">University or institute</label><input id="institution" name="institution" type="text" maxLength={160} /></div>
              <div className="ob-field"><label htmlFor="lab">Lab or group <span className="ob-optional">(optional)</span></label><input id="lab" name="lab" type="text" maxLength={160} /></div>
            </div>
          )}
          {academic && (
            <div className="ob-note tile--violet"><Tile icon="info" tone="violet" size="sm" /><span>Academic email verification, which unlocks datasets licensed only for non-commercial research, comes in a later release. You can add it then without starting over.</span></div>
          )}
          <div className="ob-field">
            <label htmlFor="work">What are you working on? <span className="ob-optional">(optional)</span></label>
            <textarea id="work" name="work" rows={3} maxLength={1000} placeholder="e.g. Thesis on grasp prediction from depth images" />
          </div>
          <div className="ob-note tile--blue"><Tile icon="mail" tone="blue" size="sm" /><span><strong>Is your lab already on Valcairn?</strong> Ask its admin for an invite. Lab projects and data belong in the lab's organization.</span></div>
          <div className="ob-actions">
            <Link className="btn-ghost" to="/start">Back</Link>
            <button className="btn-app" type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create workspace'} <Icon name="arrow" size={16} /></button>
          </div>
        </section>
        <aside className="ob-aside">
          <div className="ob-card">
            <h2>How it differs from an organization</h2>
            <ul className="ob-list">
              <li><Tile icon="check" tone="green" size="sm" /><div><strong>Projects and testing</strong><span className="ob-muted">Same tools, private to you.</span></div></li>
              <li><Tile icon="study" tone="violet" size="sm" /><div><strong>Research-only datasets</strong><span className="ob-muted">After academic verification. Each license is labelled.</span></div></li>
              <li><Tile icon="minus" tone="plain" size="sm" /><div><strong>Commercial licenses and financing</strong><span className="ob-muted">Need an organization. Create one when you start a company.</span></div></li>
              <li><Tile icon="arrow" tone="blue" size="sm" /><div><strong>Move to an organization later</strong><span className="ob-muted">Projects and their rights records move with you.</span></div></li>
            </ul>
          </div>
        </aside>
      </form>
    </SetupShell>
  );
}
