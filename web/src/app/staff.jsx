import { useState } from 'react';
import { Link, redirect, useLoaderData, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { SetupShell, Tile, requireVerified } from './ui.jsx';

const CHECKS = [
  ['rights', 'The provider may license or use this data for the stated purpose'],
  ['consent', 'People shown agreed, or are not identifiable'],
  ['labels', 'Labels are present and plausible on the files checked'],
  ['duplicates', 'Duplicates are understood and acceptable'],
  ['format', 'Files open and match the declared kind of input'],
];
const PROVENANCE = { ours: 'Collected by the customer', licensed: 'Licensed from a third party', users: "Provided by the customer's users" };
const fmtBytes = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function requireStaff() {
  const account = await requireVerified();
  if (!account.isStaff) throw redirect('/start');
  return account;
}

export async function queueLoader({ request }) {
  await requireStaff();
  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  return { status, ...(await api.staffReviews(status)) };
}

export function StaffQueue() {
  const { status, reviews } = useLoaderData();
  const [, setParams] = useSearchParams();
  return (
    <SetupShell tone="green" context="Review queue" status={null} exit={{ to: '/start', label: 'Back' }}>
      <title>Review queue — Valcairn</title>
      <main className="ob-main ob-main--narrow" style={{ maxWidth: 960 }}>
        <div className="ob-intro">
          <span className="ob-eyebrow">Valcairn staff</span>
          <h1 className="ob-h1">Rights and quality review</h1>
          <p className="ob-lede">Customer data waiting for an independent check. Opening a review is recorded in the customer's audit log.</p>
        </div>
        <div className="ob-segment" role="group" aria-label="Status">
          {[['pending', 'Waiting'], ['changes_requested', 'Changes requested'], ['approved', 'Approved']].map(([id, label]) => (
            <button key={id} type="button" aria-pressed={status === id} onClick={() => setParams({ status: id })}>{label}</button>
          ))}
        </div>
        {reviews.length === 0 ? <p className="ob-muted">Nothing here.</p> : (
          <ul className="ob-list ob-card">
            {reviews.map((r) => (
              <li key={r.id}>
                <Tile icon="data" tone="teal" size="sm" />
                <div><strong>{r.projectName}</strong><span className="ob-muted">{r.workspaceName} · submitted {new Date(r.createdAt).toLocaleString()}</span></div>
                <Link className="btn-ghost" to={`/staff/reviews/${r.id}`}>{status === 'pending' ? 'Review' : 'Open'}</Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </SetupShell>
  );
}

export async function reviewLoader({ params }) {
  await requireStaff();
  return api.staffReview(params.reviewId);
}

export function StaffReview() {
  const { review, workspace, project, uploads } = useLoaderData();
  const navigate = useNavigate();
  const [checks, setChecks] = useState(review.checks ?? {});
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState(false);
  const open = review.status === 'pending';
  const allChecked = CHECKS.every(([id]) => checks[id]);
  const d = project.dataSource ?? {};

  async function decide(decision, form) {
    setPending(true);
    const res = await api.staffDecide(review.id, { decision, checks, notes: form.get('notes') }).catch(() => null);
    setPending(false);
    if (res?.ok) return navigate('/staff');
    setMessage(res?.data.error ?? 'Could not save the decision.');
  }

  return (
    <SetupShell tone="green" context="Review" status={null} exit={{ to: '/staff', label: 'Back to queue' }}>
      <title>{`Review: ${project.name} — Valcairn`}</title>
      <form className="ob-main" onSubmit={(e) => { e.preventDefault(); decide(e.nativeEvent.submitter?.value, new FormData(e.currentTarget)); }}>
        <section className="ob-col">
          <div className="ob-intro">
            <span className="ob-eyebrow">{workspace.name} · {workspace.kind}</span>
            <h1 className="ob-h1">{project.name}</h1>
            <p className="ob-lede">{project.task}</p>
          </div>
          <section className="ob-card">
            <h2>Rights record</h2>
            <ul className="ob-list">
              <li><div><strong>Source</strong><span className="ob-muted">{d.mode === 'upload' ? PROVENANCE[d.provenance] ?? 'Not stated' : d.mode === 'license' ? `License request: ${d.query ?? '—'}` : `Collection brief: ${d.brief ?? '—'}`}</span></div></li>
              {d.mode === 'upload' && <li><div><strong>Allowed uses</strong><span className="ob-muted">{d.allowedUses?.join(', ') || 'None stated'}</span></div></li>}
              {d.mode === 'upload' && <li><div><strong>Personal data</strong><span className="ob-muted">{{ no: 'No', yes: 'Yes', unsure: 'Not sure' }[d.personalData] ?? '—'}</span></div></li>}
              <li><div><strong>Acceptance rule</strong><span className="ob-muted">{project.success ? `${project.success.measure} ≥ ${project.success.target ?? '—'} vs ${project.success.baseline}` : 'Not set'}</span></div></li>
            </ul>
          </section>
          <section className="ob-card">
            <h2>Sample files · {uploads.length}</h2>
            {uploads.length === 0 ? <p className="ob-muted">No files. This is a license or collection request.</p> : (
              <ul className="ob-list">
                {uploads.map((u) => (
                  <li key={u.id}>
                    <div><strong>{u.filename}</strong><span className="ob-muted">{fmtBytes(u.sizeBytes)} · {u.contentType}{u.duplicateOf ? ' · duplicate of an earlier file' : ''} · sha256 {u.sha256.slice(0, 16)}…</span></div>
                    {u.downloadUrl ? <a className="btn-ghost" href={u.downloadUrl} rel="noreferrer">Download</a> : <span className="ob-badge">Storage off</span>}
                  </li>
                ))}
              </ul>
            )}
            <p className="ob-muted">Download links expire after 5 minutes. Reload the page for fresh ones.</p>
          </section>
        </section>
        <aside className="ob-aside">
          <section className="ob-card ob-card--strong">
            <h2>{open ? 'Your decision' : `Decided: ${review.status.replace('_', ' ')}`}</h2>
            {message && <p className="ob-alert" role="alert">{message}</p>}
            <fieldset disabled={!open || pending}>
              <legend className="ob-legend">Checks</legend>
              <div className="ob-intro" style={{ gap: 10 }}>
                {CHECKS.map(([id, label]) => (
                  <label key={id} className="ob-check"><input type="checkbox" checked={Boolean(checks[id])} onChange={(e) => setChecks({ ...checks, [id]: e.target.checked })} />{label}</label>
                ))}
              </div>
            </fieldset>
            <div className="ob-field">
              <label htmlFor="notes">Notes for the customer</label>
              <textarea id="notes" name="notes" rows={4} maxLength={4000} defaultValue={review.notes ?? ''} disabled={!open} placeholder="Required when requesting changes" />
            </div>
            {open && (
              <div className="ob-actions">
                <button className="btn-ghost" type="submit" value="changes_requested" disabled={pending}>Request changes</button>
                <button className="btn-app" type="submit" value="approved" disabled={pending || !allChecked}>Approve</button>
              </div>
            )}
            {open && !allChecked && <p className="ob-muted">Approve unlocks when every check is ticked.</p>}
          </section>
        </aside>
      </form>
    </SetupShell>
  );
}
