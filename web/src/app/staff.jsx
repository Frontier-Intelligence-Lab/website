import { useState } from 'react';
import { Link, redirect, useLoaderData, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { SetupShell, Tile, requireVerified } from './ui.jsx';
import { KIND_ONE, Preview, fmtTime, formatName } from './preview.jsx';

const CHECKS = [
  ['rights', 'The provider may license or use this data for the stated purpose'],
  ['consent', 'People shown agreed, or are not identifiable'],
  ['labels', 'Labels are present and plausible on the files checked'],
  ['duplicates', 'Duplicates are understood and acceptable'],
  ['format', 'Files open and match the declared kind of input'],
];
const PROVENANCE = { ours: 'Collected by the customer', licensed: 'Licensed from a third party', users: "Provided by the customer's users" };
const SCOPE = { span: 'time span', file: 'whole file', box: 'box' };
// Names the issue a note was written against, from its key in src/lib/dataset.js.
function describeIssue(key, uploads) {
  const [kind, rest] = key.split(':');
  const file = uploads.find((u) => u.id === rest)?.filename;
  if (kind === 'duplicate') return `Duplicate kept: ${file ?? 'a file'}`;
  if (kind === 'empty') return `Empty file kept: ${file ?? 'a file'}`;
  if (kind === 'archive') return `Archive not opened: ${file ?? 'a file'}`;
  if (key === 'labels:none') return 'Released without a label set';
  if (kind === 'unlabelled') return `Unlabelled ${rest} files kept`;
  return key;
}
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
  const { review, workspace, project, uploads, labelSet = [], annotations = [], issueNotes = [], warnings = { labels: 0, kinds: 0 } } = useLoaderData();
  const labelOf = (id) => labelSet.find((l) => l.id === id);
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
              <li><div><strong>Acceptance rule</strong><span className="ob-muted">{!project.success ? 'Not set' : project.success.criteria ? `${project.success.measure === 'data_quality' ? 'Data quality' : 'Rubric'}: ${project.success.criteria}` : `${project.success.measure} ≥ ${project.success.target ?? '—'} vs ${project.success.baseline}`}</span></div></li>
            </ul>
          </section>
          {(warnings.labels > 0 || warnings.kinds > 0) && <p className="ob-alert" role="note"><strong>This snapshot holds {warnings.labels} label{warnings.labels === 1 ? '' : 's'} and {warnings.kinds} file type{warnings.kinds === 1 ? '' : 's'} that today’s checks refuse</strong>, for example a box on a file whose content is not an image. It was sent before those checks existed. Request changes so the customer can repair it.</p>}
          {issueNotes.length > 0 && (
            <section className="ob-card">
              <h2>Kept with a note · {issueNotes.length}</h2>
              <p className="ob-muted">The customer chose to keep these as they are. Each note is part of the snapshot you are deciding on.</p>
              <ul className="ob-list">
                {issueNotes.map((n) => <li key={n.key}><div><strong>{describeIssue(n.key, uploads)}</strong><span className="ob-muted">“{n.note}”</span></div></li>)}
              </ul>
            </section>
          )}
          <section className="ob-card">
            <h2>Label set · {labelSet.length}</h2>
            {labelSet.length === 0 ? <p className="ob-muted">No labels were defined for this snapshot.</p> : (
              <div className="ob-chips" style={{ gap: 6 }}>
                {labelSet.map((l) => <span key={l.id} className={`ds-badge k-${l.tone}`}>{l.name} · {SCOPE[l.scope] ?? l.scope} · {annotations.filter((a) => a.labelId === l.id).length}</span>)}
              </div>
            )}
          </section>
          <section className="ob-card">
            <h2>Sample files · {uploads.length}</h2>
            {uploads.length === 0 ? <p className="ob-muted">No files. This is a license or collection request.</p> : (
              <div className="ds-grid">
                {uploads.map((u) => {
                  const mine = annotations.filter((a) => a.uploadId === u.id);
                  return (
                    <div key={u.id} className={`ds-card k-${u.kind}`} style={{ cursor: 'default' }}>
                      <Preview item={u} h={150} controls contain boxes={mine.filter((a) => a.box).map((a) => ({ ...a.box, id: a.id, label: labelOf(a.labelId) }))} />
                      <div className="ds-card-body">
                        <span className="ds-card-name"><span className="ds-dot" aria-hidden="true" /><span>{u.filename}</span></span>
                        <span className="ob-muted" style={{ fontSize: 12.5 }}>{KIND_ONE[u.kind]} · {formatName(u.contentType)} · {fmtBytes(u.sizeBytes)} · sha256 {u.sha256.slice(0, 12)}…</span>
                        <div className="ob-chips" style={{ gap: 4 }}>
                          {mine.length === 0 ? <span className="ob-badge">no labels</span> : mine.map((a) => {
                            const l = labelOf(a.labelId);
                            return <span key={a.id} className={`ds-badge k-${l?.tone ?? 'plain'}`}>{l?.name ?? 'removed label'}{a.startMs != null ? ` ${fmtTime(a.startMs, true)}–${fmtTime(a.endMs, true)}` : ''}{a.box ? ' · box' : ''}</span>;
                          })}
                        </div>
                        {u.downloadUrl ? <a className="btn-small" href={u.downloadUrl} rel="noreferrer" style={{ alignSelf: 'flex-start' }}>Download original</a> : <span className="ob-badge">Storage off</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="ob-muted">Previews and labels are the frozen snapshot. Download links expire after 5 minutes and previews after 30; reload the page for fresh ones.</p>
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
