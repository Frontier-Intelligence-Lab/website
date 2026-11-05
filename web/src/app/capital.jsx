import { useState } from 'react';
import { Link, redirect, useLoaderData, useNavigate, useRevalidator, useSearchParams } from 'react-router';
import { api } from '../api.js';
import { FieldError, Icon, SetupShell, Tile, requireVerified, requireWorkspace } from './ui.jsx';
import { CAPITAL_ROLES, WorkspaceShell, plural } from './shell.jsx';
import { afterSave, consentStep, consentValid, sendBody } from './capital-consent.js';
import { ReferenceFacts } from './reference-facts.js';
import { formatUsd, parseUsd, totalsByBasis } from '../../../src/lib/capital.js';

const SENDERS = ['owner', 'admin'];
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const STATUS = { draft: ['Draft', 'tile--plain'], submitted: ['With Valcairn review', 'tile--orange'], changes_requested: ['Changes requested', 'tile--amber'], evidence_reviewed: ['Evidence reviewed', 'tile--green'] };
const CATEGORY = { compute: 'Compute', deployment: 'Deployment', storage: 'Storage', equipment: 'Equipment' };
const PERIOD = { one_time: 'One-time', monthly: 'Monthly', annual: 'Annual' };
const BASIS = { quoted: ['Quoted', 'k-blue'], estimated: ['Estimated', 'k-violet'], incurred: ['Incurred', 'k-orange'] };
const KIND = { cost_assumption: 'Cost assumption', credit_restriction: 'Credit restriction', dataset_provenance: 'Dataset provenance', model_provenance: 'Model provenance', local_benchmark: 'Local benchmark', company_record: 'Company record' };
const VERIFICATION = { unverified: ['Unverified', 'tile--plain'], client_reported: ['Client-reported', 'tile--amber'] };
const REF_KIND = { incorporation: 'Incorporation', bank_statement: 'Bank statement', tax_filing: 'Tax filing', contract: 'Contract', other: 'Other' };
const CREDIT_STATUS = { claimed: ['Claimed', 'tile--amber'], evidenced: ['Evidenced', 'tile--teal'], withdrawn: ['Withdrawn', 'tile--plain'] };
const DECISION = { changes_requested: 'Changes requested', evidence_reviewed: 'Evidence reviewed', withdrawn: 'Withdrawn' };
const failed = (res) => res?.data.error ?? 'That did not work. Check your connection and try again.';
const newId = () => `ci_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

async function requireCapital(slug) {
  const { account, entry } = await requireWorkspace(slug);
  if (entry.kind !== 'organization' || !CAPITAL_ROLES.includes(entry.role)) throw redirect(`/w/${entry.slug}`);
  return { account, entry };
}
export async function capitalLoader({ params }) {
  const { account, entry } = await requireCapital(params.slug);
  return { account, entry, ...(await api.capital(entry.id)) };
}
export async function caseLoader({ params }) {
  const { account, entry } = await requireCapital(params.slug);
  return { account, entry, ...(await api.capitalCase(entry.id, params.caseId)) };
}

function Badge({ map, value }) {
  const [label, tone] = map[value] ?? [value, 'tile--plain'];
  return <span className={`ob-badge ${tone}`}>{label}</span>;
}

/** Valcairn's internal stages, then the lender stages that do not exist in the product yet. */
function Stages({ status, lenderStages }) {
  const internal = [['draft', 'Draft'], ['submitted', 'Sent to Valcairn review'], ['evidence_reviewed', 'Evidence reviewed']];
  const reached = { draft: 0, submitted: 1, changes_requested: 1, evidence_reviewed: 2 }[status] ?? 0;
  return (
    <ol className="cap-stages" aria-label="Stages">
      {internal.map(([id, label], i) => <li key={id} className={i < reached ? 'is-done' : i === reached ? 'is-current' : undefined}><span aria-hidden="true" />{label}</li>)}
      {lenderStages.map(([id, label]) => <li key={id} className="is-planned"><span aria-hidden="true" />{label} <span className="ob-badge">Planned</span></li>)}
    </ol>
  );
}

/** Totals by basis and by period. Nothing is added across bases or periods; no planning horizon is invented. */
function Totals({ totals, bases, periods }) {
  return (
    <div className="cap-totals">
      {bases.map((b) => {
        const shown = periods.filter((p) => totals[b]?.[p] == null || totals[b][p] > 0);
        return (
          <div key={b} className={BASIS[b][1]}>
            <span className="row-wrap" style={{ gap: 6 }}><span className="ds-dot" aria-hidden="true" /><span className="ob-muted">{BASIS[b][0]}</span></span>
            {shown.length === 0 ? <strong>—</strong> : shown.map((p) => <span key={p} className="cap-total-line"><span className="ob-muted">{PERIOD[p]}</span><strong>{totals[b][p] == null ? '—' : formatUsd(totals[b][p])}</strong></span>)}
          </div>
        );
      })}
    </div>
  );
}
const totalsLine = (totals) => Object.entries(totals).flatMap(([b, byPeriod]) => Object.entries(byPeriod).filter(([, v]) => v > 0).map(([p, v]) => `${BASIS[b][0].toLowerCase()} ${PERIOD[p].toLowerCase()} ${formatUsd(v)}`)).join(' · ') || 'no cost items';
// "Reviewed by Valcairn" comes from append-only marks on a sent revision, never from the customer's record itself.
const reviewedIn = (marks, submissions) => (evidenceId) => marks.filter((m) => m.evidenceId === evidenceId).map((m) => submissions.find((s) => s.id === m.submissionId)?.revision).filter(Boolean);

/** Every field of each cost item, as saved: the same table on the Plan view, the Request consent view and the staff page. */
function CostTable({ items, evidence, onRemove }) {
  if (items.length === 0) return <p className="ob-muted">No cost items yet.</p>;
  return (
    <div className="ob-table-wrap">
      <table>
        <thead><tr><th>Item</th><th>Basis</th><th>Period</th><th className="num">Amount</th><th>Source · observed</th>{onRemove && <th />}</tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td><strong>{i.label}</strong><br /><span className="ob-muted">{CATEGORY[i.category]}</span></td>
              <td><span className={`ds-badge ${BASIS[i.basis][1]}`}>{BASIS[i.basis][0]}</span></td>
              <td>{PERIOD[i.period]}</td>
              <td className="num">{formatUsd(i.amountCents)}</td>
              <td><span style={{ fontSize: 13 }}>{i.source}</span><br /><span className="ob-muted">{i.observedAt}{i.evidenceId && ` · cites ${evidence.find((e) => e.id === i.evidenceId)?.title ?? 'a removed record'}`}</span></td>
              {onRemove && <td><button type="button" className="btn-small" onClick={() => onRemove(i)} aria-label={`Remove ${i.label}`}>Remove</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every field of each current credit record: provider, status, amount, expiry, restrictions and reference. */
function CreditTable({ credits, onCorrect }) {
  if (credits.length === 0) return <p className="ob-muted">None recorded.</p>;
  return (
    <div className="ob-table-wrap">
      <table>
        <thead><tr><th>Provider</th><th>Status</th><th className="num">Amount</th><th>Expires</th><th>Restrictions</th><th>Reference</th>{onCorrect && <th />}</tr></thead>
        <tbody>
          {credits.map((c) => (
            <tr key={c.id}>
              <td>{c.provider}</td><td><Badge map={CREDIT_STATUS} value={c.status} /></td><td className="num">{formatUsd(c.amountCents)}</td><td>{c.expiresOn ?? '—'}</td><td>{c.restrictions || '—'}</td><td className="mono" style={{ fontSize: 12.5 }}>{c.reference || '—'}</td>
              {onCorrect && <td><button type="button" className="btn-small" onClick={() => onCorrect(c)}>Correct</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AmountInput({ id, label, value, onChange, disabled, error, help }) {
  return (
    <div className="ob-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="decimal" value={value} placeholder="For example 12,500.00" disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={`${id}-help`} onChange={(e) => onChange(e.target.value)} />
      <FieldError id={`${id}-help`}>{error ?? (help && <span className="ob-muted">{help}</span>)}</FieldError>
    </div>
  );
}

/* ---------------- Capital home: cases and credit records ---------------- */

export function CapitalHome() {
  const { account, entry, role, cases, credits, options } = useLoaderData();
  const navigate = useNavigate();
  const [fields, setFields] = useState({ title: '', projectId: '', enhanceRunId: '' });
  const [state, setState] = useState({ pending: false, error: null, errors: {} });
  async function create(e) {
    e.preventDefault();
    setState({ pending: true, error: null, errors: {} });
    const res = await api.createCapitalCase(entry.id, { title: fields.title, projectId: fields.projectId || null, enhanceRunId: fields.enhanceRunId || null }).catch(() => null);
    if (!res?.ok) return setState({ pending: false, error: failed(res), errors: res?.data.errors ?? {} });
    navigate(`/w/${entry.slug}/capital/cases/${res.data.case.id}`);
  }
  return (
    <WorkspaceShell account={account} entry={entry} role={role} title="Capital" current="capital">
      <div className="ob-intro" style={{ gap: 8 }}>
        <span className="ob-eyebrow">Capital · {entry.name}</span>
        <h1 className="ob-h1">Capital</h1>
        <p className="ob-lede">Plan what your models will cost, record outside credits, and prepare a financing request with the evidence behind it. Valcairn reviews what you choose to send. It is not a lender, holds no balance for you, and nothing here moves money.</p>
      </div>

      <div className="ds-split">
        <div className="ds-main">
          <section className="ob-card">
            <div className="row-between"><h2>Cases</h2><span className="ob-muted" style={{ fontSize: 12.5 }}>{plural(cases.length, 'case')}</span></div>
            {cases.length === 0 ? <p className="ob-muted">No case yet. A case is one financing need: its cost plan, the request and its evidence.</p> : (
              <ul className="ob-list">
                {cases.map((c) => (
                  <li key={c.id}>
                    <Tile icon="bank" tone="amber" size="sm" />
                    <div><strong>{c.title}</strong><span className="ob-muted">Revision {c.revision} · requested {formatUsd(c.requestedAmountCents)} · {totalsLine(c.totals)}</span></div>
                    <Badge map={STATUS} value={c.status} />
                    <Link className="btn-ghost" to={`/w/${entry.slug}/capital/cases/${c.id}`}>Open</Link>
                  </li>
                ))}
              </ul>
            )}
            <form className="cap-form" onSubmit={create} noValidate>
              <h3 className="cap-h3">New case</h3>
              {state.error && <p className="ob-alert" role="alert">{state.error}</p>}
              <div className="ob-field"><label htmlFor="case-title">Title</label><input id="case-title" type="text" maxLength={120} value={fields.title} placeholder="For example Pilot deployment, line 2" onChange={(e) => setFields({ ...fields, title: e.target.value })} /></div>
              <div className="ob-grid ob-grid--tight">
                <div className="ob-field"><label htmlFor="case-project">Project <span className="ob-optional">(optional)</span></label><select id="case-project" className="ds-select" value={fields.projectId} onChange={(e) => setFields({ ...fields, projectId: e.target.value })}><option value="">None</option>{options.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><FieldError id="case-project-error">{state.errors.projectId}</FieldError></div>
                <div className="ob-field"><label htmlFor="case-run">Enhance plan <span className="ob-optional">(optional)</span></label><select id="case-run" className="ds-select" value={fields.enhanceRunId} onChange={(e) => setFields({ ...fields, enhanceRunId: e.target.value })}><option value="">None</option>{options.runs.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.status}</option>)}</select><FieldError id="case-run-error">{state.errors.enhanceRunId}</FieldError></div>
              </div>
              <div><button className="btn-app" type="submit" disabled={state.pending}>{state.pending ? 'Creating…' : 'Create case'}</button></div>
            </form>
          </section>
          <Credits entry={entry} credits={credits} />
        </div>
        <aside className="ds-side">
          <section className="ob-card">
            <h2>How it works</h2>
            <ol className="ob-list">
              {[['Plan', 'Cost items in US cents, each quoted, estimated or incurred, with its source and date.'], ['Request', 'Purpose, amount, timing and company details. An owner or admin sends one exact revision to Valcairn’s internal review.'], ['Evidence', 'References to frozen dataset versions, enhance plans, your own measured runs, credit terms and company records. Export the package as JSON.']].map(([label, note], i) => (
                <li key={label}><span className="ob-num">{i + 1}</span><div><strong>{label}</strong><span className="ob-muted">{note}</span></div></li>
              ))}
            </ol>
          </section>
          <section className="ob-card">
            <h2>Planned, not built</h2>
            <ul className="ob-list">
              {[['Lender offers, approvals and funding', 'No provider is connected; staff review is not a credit decision.'], ['Reservations and reconciliation', 'Only against a real executor or meter, never simulated spend.'], ['Private document upload', 'Finance documents stay out of the dataset upload path; cite them by reference for now.']].map(([label, note]) => (
                <li key={label}><Tile icon="clock" tone="plain" size="sm" /><div><strong>{label}</strong><span className="ob-muted">{note}</span></div><span className="ob-badge">Planned</span></li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </WorkspaceShell>
  );
}

const blankCredit = { provider: '', status: 'claimed', amount: '', expiresOn: '', restrictions: '', reference: '' };

function Credits({ entry, credits }) {
  const revalidator = useRevalidator();
  const [form, setForm] = useState({ ...blankCredit, supersedes: null });
  const [state, setState] = useState({ pending: false, error: null, errors: {} });
  const current = credits.filter((c) => !c.supersededBy);
  const history = credits.filter((c) => c.supersededBy);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const correct = (c) => setForm({ provider: c.provider, status: c.status, amount: (c.amountCents / 100).toFixed(2), expiresOn: c.expiresOn ?? '', restrictions: c.restrictions, reference: c.reference, supersedes: c.id });
  async function save(e) {
    e.preventDefault();
    const amountCents = parseUsd(form.amount);
    if (amountCents == null) return setState({ pending: false, error: null, errors: { amountCents: 'Enter a dollar amount with at most two decimals.' } });
    setState({ pending: true, error: null, errors: {} });
    const res = await api.addCreditRecord(entry.id, { provider: form.provider, status: form.status, amountCents, expiresOn: form.expiresOn || null, restrictions: form.restrictions, reference: form.reference, supersedes: form.supersedes }).catch(() => null);
    if (!res?.ok) return setState({ pending: false, error: failed(res), errors: res?.data.errors ?? {} });
    setForm({ ...blankCredit, supersedes: null });
    setState({ pending: false, error: null, errors: {} });
    revalidator.revalidate();
  }
  return (
    <section className="ob-card">
      <div className="row-between"><h2>Outside credits</h2><span className="ob-muted" style={{ fontSize: 12.5 }}>{plural(current.length, 'current record')}</span></div>
      <p className="ob-muted">Credits a provider has promised or confirmed to the company, as you state them. They are not a Valcairn balance and cannot be spent here. A correction adds a new record; the old one stays on file.</p>
      {current.length > 0 && <CreditTable credits={current} onCorrect={correct} />}
      {history.length > 0 && <details><summary>Corrected records · {history.length}</summary><ul className="ob-list">{history.map((c) => <li key={c.id}><div><strong>{c.provider} · {formatUsd(c.amountCents)}</strong><span className="ob-muted">{CREDIT_STATUS[c.status]?.[0]} · recorded {date(c.createdAt)} · corrected later</span></div></li>)}</ul></details>}
      <form className="cap-form" onSubmit={save} noValidate>
        <h3 className="cap-h3">{form.supersedes ? 'Correct a record' : 'Add a credit record'}</h3>
        {state.error && <p className="ob-alert" role="alert">{state.error}</p>}
        <div className="ob-grid ob-grid--tight">
          <div className="ob-field"><label htmlFor="cr-provider">Provider</label><input id="cr-provider" type="text" maxLength={80} value={form.provider} aria-invalid={Boolean(state.errors.provider)} onChange={(e) => set({ provider: e.target.value })} /><FieldError id="cr-provider-error">{state.errors.provider}</FieldError></div>
          <div className="ob-field"><label htmlFor="cr-status">Status</label><select id="cr-status" className="ds-select" value={form.status} onChange={(e) => set({ status: e.target.value })}>{Object.entries(CREDIT_STATUS).map(([id, [label]]) => <option key={id} value={id}>{label}</option>)}</select></div>
          <AmountInput id="cr-amount" label="Amount (US dollars)" value={form.amount} error={state.errors.amountCents} onChange={(amount) => set({ amount })} />
          <div className="ob-field"><label htmlFor="cr-expires">Expires <span className="ob-optional">(optional)</span></label><input id="cr-expires" type="date" value={form.expiresOn} onChange={(e) => set({ expiresOn: e.target.value })} /><FieldError id="cr-expires-error">{state.errors.expiresOn}</FieldError></div>
        </div>
        <div className="ob-field"><label htmlFor="cr-restrictions">Restrictions <span className="ob-optional">(optional)</span></label><input id="cr-restrictions" type="text" maxLength={1000} placeholder="For example compute only, one region, not transferable" value={form.restrictions} onChange={(e) => set({ restrictions: e.target.value })} /></div>
        <div className="ob-field"><label htmlFor="cr-reference">Provider reference {form.status === 'evidenced' ? '' : <span className="ob-optional">(optional)</span>}</label><input id="cr-reference" type="text" maxLength={200} value={form.reference} aria-invalid={Boolean(state.errors.reference)} onChange={(e) => set({ reference: e.target.value })} /><FieldError id="cr-reference-error">{state.errors.reference}</FieldError></div>
        <div className="ob-row-actions">
          <button className="btn-app" type="submit" disabled={state.pending}>{state.pending ? 'Saving…' : form.supersedes ? 'Save correction' : 'Add record'}</button>
          {form.supersedes && <button type="button" className="btn-ghost" onClick={() => setForm({ ...blankCredit, supersedes: null })}>Cancel</button>}
        </div>
      </form>
    </section>
  );
}

/* ---------------- One case: shell, saving, and the three views ---------------- */

function CaseShell({ data, view, children }) {
  const { account, entry, role, case: kase } = data;
  const base = `/w/${entry.slug}/capital/cases/${kase.id}`;
  return (
    <WorkspaceShell account={account} entry={entry} role={role} title={kase.title} current={`capital-${view}`}>
      <div className="ob-actions" style={{ alignItems: 'flex-end' }}>
        <div className="ob-intro" style={{ gap: 8 }}>
          <Link className="ob-eyebrow" to={`/w/${entry.slug}/capital`}>Capital · {entry.name}</Link>
          <h1 className="ob-h1">{kase.title}</h1>
          <div className="ob-chips" style={{ gap: 6 }}>
            <Badge map={STATUS} value={kase.status} />
            <span className="ob-badge">Revision {kase.revision}</span>
            {kase.submittedRevision != null && <span className="ob-badge">Sent as revision {kase.submittedRevision}</span>}
            {kase.submittedRevision != null && kase.submittedRevision !== kase.revision && kase.status !== 'draft' && <span className="ob-badge tile--amber">Draft changed since</span>}
          </div>
        </div>
        <div className="ob-segment" role="group" aria-label="Case views">
          {[['plan', 'Plan', ''], ['request', 'Request', '/request'], ['evidence', 'Evidence', '/evidence']].map(([id, label, suffix]) => <Link key={id} to={`${base}${suffix}`} className="cap-tab" aria-current={view === id ? 'page' : undefined}>{label}</Link>)}
        </div>
      </div>
      {kase.status === 'submitted' && <p className="ob-alert ob-alert--info" role="note">Revision {kase.submittedRevision} is with Valcairn’s internal review. Nothing can change until staff request changes or mark the evidence reviewed, or an owner withdraws it.</p>}
      {children}
    </WorkspaceShell>
  );
}

/** Saves the whole draft against the revision that was loaded; a stale revision asks for a reload instead of overwriting. Resolves with the saved response or null. */
function useCaseSave(entry, kase) {
  const revalidator = useRevalidator();
  const [status, setStatus] = useState({ pending: false, error: null, errors: {}, saved: false, stale: false });
  async function save(body) {
    setStatus({ pending: true, error: null, errors: {}, saved: false, stale: false });
    const res = await api.updateCapitalCase(entry.id, kase.id, { expectedRevision: kase.revision, ...body }).catch(() => null);
    if (!res?.ok) { setStatus({ pending: false, error: failed(res), errors: res?.data.errors ?? {}, saved: false, stale: res?.data.code === 'stale_revision' }); return null; }
    setStatus({ pending: false, error: null, errors: {}, saved: true, stale: false });
    revalidator.revalidate();
    return res.data;
  }
  const reload = () => revalidator.revalidate();
  return { status, save, reload, locked: kase.status === 'submitted' };
}

function SaveState({ status, reload }) {
  return (
    <>
      {status.error && <p className="ob-alert" role="alert">{status.error}{status.stale && <> <button type="button" className="btn-text" onClick={reload}>Reload the latest revision</button></>}</p>}
      {status.saved && <p className="ob-ok" role="status"><Icon name="check" size={14} stroke={2.5} />Saved as a new revision</p>}
    </>
  );
}

const blankItem = () => ({ id: newId(), category: 'compute', label: '', amount: '', period: 'one_time', basis: 'estimated', source: '', observedAt: '', evidenceId: '' });

export function CapitalPlan() {
  const data = useLoaderData();
  const { entry, case: kase, evidence, options } = data;
  const { status, save, reload, locked } = useCaseSave(entry, kase);
  const [links, setLinks] = useState({ projectId: kase.projectId ?? '', enhanceRunId: kase.enhanceRunId ?? '', datasetVersions: kase.draft.datasetVersions });
  const [items, setItems] = useState(kase.draft.costItems);
  const [row, setRow] = useState(blankItem);
  const [rowError, setRowError] = useState(null);
  const totals = totalsByBasis(items);
  const hasVersion = (v) => links.datasetVersions.some((d) => d.projectId === v.projectId && d.version === v.version);
  const toggleVersion = (v) => setLinks({ ...links, datasetVersions: hasVersion(v) ? links.datasetVersions.filter((d) => !(d.projectId === v.projectId && d.version === v.version)) : [...links.datasetVersions, { projectId: v.projectId, version: v.version }] });
  function addRow(e) {
    e.preventDefault();
    const amountCents = parseUsd(row.amount);
    if (!row.label.trim()) return setRowError('Give the item a name.');
    if (amountCents == null) return setRowError('Enter a dollar amount with at most two decimals.');
    if (!row.source.trim()) return setRowError('Say where the figure comes from.');
    if (!row.observedAt) return setRowError('Pick the date you observed the figure.');
    if (row.basis === 'incurred' && !row.evidenceId) return setRowError('An incurred cost must cite an evidence record. Add one on the Evidence view first.');
    if (items.length >= options.constants.maxCostItems) return setRowError(`At most ${options.constants.maxCostItems} cost items.`);
    setItems([...items, { id: row.id, category: row.category, label: row.label.trim(), amountCents, period: row.period, basis: row.basis, source: row.source.trim(), observedAt: row.observedAt, evidenceId: row.basis === 'incurred' ? row.evidenceId : null }]);
    setRow(blankItem());
    setRowError(null);
  }
  const savePlan = () => save({ projectId: links.projectId || null, enhanceRunId: links.enhanceRunId || null, draft: { ...kase.draft, costItems: items, datasetVersions: links.datasetVersions } });
  const dirty = JSON.stringify({ items, links }) !== JSON.stringify({ items: kase.draft.costItems, links: { projectId: kase.projectId ?? '', enhanceRunId: kase.enhanceRunId ?? '', datasetVersions: kase.draft.datasetVersions } });
  const readOnly = locked || status.pending;
  return (
    <CaseShell data={data} view="plan">
      <div className="ds-split">
        <div className="ds-main">
          <section className="ob-card">
            <h2>Cost plan</h2>
            <p className="ob-muted">Each item is one cost in US dollars, with where the figure comes from and when you saw it. Quoted, estimated and incurred are kept apart and never added together. Valcairn does not price anything for you.</p>
            <SaveState status={status} reload={reload} />
            <FieldError id="items-error">{status.errors.costItems}</FieldError>
            <CostTable items={items} evidence={evidence} onRemove={readOnly ? null : (i) => setItems(items.filter((x) => x.id !== i.id))} />
            {!locked && (
              <form className="cap-form" onSubmit={addRow} noValidate>
                <h3 className="cap-h3">Add a cost item</h3>
                {rowError && <p className="ob-error" role="alert">{rowError}</p>}
                <div className="ob-grid ob-grid--tight">
                  <div className="ob-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="ci-label">Item</label><input id="ci-label" type="text" maxLength={120} value={row.label} placeholder="For example 200 GPU hours for the first fine-tune" disabled={readOnly} onChange={(e) => setRow({ ...row, label: e.target.value })} /></div>
                  <div className="ob-field"><label htmlFor="ci-category">Category</label><select id="ci-category" className="ds-select" value={row.category} disabled={readOnly} onChange={(e) => setRow({ ...row, category: e.target.value })}>{options.constants.categories.map((c) => <option key={c} value={c}>{CATEGORY[c]}</option>)}</select></div>
                  <div className="ob-field"><label htmlFor="ci-basis">Basis</label><select id="ci-basis" className="ds-select" value={row.basis} disabled={readOnly} onChange={(e) => setRow({ ...row, basis: e.target.value })}>{options.constants.bases.map((b) => <option key={b} value={b}>{BASIS[b][0]}</option>)}</select></div>
                  <div className="ob-field"><label htmlFor="ci-period">Period</label><select id="ci-period" className="ds-select" value={row.period} disabled={readOnly} onChange={(e) => setRow({ ...row, period: e.target.value })}>{options.constants.periods.map((p) => <option key={p} value={p}>{PERIOD[p]}</option>)}</select></div>
                  <AmountInput id="ci-amount" label="Amount (US dollars)" value={row.amount} disabled={readOnly} onChange={(amount) => setRow({ ...row, amount })} />
                  <div className="ob-field"><label htmlFor="ci-source">Source</label><input id="ci-source" type="text" maxLength={200} value={row.source} placeholder="For example vendor quote Q-77, or provider price page" disabled={readOnly} onChange={(e) => setRow({ ...row, source: e.target.value })} /></div>
                  <div className="ob-field"><label htmlFor="ci-observed">Observed on</label><input id="ci-observed" type="date" value={row.observedAt} disabled={readOnly} onChange={(e) => setRow({ ...row, observedAt: e.target.value })} /></div>
                  {row.basis === 'incurred' && (
                    <div className="ob-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="ci-evidence">Evidence record for this incurred cost</label><select id="ci-evidence" className="ds-select" value={row.evidenceId} disabled={readOnly} onChange={(e) => setRow({ ...row, evidenceId: e.target.value })}><option value="">Choose a record</option>{evidence.map((ev) => <option key={ev.id} value={ev.id}>{KIND[ev.kind]} · {ev.title}</option>)}</select></div>
                  )}
                </div>
                <div><button className="btn-ghost" type="submit" disabled={readOnly}>Add item</button></div>
              </form>
            )}
          </section>

          <section className="ob-card">
            <h2>Links</h2>
            <p className="ob-muted">What this plan is for, inside this workspace only.</p>
            <div className="ob-grid ob-grid--tight">
              <div className="ob-field"><label htmlFor="link-project">Project</label><select id="link-project" className="ds-select" value={links.projectId} disabled={readOnly} onChange={(e) => setLinks({ ...links, projectId: e.target.value })}><option value="">None</option>{options.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><FieldError id="link-project-error">{status.errors.projectId}</FieldError></div>
              <div className="ob-field"><label htmlFor="link-run">Enhance plan</label><select id="link-run" className="ds-select" value={links.enhanceRunId} disabled={readOnly} onChange={(e) => setLinks({ ...links, enhanceRunId: e.target.value })}><option value="">None</option>{options.runs.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.status}</option>)}</select><FieldError id="link-run-error">{status.errors.enhanceRunId}</FieldError></div>
            </div>
            <fieldset>
              <legend className="ob-legend">Frozen dataset versions</legend>
              {options.versions.length === 0 ? <p className="ob-muted">No approved dataset version yet.</p> : options.versions.map((v) => (
                <label key={`${v.projectId}:${v.version}`} className="ob-check"><input type="checkbox" checked={hasVersion(v)} disabled={readOnly} onChange={() => toggleVersion(v)} />{v.projectName} · v{v.version} · {plural(v.files, 'file')} · approved {date(v.createdAt)}</label>
              ))}
              <FieldError id="link-versions-error">{status.errors.datasetVersions}</FieldError>
            </fieldset>
          </section>
        </div>
        <aside className="ds-side">
          <section className="ob-card">
            <h2>Totals</h2>
            <Totals totals={totals} bases={options.constants.bases} periods={options.constants.periods} />
            <p className="ob-muted" style={{ fontSize: 12.5 }}>By basis and by period, never added together. Incurred costs cite an evidence record each. Nothing here is a reservation or a meter reading; those are planned.</p>
            {!locked && <button type="button" className="btn-app" disabled={status.pending || !dirty} onClick={savePlan}>{status.pending ? 'Saving…' : 'Save plan'}</button>}
          </section>
          <section className="ob-card">
            <h2>Credits on record</h2>
            {options.credits.length === 0 ? <p className="ob-muted">None recorded. Add them on the <Link to={`/w/${entry.slug}/capital`}>Capital</Link> page.</p> : (
              <ul className="ob-list">{options.credits.map((c) => <li key={c.id}><div><strong>{c.provider} · {formatUsd(c.amountCents)}</strong><span className="ob-muted">{CREDIT_STATUS[c.status]?.[0]}{c.expiresOn ? ` · expires ${c.expiresOn}` : ''}{c.restrictions ? ` · ${c.restrictions}` : ''}</span></div></li>)}</ul>
            )}
            <p className="ob-muted" style={{ fontSize: 12.5 }}>A claim is not a balance. Credits are shown for the review; they are never deducted from the plan.</p>
          </section>
        </aside>
      </div>
    </CaseShell>
  );
}

const blankReference = () => ({ id: newId(), kind: 'other', title: '', source: '' });

const formFrom = (d) => ({ purpose: d.purpose, amount: d.requestedAmountCents == null ? '' : (d.requestedAmountCents / 100).toFixed(2), neededBy: d.timing.neededBy ?? '', termMonths: d.timing.termMonths ?? '', company: { ...d.company, foundedYear: d.company.foundedYear ?? '', employees: d.company.employees ?? '' }, references: d.references });

export function CapitalRequest() {
  const data = useLoaderData();
  const { entry, role, case: kase, submissions, evidence, credits, marks, options, contentHash } = data;
  const { status, save, reload, locked } = useCaseSave(entry, kase);
  const revalidator = useRevalidator();
  const d = kase.draft;
  const [form, setForm] = useState(() => formFrom(d));
  // Consent is given on one content hash: the one this view was loaded with. If a reload brings another hash, even with
  // identical summaries, the consent no longer applies and the box reads unchecked until the owner ticks it again.
  const [consentHash, setConsentHash] = useState(null);
  const consent = consentValid({ consentHash, contentHash });
  const [notice, setNotice] = useState(null);
  const [send, setSend] = useState({ pending: false, error: null, errors: {} });
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setNotice(null); };
  const company = (patch) => set({ company: { ...form.company, ...patch } });
  const readOnly = locked || status.pending;
  const sender = SENDERS.includes(role);
  const latest = submissions.at(-1) ?? null;
  const currentCredits = credits.filter((c) => !c.supersededBy);
  const linkedProject = options.projects.find((p) => p.id === kase.projectId);
  const linkedRun = options.runs.find((r) => r.id === kase.enhanceRunId);
  const linkedVersions = d.datasetVersions.map((v) => options.versions.find((x) => x.projectId === v.projectId && x.version === v.version) ?? { projectName: 'Dataset', version: v.version, files: 0 });
  const intOrNull = (v) => (v === '' ? null : Number(v));
  function body() {
    const requestedAmountCents = form.amount.trim() === '' ? null : parseUsd(form.amount);
    if (form.amount.trim() !== '' && requestedAmountCents == null) return null;
    return { draft: { ...d, purpose: form.purpose, requestedAmountCents, timing: { neededBy: form.neededBy || null, termMonths: intOrNull(form.termMonths) }, company: { ...form.company, foundedYear: intOrNull(form.company.foundedYear), employees: intOrNull(form.company.employees) }, references: form.references.filter((r) => r.title.trim()) } };
  }
  // Saving stores the edits as a new revision and nothing more. The page then reloads the complete view (plan,
  // evidence, credit records and the hash of all of it) and consent starts over: a save is never a send.
  async function saveRequest() {
    const b = body();
    const saved = b ? await save(b) : await save({ draft: { ...d, requestedAmountCents: 'invalid' } });
    if (!saved) return;
    if (saved.case) setForm(formFrom(saved.case.draft));
    const next = afterSave();
    setConsentHash(next.consentHash);
    setNotice(next.notice);
  }
  const dirty = JSON.stringify(body()?.draft ?? null) !== JSON.stringify(d);
  // Nothing sends while the view is being refreshed: the hash on screen may be about to change.
  const step = consentStep({ status: kase.status, revision: kase.revision, submittedRevision: kase.submittedRevision, dirty, consent, pending: send.pending || status.pending || revalidator.state !== 'idle' });
  // Sending names the revision and the content hash of exactly what this page showed (draft, links, evidence and
  // credit records). If any of that changed since, the server refuses and the page reloads so the owner reviews it again.
  async function sendForReview() {
    if (step.action !== 'send') return;
    setSend({ pending: true, error: null, errors: {} });
    const res = await api.submitCapitalCase(entry.id, kase.id, sendBody({ revision: step.revision, contentHash })).catch(() => null);
    if (!res?.ok) { setSend({ pending: false, error: failed(res), errors: res?.data.errors ?? {} }); setConsentHash(null); revalidator.revalidate(); return; }
    setSend({ pending: false, error: null, errors: {} });
    setConsentHash(null);
    revalidator.revalidate();
  }
  async function withdraw() {
    setSend({ pending: true, error: null, errors: {} });
    const res = await api.withdrawCapitalCase(entry.id, kase.id).catch(() => null);
    setSend({ pending: false, error: res?.ok ? null : failed(res), errors: {} });
    revalidator.revalidate();
  }
  const errors = { ...status.errors, ...send.errors };
  return (
    <CaseShell data={data} view="request">
      <div className="ds-split">
        <div className="ds-main">
          <section className="ob-card">
            <h2>Financing request</h2>
            <SaveState status={status} reload={reload} />
            <div className="ob-field"><label htmlFor="rq-purpose">Purpose</label><textarea id="rq-purpose" rows={3} maxLength={2000} value={form.purpose} placeholder="What the money is for: compute, a deployment, equipment, growth" disabled={readOnly} aria-invalid={Boolean(errors.purpose)} onChange={(e) => set({ purpose: e.target.value })} /><FieldError id="rq-purpose-error">{errors.purpose}</FieldError></div>
            <div className="ob-grid ob-grid--tight">
              <AmountInput id="rq-amount" label="Requested amount (US dollars)" value={form.amount} disabled={readOnly} error={errors.requestedAmountCents} onChange={(amount) => set({ amount })} />
              <div className="ob-field"><label htmlFor="rq-needed">Needed by <span className="ob-optional">(optional)</span></label><input id="rq-needed" type="date" value={form.neededBy} disabled={readOnly} onChange={(e) => set({ neededBy: e.target.value })} /></div>
              <div className="ob-field"><label htmlFor="rq-term">Term in months <span className="ob-optional">(optional)</span></label><input id="rq-term" type="text" inputMode="numeric" value={form.termMonths} disabled={readOnly} onChange={(e) => set({ termMonths: e.target.value.replace(/[^0-9]/g, '') })} /><FieldError id="rq-term-error">{errors.timing}</FieldError></div>
            </div>
          </section>
          <section className="ob-card">
            <h2>Company</h2>
            <FieldError id="rq-company-error">{errors.company}</FieldError>
            <div className="ob-grid ob-grid--tight">
              <div className="ob-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="co-name">Legal name</label><input id="co-name" type="text" maxLength={160} value={form.company.legalName} disabled={readOnly} onChange={(e) => company({ legalName: e.target.value })} /></div>
              <div className="ob-field"><label htmlFor="co-reg">Registration reference</label><input id="co-reg" type="text" maxLength={80} value={form.company.registrationRef} disabled={readOnly} onChange={(e) => company({ registrationRef: e.target.value })} /></div>
              <div className="ob-field"><label htmlFor="co-country">Country</label><input id="co-country" type="text" maxLength={80} value={form.company.country} disabled={readOnly} onChange={(e) => company({ country: e.target.value })} /></div>
              <div className="ob-field"><label htmlFor="co-founded">Founded (year)</label><input id="co-founded" type="text" inputMode="numeric" value={form.company.foundedYear} disabled={readOnly} onChange={(e) => company({ foundedYear: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) })} /></div>
              <div className="ob-field"><label htmlFor="co-employees">Employees</label><input id="co-employees" type="text" inputMode="numeric" value={form.company.employees} disabled={readOnly} onChange={(e) => company({ employees: e.target.value.replace(/[^0-9]/g, '') })} /></div>
              <div className="ob-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="co-web">Website</label><input id="co-web" type="url" maxLength={200} value={form.company.website} disabled={readOnly} onChange={(e) => company({ website: e.target.value })} /></div>
              <div className="ob-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="co-desc">What the company does</label><textarea id="co-desc" rows={3} maxLength={1000} value={form.company.description} disabled={readOnly} onChange={(e) => company({ description: e.target.value })} /></div>
            </div>
          </section>
          <section className="ob-card">
            <h2>Supporting references</h2>
            <p className="ob-muted">Documents the company holds, named by reference. Uploading them privately is planned; they never go through the dataset upload path.</p>
            <FieldError id="rq-refs-error">{errors.references}</FieldError>
            {form.references.map((r, i) => (
              <div key={r.id} className="ob-grid ob-grid--tight cap-ref">
                <div className="ob-field"><label htmlFor={`ref-kind-${r.id}`}>Kind</label><select id={`ref-kind-${r.id}`} className="ds-select" value={r.kind} disabled={readOnly} onChange={(e) => set({ references: form.references.map((x) => (x.id === r.id ? { ...x, kind: e.target.value } : x)) })}>{options.constants.referenceKinds.map((k) => <option key={k} value={k}>{REF_KIND[k]}</option>)}</select></div>
                <div className="ob-field"><label htmlFor={`ref-title-${r.id}`}>Title</label><input id={`ref-title-${r.id}`} type="text" maxLength={120} value={r.title} disabled={readOnly} onChange={(e) => set({ references: form.references.map((x) => (x.id === r.id ? { ...x, title: e.target.value } : x)) })} /></div>
                <div className="ob-field"><label htmlFor={`ref-source-${r.id}`}>Where it is</label><input id={`ref-source-${r.id}`} type="text" maxLength={300} value={r.source} placeholder="Registry record, statement number, folder" disabled={readOnly} onChange={(e) => set({ references: form.references.map((x) => (x.id === r.id ? { ...x, source: e.target.value } : x)) })} /></div>
                {!readOnly && <div className="ob-field"><span aria-hidden="true" style={{ fontSize: 14, fontWeight: 600, visibility: 'hidden' }}>Remove</span><button type="button" className="btn-ghost" onClick={() => set({ references: form.references.filter((x) => x.id !== r.id) })} aria-label={`Remove reference ${i + 1}`}>Remove</button></div>}
              </div>
            ))}
            {!readOnly && form.references.length < 20 && <div><button type="button" className="btn-ghost" onClick={() => set({ references: [...form.references, blankReference()] })}>Add a reference</button></div>}
          </section>
          {!locked && (
            <section className="ob-card" aria-labelledby="send-view">
              <h2 id="send-view">What you will send</h2>
              <p className="ob-muted">Every record below goes into the frozen revision exactly as shown here, with the request and company details above. Read them before you confirm.</p>
              <details open>
                <summary>Plan · {plural(d.costItems.length, 'cost item')} · {totalsLine(totalsByBasis(d.costItems))}</summary>
                <div className="cap-review">
                  <CostTable items={d.costItems} evidence={evidence} />
                  <dl className="ds-dl">
                    <dt>Project</dt><dd>{linkedProject?.name ?? 'None'}</dd>
                    <dt>Enhance plan</dt><dd>{linkedRun ? `${linkedRun.name} · ${linkedRun.status}` : 'None'}</dd>
                    <dt>Dataset versions</dt><dd>{linkedVersions.length === 0 ? 'None' : linkedVersions.map((v) => `${v.projectName} v${v.version} (${plural(v.files, 'file')})`).join(' · ')}</dd>
                  </dl>
                </div>
              </details>
              <details open>
                <summary>Evidence · {plural(evidence.length, 'record')}</summary>
                <div className="cap-review"><EvidenceList evidence={evidence} reviewed={(e) => reviewedIn(marks, submissions)(e.id)} /></div>
              </details>
              <details open>
                <summary>Credit records · {plural(currentCredits.length, 'current record')}</summary>
                <div className="cap-review"><CreditTable credits={currentCredits} /><p className="ob-muted" style={{ fontSize: 12.5 }}>Claims as recorded. Not a balance, never deducted from the plan.</p></div>
              </details>
            </section>
          )}
        </div>
        <aside className="ds-side">
          <section className="ob-card">
            <h2>Where it stands</h2>
            <Stages status={kase.status} lenderStages={options.constants.lenderStages} />
            {latest?.notes && <div className="ob-note tile--amber"><span><strong>{DECISION[latest.decision] ?? latest.decision} on revision {latest.revision}:</strong> {latest.notes}</span></div>}
            {!locked && <button type="button" className="btn-ghost" disabled={status.pending || !dirty} onClick={saveRequest}>{status.pending ? 'Saving…' : 'Save request'}</button>}
          </section>
          <section className="ob-card ob-card--strong">
            <h2>{locked ? 'With Valcairn review' : 'Send to Valcairn review'}</h2>
            {send.error && <p className="ob-alert" role="alert">{send.error}</p>}
            {notice === 'saved' && !dirty && <p className="ob-alert ob-alert--info" role="status">Saved as revision {kase.revision}. Review the updated plan, evidence and credit records below, then confirm and send.</p>}
            {locked ? (
              <>
                <p className="ob-muted">Revision {kase.submittedRevision} was sent {date(latest?.submittedAt)}. Staff can request changes or mark the evidence reviewed. That is an internal check, not a credit decision.</p>
                {sender ? <button type="button" className="btn-ghost" disabled={send.pending} onClick={withdraw}>{send.pending ? 'Withdrawing…' : 'Withdraw from review'}</button> : <p className="ob-muted">An owner or admin can withdraw it.</p>}
              </>
            ) : step.action === 'save' ? (
              <>
                <p className="ob-muted">You have unsaved changes. Save them as revision {step.nextRevision} first; the page then shows the updated plan, evidence and credit records for you to review before sending.</p>
                <button type="button" className="btn-app" disabled={status.pending} onClick={saveRequest}>{status.pending ? 'Saving…' : `Save changes as revision ${step.nextRevision}`}</button>
              </>
            ) : step.reason === 'already_sent' ? (
              <p className="ob-muted">Revision {kase.revision} was {DECISION[latest?.decision]?.toLowerCase() ?? 'reviewed'}. Change something above to make a new revision before sending again.</p>
            ) : sender ? (
              <>
                <p className="ob-muted">Sends exactly revision {kase.revision} to Valcairn staff: the request and company details, and the plan, evidence and credit records listed under “What you will send”. Nothing goes to a bank, lender or provider. Corrections afterwards make a new revision.</p>
                <label className="ob-check"><input type="checkbox" checked={consent} disabled={send.pending} onChange={(e) => setConsentHash(e.target.checked ? contentHash : null)} />I have read this request, its plan, evidence and credit records as listed on this page, and choose to send them to Valcairn’s internal review.</label>
                <button type="button" className="btn-app" disabled={step.action !== 'send'} onClick={sendForReview}>{send.pending ? 'Sending…' : `Send revision ${kase.revision} to review`}</button>
              </>
            ) : <p className="ob-muted">An owner or admin sends the request to Valcairn’s internal review.</p>}
          </section>
          {submissions.length > 0 && (
            <section className="ob-card">
              <h2>Sent revisions</h2>
              <ul className="ob-list">
                {[...submissions].reverse().map((s) => <li key={s.id}><div><strong>Revision {s.revision}</strong><span className="ob-muted">Sent {date(s.submittedAt)}{s.decision ? ` · ${DECISION[s.decision] ?? s.decision} ${date(s.decidedAt)}` : ' · with review'}</span></div></li>)}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </CaseShell>
  );
}

function referenceSummary(e) {
  const r = e.reference ?? {};
  if (e.kind === 'dataset_provenance') return `${r.projectName ?? 'Project'} v${r.version} · ${plural(r.files ?? 0, 'file')}${r.reviewId ? ' · approved by Valcairn review' : ''}`;
  if (e.kind === 'model_provenance') return `${r.name ?? 'Enhance plan'} · base ${r.baseModelId} · ${r.status}`;
  if (e.kind === 'local_benchmark') return `${r.modelRef} on ${r.deviceLabel ?? 'a device'}${r.metrics?.tokensPerSec ? ` · ${r.metrics.tokensPerSec} tokens/s` : ''} · reported by the browser`;
  if (e.kind === 'credit_restriction') return `${r.provider} · ${CREDIT_STATUS[r.status]?.[0] ?? r.status}${r.restrictions ? ` · ${r.restrictions}` : ''}`;
  return e.source || '—';
}

/**
 * `reviewed(e)` lists the sent revisions on which Valcairn staff marked the record; the record itself is never changed by
 * that. Each record keeps its readable summary and opens to its entire stored reference payload ("Reference facts"),
 * the same on the Evidence view, the Request consent view and the staff page.
 */
function EvidenceList({ evidence, reviewed = () => [], onRemove, onReview, busy }) {
  if (evidence.length === 0) return <p className="ob-muted">No evidence records yet.</p>;
  return (
    <ul className="ob-list cap-evidence">
      {evidence.map((e) => {
        const marks = reviewed(e);
        return (
          <li key={e.id}>
            <Tile icon={e.kind === 'local_benchmark' ? 'play' : e.kind === 'credit_restriction' ? 'bank' : e.kind.endsWith('provenance') ? 'data' : 'tag'} tone={marks.length ? 'green' : e.verification === 'client_reported' ? 'amber' : 'plain'} size="sm" />
            <div>
              <strong>{e.title}</strong>
              <span className="ob-muted">{KIND[e.kind]} · {referenceSummary(e)}{e.source && e.kind !== 'cost_assumption' && e.kind !== 'company_record' ? ` · ${e.source}` : ''}</span>
              <details className="cap-facts-details"><summary>Reference facts</summary><ReferenceFacts reference={e.reference} /></details>
            </div>
            <span className="cap-evidence-badges">
              <Badge map={VERIFICATION} value={e.verification} />
              {marks.length > 0 && <span className="ob-badge tile--green">Reviewed by Valcairn{marks.length === 1 && typeof marks[0] === 'number' ? ` · revision ${marks[0]}` : ''}</span>}
            </span>
            {onRemove && <button type="button" className="btn-small" disabled={busy} onClick={() => onRemove(e)} aria-label={`Remove ${e.title}`}>Remove</button>}
            {onReview && marks.length === 0 && <button type="button" className="btn-small" disabled={busy} onClick={() => onReview(e)}>Mark reviewed</button>}
          </li>
        );
      })}
    </ul>
  );
}

export function CapitalEvidence() {
  const data = useLoaderData();
  const { entry, case: kase, evidence, submissions, marks, options } = data;
  const revalidator = useRevalidator();
  const locked = kase.status === 'submitted';
  const [form, setForm] = useState({ kind: 'company_record', title: '', source: '', reference: '' });
  const [state, setState] = useState({ pending: false, error: null, errors: {} });
  const pickers = {
    dataset_provenance: ['Frozen dataset version', options.versions.map((v) => [JSON.stringify({ projectId: v.projectId, version: v.version }), `${v.projectName} · v${v.version} · ${plural(v.files, 'file')}`])],
    model_provenance: ['Enhance plan', options.runs.map((r) => [JSON.stringify({ enhanceRunId: r.id }), `${r.name} · ${r.status}`])],
    local_benchmark: ['A run measured on one of your devices', options.benchmarks.map((b) => [JSON.stringify({ deviceId: b.deviceId, runId: b.runId }), `${b.deviceLabel} · ${b.modelRef} · ${b.kind} · ${b.status}${b.metrics?.tokensPerSec ? ` · ${b.metrics.tokensPerSec} tokens/s` : ''} · ${date(b.createdAt)}`])],
    credit_restriction: ['Credit record', options.credits.map((c) => [JSON.stringify({ creditRecordId: c.id }), `${c.provider} · ${formatUsd(c.amountCents)} · ${CREDIT_STATUS[c.status]?.[0]}`])],
  };
  const picker = pickers[form.kind];
  async function add(e) {
    e.preventDefault();
    setState({ pending: true, error: null, errors: {} });
    let reference = {};
    if (picker) {
      if (!form.reference) return setState({ pending: false, error: null, errors: { reference: `Choose a ${picker[0].toLowerCase()}.` } });
      reference = JSON.parse(form.reference);
    }
    const res = await api.addCapitalEvidence(entry.id, kase.id, { kind: form.kind, title: form.title, source: form.source, reference }).catch(() => null);
    if (!res?.ok) return setState({ pending: false, error: failed(res), errors: res?.data.errors ?? {} });
    setForm({ kind: form.kind, title: '', source: '', reference: '' });
    setState({ pending: false, error: null, errors: {} });
    revalidator.revalidate();
  }
  async function remove(item) {
    setState({ pending: true, error: null, errors: {} });
    const res = await api.deleteCapitalEvidence(entry.id, kase.id, item.id).catch(() => null);
    setState({ pending: false, error: res?.ok ? null : failed(res), errors: {} });
    revalidator.revalidate();
  }
  return (
    <CaseShell data={data} view="evidence">
      <div className="ds-split">
        <div className="ds-main">
          <section className="ob-card">
            <h2>Evidence records</h2>
            <p className="ob-muted">Each record points at something that already exists and keeps its verification status. Reviewed means Valcairn staff looked at it on a revision you sent; it is not verified revenue, a credit decision or lender eligibility.</p>
            {state.error && <p className="ob-alert" role="alert">{state.error}</p>}
            <EvidenceList evidence={evidence} reviewed={(e) => reviewedIn(marks, submissions)(e.id)} onRemove={locked ? null : remove} busy={state.pending} />
            {!locked && (
              <form className="cap-form" onSubmit={add} noValidate>
                <h3 className="cap-h3">Add a record</h3>
                <div className="ob-grid ob-grid--tight">
                  <div className="ob-field"><label htmlFor="ev-kind">What it is</label><select id="ev-kind" className="ds-select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, reference: '' })}>{options.constants.evidenceKinds.map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select></div>
                  <div className="ob-field"><label htmlFor="ev-title">Title</label><input id="ev-title" type="text" maxLength={120} value={form.title} aria-invalid={Boolean(state.errors.title)} onChange={(e) => setForm({ ...form, title: e.target.value })} /><FieldError id="ev-title-error">{state.errors.title}</FieldError></div>
                  {picker ? (
                    <div className="ob-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="ev-ref">{picker[0]}</label><select id="ev-ref" className="ds-select" value={form.reference} aria-invalid={Boolean(state.errors.reference)} onChange={(e) => setForm({ ...form, reference: e.target.value })}><option value="">{picker[1].length ? 'Choose' : 'Nothing to cite yet'}</option>{picker[1].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><FieldError id="ev-ref-error">{state.errors.reference}</FieldError></div>
                  ) : (
                    <div className="ob-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="ev-source">Where the record lives</label><input id="ev-source" type="text" maxLength={300} value={form.source} placeholder="Document name, reference number or folder. Uploading it here is planned." aria-invalid={Boolean(state.errors.source)} onChange={(e) => setForm({ ...form, source: e.target.value })} /><FieldError id="ev-source-error">{state.errors.source}</FieldError></div>
                  )}
                </div>
                <div className="ob-row-actions"><button className="btn-app" type="submit" disabled={state.pending}>{state.pending ? 'Adding…' : 'Add record'}</button><span className="ob-badge">Document upload: Planned</span></div>
              </form>
            )}
          </section>
        </div>
        <aside className="ds-side">
          <section className="ob-card">
            <h2>Evidence package</h2>
            <p className="ob-muted">A JSON file with {kase.submittedRevision != null ? `sent revision ${kase.submittedRevision} exactly as it was frozen, with Valcairn’s review marks kept apart` : 'the current draft, labelled as a draft'}: totals by basis and period, credit records, evidence with its verification status, and what the package is not. Each export is recorded in the workspace audit log. Valcairn does not send it anywhere.</p>
            <a className="btn-app" href={api.capitalExportUrl(entry.id, kase.id)} download><Icon name="download" size={16} stroke={2} />Export package (JSON)</a>
          </section>
          <section className="ob-card">
            <h2>Kinds of evidence</h2>
            <ul className="ob-list">
              {[['Dataset and model provenance', 'Frozen versions and enhance plans of this workspace.'], ['Local benchmark', 'Runs measured by your own browser on your own device. Client-reported, never measured by Valcairn.'], ['Credit restriction', 'The terms of a credit record on file.'], ['Cost assumption, company record', 'Named by reference until private upload exists.']].map(([label, note]) => <li key={label}><div><strong>{label}</strong><span className="ob-muted">{note}</span></div></li>)}
            </ul>
          </section>
        </aside>
      </div>
    </CaseShell>
  );
}

/* ---------------- Staff: capital review queue ---------------- */

async function requireStaff() {
  const account = await requireVerified();
  if (!account.isStaff) throw redirect('/start');
  return account;
}
export async function staffCapitalLoader({ request }) {
  const account = await requireStaff();
  const status = new URL(request.url).searchParams.get('status') ?? 'submitted';
  return { status, staffScope: account.staffScope, staffWorkspace: account.staffWorkspace, ...(await api.staffCapital(status)) };
}
export async function staffCapitalCaseLoader({ params }) {
  await requireStaff();
  return api.staffCapitalCase(params.caseId);
}

export function StaffCapitalQueue() {
  const { status, cases, staffScope, staffWorkspace } = useLoaderData();
  const [, setParams] = useSearchParams();
  return (
    <SetupShell tone="green" context="Capital review" status={null} exit={{ to: '/staff', label: 'Review queue' }}>
      <title>Capital review — Valcairn</title>
      <main className="ob-main ob-main--narrow" style={{ maxWidth: 960 }}>
        <div className="ob-intro">
          <span className="ob-eyebrow">{staffScope === 'demo_workspace' ? `Demo review · ${staffWorkspace?.name ?? 'synthetic workspace'} only` : 'Valcairn staff'}</span>
          <h1 className="ob-h1">Capital review</h1>
          <p className="ob-lede">Financing requests customers chose to send. You check the planning evidence and either request changes or mark it reviewed. This is not a credit decision, and no lender or provider is involved.</p>
        </div>
        <div className="ob-segment" role="group" aria-label="Status">
          {[['submitted', 'Waiting'], ['changes_requested', 'Changes requested'], ['evidence_reviewed', 'Evidence reviewed']].map(([id, label]) => <button key={id} type="button" aria-pressed={status === id} onClick={() => setParams({ status: id })}>{label}</button>)}
        </div>
        {cases.length === 0 ? <p className="ob-muted">Nothing here.</p> : (
          <ul className="ob-list ob-card">
            {cases.map((c) => (
              <li key={c.id}>
                <Tile icon="bank" tone="amber" size="sm" />
                <div><strong>{c.title}</strong><span className="ob-muted">{c.workspaceName} · revision {c.submittedRevision} · requested {formatUsd(c.requestedAmountCents)} · sent {date(c.latestSubmission?.submittedAt)}</span></div>
                <Link className="btn-ghost" to={`/staff/capital/${c.id}`}>{status === 'submitted' ? 'Review' : 'Open'}</Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </SetupShell>
  );
}

export function StaffCapitalCase() {
  const { case: kase, workspace, submission, marks, conflict, constants } = useLoaderData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState(false);
  const open = kase.status === 'submitted' && !conflict;
  // Everything shown is the frozen snapshot of the submission being reviewed; every action names that submission.
  const snap = submission.snapshot;
  const { costItems, datasetVersions, ...request } = snap.draft;
  const stale = (res) => (res?.data.code === 'stale_submission' ? <>{res.data.error} <button type="button" className="btn-text" onClick={() => revalidator.revalidate()}>Reload</button></> : failed(res));
  async function decide(decision, form) {
    setPending(true);
    const res = await api.staffCapitalDecide(kase.id, { decision, notes: form.get('notes'), submissionId: submission.id }).catch(() => null);
    setPending(false);
    if (res?.ok) return navigate('/staff/capital');
    setMessage(stale(res));
  }
  async function review(item) {
    setPending(true);
    const res = await api.staffCapitalReviewEvidence(kase.id, item.id, submission.id).catch(() => null);
    setPending(false);
    if (!res?.ok) return setMessage(stale(res));
    revalidator.revalidate();
  }
  return (
    <SetupShell tone="green" context="Capital review" status={null} exit={{ to: '/staff/capital', label: 'Back to queue' }}>
      <title>{`Capital: ${snap.title} — Valcairn`}</title>
      <form className="ob-main" onSubmit={(e) => { e.preventDefault(); decide(e.nativeEvent.submitter?.value, new FormData(e.currentTarget)); }}>
        <section className="ob-col">
          <div className="ob-intro">
            <span className="ob-eyebrow">{workspace.name}{workspace.synthetic ? ' · synthetic demo' : ''}</span>
            <h1 className="ob-h1">{snap.title}</h1>
            <p className="ob-lede">Revision {submission.revision}, sent {date(submission.submittedAt)}. Everything below is the frozen snapshot the customer sent. Anything they changed or added since stays private until they send again.</p>
            <div className="ob-chips" style={{ gap: 6 }}><Badge map={STATUS} value={kase.status} />{conflict && <span className="ob-badge tile--amber">You belong to this workspace: read only</span>}</div>
          </div>
          <section className="ob-card">
            <h2>Request</h2>
            <dl className="ds-dl">
              <dt>Purpose</dt><dd>{request.purpose}</dd>
              <dt>Amount</dt><dd>{formatUsd(request.requestedAmountCents)}</dd>
              <dt>Timing</dt><dd>{request.timing.neededBy ? `needed by ${request.timing.neededBy}` : 'no date'}{request.timing.termMonths ? ` · ${plural(request.timing.termMonths, 'month')}` : ''}</dd>
              <dt>Company</dt><dd>{request.company.legalName}{request.company.registrationRef ? ` · ${request.company.registrationRef}` : ''}{request.company.country ? ` · ${request.company.country}` : ''}{request.company.foundedYear ? ` · founded ${request.company.foundedYear}` : ''}{request.company.employees != null ? ` · ${plural(request.company.employees, 'employee')}` : ''}</dd>
              {request.company.website && <><dt>Website</dt><dd>{request.company.website}</dd></>}
              {request.company.description && <><dt>About</dt><dd>{request.company.description}</dd></>}
              <dt>References</dt><dd>{request.references.length === 0 ? 'None' : request.references.map((r) => `${REF_KIND[r.kind] ?? r.kind}: ${r.title}${r.source ? ` (${r.source})` : ''}`).join(' · ')}</dd>
              <dt>Links</dt><dd>{[snap.projectId && 'a project', snap.enhanceRunId && 'an enhance plan', datasetVersions.length && plural(datasetVersions.length, 'dataset version')].filter(Boolean).join(', ') || 'None'}</dd>
            </dl>
          </section>
          <section className="ob-card">
            <h2>Cost plan · {plural(costItems.length, 'item')}</h2>
            <Totals totals={snap.totals} bases={constants.bases} periods={constants.periods} />
            <CostTable items={costItems} evidence={snap.evidence} />
          </section>
          <section className="ob-card">
            <h2>Credit records at the time of sending · {snap.credits.length}</h2>
            <CreditTable credits={snap.credits} />
            <p className="ob-muted">Claims by the customer, as frozen when they sent this revision. Not a balance, not spendable through Valcairn.</p>
          </section>
          <section className="ob-card">
            <h2>Evidence · {snap.evidence.length}</h2>
            {message && <p className="ob-alert" role="alert">{message}</p>}
            <EvidenceList evidence={snap.evidence} reviewed={(e) => marks.filter((m) => m.evidenceId === e.id).map(() => submission.revision)} onReview={open ? review : null} busy={pending} />
          </section>
        </section>
        <aside className="ob-aside">
          <section className="ob-card ob-card--strong">
            <h2>{kase.status === 'submitted' ? 'Your decision' : `Decided: ${DECISION[submission.decision] ?? submission.decision}`}</h2>
            <p className="ob-muted">Request changes, or confirm you looked at the evidence. Neither is a loan, an offer, an approval or funding; those stages are planned and have no action here.</p>
            <div className="ob-field">
              <label htmlFor="notes">Notes for the customer</label>
              <textarea id="notes" name="notes" rows={4} maxLength={4000} defaultValue={submission.notes ?? ''} disabled={!open} placeholder="Required when requesting changes" />
            </div>
            {open && (
              <div className="ob-actions">
                <button className="btn-ghost" type="submit" value="changes_requested" disabled={pending}>Request changes</button>
                <button className="btn-app" type="submit" value="evidence_reviewed" disabled={pending}>Mark evidence reviewed</button>
              </div>
            )}
            {conflict && kase.status === 'submitted' && <p className="ob-muted">Another reviewer must decide this one.</p>}
            <Stages status={kase.status} lenderStages={constants.lenderStages} />
          </section>
        </aside>
      </form>
    </SetupShell>
  );
}
