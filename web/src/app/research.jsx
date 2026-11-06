import { useEffect, useRef, useState } from 'react';
import { Link, useLoaderData, useLocation, useNavigate, useRevalidator } from 'react-router';
import { api } from '../api.js';
import { requireWorkspace } from './ui.jsx';
import { WorkspaceShell } from './shell.jsx';

const CHECKLIST = [
  ['claimsEvidenced', 'Material claims have evidence'],
  ['sourcesRecorded', 'Sources are accessible, or a limitation is recorded'],
  ['datesShown', 'Dates and uncertainty are visible'],
  ['duplicatesReviewed', 'Duplicate candidates were reviewed'],
  ['interpretationLabeled', 'Interpretation is labeled as interpretation'],
  ['questionAnswered', 'The report answers the question'],
];
const CLAIM_LABEL = {
  retrieved: 'Source retrieved',
  extracted: 'Claim extracted',
  supported: 'Supported by the recorded excerpt',
  corroborated: 'Independently corroborated',
  reviewed: 'Human reviewed',
  inferred: 'Inferred',
  conflicting: 'Conflicting',
  unknown: 'Unknown',
};
const EMPTY = {
  founders: 'No founder records yet. Add one only with a public source and an excerpt you can point at.',
  partners: 'No partner or investor records. This system has a company catalog and no sourced investor directory, so this list stays empty until a public source is retrieved or you add a record with an excerpt. A partner here is an evidenced professional role.',
  companies: 'No companies yet. Import the existing Frontier AI labs catalog, or add a record from a public page.',
  tools: 'No tools or products yet. Nothing is added here unless a source supports it.',
  repositories: 'No repositories yet. Nothing is added here unless a source supports it.',
  prospects: 'No prospects. Prospects are records you curate yourself. A catalog import cannot fill this list, and nothing here is a qualified lead.',
};
const KINDS = {
  founders: ['person'],
  partners: ['person', 'organization'],
  companies: ['organization'],
  tools: ['tool'],
  repositories: ['repository'],
  prospects: ['person', 'organization'],
};

const message = (res, fallback) => res.data?.error || fallback;

export async function researchHomeLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const data = await api.researchProjects(entry.id);
  return { account, entry, ...data };
}

export function ResearchHome() {
  const { account, entry, projects, canWrite, catalog } = useLoaderData();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  async function create(template) {
    setPending(template);
    setError('');
    try {
      const res = await api.createResearchProject(entry.id, { template });
      if (!res.ok) { setError(message(res, 'The project was not created.')); return; }
      navigate(`/w/${entry.slug}/research/${res.data.project.id}`);
    } catch {
      setError('The connection failed. Reload to check whether the project was created before trying again.');
    } finally { setPending(''); }
  }
  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title="Research" current="research">
      <div className="ob-intro">
        <span className="ob-eyebrow">Research · {entry.name}</span>
        <h1 className="ob-h1">Research</h1>
        <p className="ob-lede">Public-source directories and cited runs for this workspace. Dataset review stays on its own projects. A catalog row is a field extracted from a file this system already had. It is not a page this run fetched.</p>
      </div>
      {error && <p className="ob-alert" role="alert">{error}</p>}
      <section className="ob-card" aria-labelledby="research-catalog-h">
        <h2 id="research-catalog-h">Existing records</h2>
        <p className="ob-muted">{catalog?.available ? `${catalog.count} companies are in the Frontier AI labs catalog and can be imported into a collection project.` : 'The Frontier AI labs catalog is not on this server.'} {catalog?.investorGap}</p>
      </section>
      {canWrite && (
        <section className="ob-card" aria-labelledby="research-new-h">
          <h2 id="research-new-h">New project</h2>
          <div className="ob-actions">
            {[['collection', 'Data collection and directories'], ['landscape', 'Landscape and public-source research'], ['diligence', 'Diligence and research QA']].map(([id, label]) => (
              <button key={id} type="button" className="btn-app" disabled={pending !== ''} onClick={() => create(id)}>{pending === id ? 'Creating…' : label}</button>
            ))}
          </div>
        </section>
      )}
      <section className="ob-card" aria-labelledby="research-projects-h">
        <h2 id="research-projects-h">Projects</h2>
        {projects.length === 0 ? <p className="ob-muted">No research projects yet.</p> : (
          <ul className="ob-list">
            {projects.map((project) => (
              <li key={project.id}><Link to={`/w/${entry.slug}/research/${project.id}`}>{project.name}</Link> <span className="ob-muted">{project.template}</span></li>
            ))}
          </ul>
        )}
      </section>
    </WorkspaceShell>
  );
}

export async function researchProjectLoader({ params, request }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const url = new URL(request.url);
  const listId = url.searchParams.get('listId') || null;
  const directory = listId ? null : (url.searchParams.get('directory') || 'companies');
  const q = url.searchParams.get('q') || '';
  const sort = url.searchParams.get('sort') || 'name';
  const page = url.searchParams.get('page') || '1';
  const [detail, listing, quality] = await Promise.all([
    api.researchProject(entry.id, params.projectId),
    api.researchDirectory(entry.id, params.projectId, { directory, listId, q, page, sort }),
    api.researchQuality(entry.id, params.projectId),
  ]);
  return { account, entry, directory, listId, q, sort, page: Number(page) || 1, detail, listing, quality };
}

export function ResearchProject() {
  const { account, entry, directory, listId, q, sort, page, detail, listing, quality } = useLoaderData();
  const { project, lists, runs, canWrite, directories } = detail;
  const selectedList = listId ? lists.find((list) => list.id === listId) : null;
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
  const view = JSON.stringify([entry.id, project.id, listId, location.pathname, location.search, location.key]);
  const currentView = useRef(view);
  currentView.current = view;
  useEffect(() => {
    currentView.current = view;
    return () => { currentView.current = null; };
  }, [view]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const base = `/w/${entry.slug}/research/${project.id}`;
  const pages = Math.max(1, Math.ceil((listing.total || 0) / (listing.pageSize || 20)));
  const query = (next) => {
    const params = new URLSearchParams({ ...(listId ? { listId } : { directory }), q, sort, page: String(page), ...next });
    navigate(`${base}?${params.toString()}`);
  };
  async function run(action, fallback) {
    setPending(true); setError(''); setNotice('');
    try {
      const res = await action();
      if (!res.ok) { setError(message(res, fallback)); return null; }
      revalidator.revalidate();
      if (res.data?.summary?.failed) { setError(summaryText(res.data.summary, false)); return null; }
      return res;
    } catch {
      setError(`${fallback} The connection failed; your input is kept. Refresh before retrying.`);
      return null;
    } finally { setPending(false); }
  }
  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title={project.name} current="research">
      <div className="ob-intro">
        <span className="ob-eyebrow"><Link to={`/w/${entry.slug}/research`}>Research</Link> · {project.template}</span>
        <h1 className="ob-h1">{project.name}</h1>
        <p className="ob-lede">{project.question}</p>
      </div>
      {error && <p className="ob-alert" role="alert">{error}</p>}
      {notice && <p className="ob-alert ob-alert--ok" role="status">{notice}</p>}
      <section className="ob-card" aria-labelledby="research-brief-h">
        <h2 id="research-brief-h">Brief</h2>
        <p>{project.brief}</p>
        {canWrite && <BriefForm key={project.id} project={project} disabled={pending} onSave={(body) => run(() => api.updateResearchProject(entry.id, project.id, body), 'The brief was not saved.')} />}
      </section>
      <nav aria-label="Directories" className="ob-chips">
        {directories.map((item) => (
          <Link key={item.id} to={`${base}?directory=${item.id}&page=1&sort=${sort}&q=${encodeURIComponent(q)}`} aria-current={item.id === directory ? 'page' : undefined}>{item.label} ({item.count})</Link>
        ))}
      </nav>
      <section className="ob-card" aria-labelledby="research-dir-h">
        <div className="row-between">
          <h2 id="research-dir-h">{selectedList ? `List: ${selectedList.name}` : directories.find((item) => item.id === directory)?.label}</h2>
          <a href={api.researchExportUrl(entry.id, project.id, { directory, listId })}>{listId ? 'Export list CSV' : 'Export CSV'}</a>
        </div>
        {selectedList && <p className="ob-muted">{selectedList.purpose || 'A curated shortlist.'} Removing a member affects this list only; its record and source evidence stay in the project.</p>}
        {selectedList && <p className="ob-muted">The list CSV exports claims and their directory/source evidence; several rows may describe one member.</p>}
        {directory === 'partners' && <p className="ob-muted">A partner here is an evidenced professional role. This workspace has no sourced investor catalog to import.</p>}
        {directory === 'companies' && <p className="ob-muted">Imported catalog fields stay “claim extracted”. A later fetch creates separate source evidence and does not verify or rewrite the original catalog claims.</p>}
        <form className="ob-field" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); query({ q: String(data.get('q') || ''), page: 1 }); }}>
          <label htmlFor="research-q">Search names</label>
          <input type="text" id="research-q" name="q" defaultValue={q} />
          <button type="submit" className="btn-ghost">Search</button>
        </form>
        <label className="ob-field" htmlFor="research-sort">Sort
          <select id="research-sort" value={sort} onChange={(event) => query({ sort: event.target.value, page: 1 })}>
            <option value="name">Name</option>
            <option value="updated">Recently updated</option>
          </select>
        </label>
        {listing.total === 0 ? <p className="ob-muted">{listId ? (q ? 'No list members match this search.' : `This list has no members. ${canWrite ? 'Open a directory record and add it to this list.' : 'A workspace writer can add records to this list.'}`) : EMPTY[directory]}</p> : (
          <ul className="ob-list">
            {listing.rows.map((row) => (
              <li key={row.entity.id}>
                <Link to={`${base}/entities/${row.entity.id}`}>{row.entity.name}</Link>
                <span className="ob-muted"> {row.entity.kind} · {row.claimCount} claims{row.conflicting ? ` · ${row.conflicting} conflicting` : ''}</span>
                {listId && canWrite && <button type="button" className="btn-ghost" disabled={pending} onClick={async () => {
                  const removalView = currentView.current;
                  const result = await run(() => api.removeResearchListItem(entry.id, listId, row.entity.id), 'The list member was not removed.');
                  if (result && removalView !== null && currentView.current === removalView) {
                    setNotice('Removed from this list. The record and evidence remain; use Add on its record to restore membership.');
                    if (listing.rows.length === 1 && page > 1) query({ page: page - 1 });
                  }
                }} aria-label={`Remove ${row.entity.name} from ${selectedList?.name || 'this list'}`}>Remove from list</button>}
              </li>
            ))}
          </ul>
        )}
        <div className="row-between">
          <button type="button" className="btn-ghost" disabled={page <= 1} onClick={() => query({ page: page - 1 })}>Previous</button>
          <span className="ob-muted">Page {page} of {pages}</span>
          <button type="button" className="btn-ghost" disabled={page >= pages} onClick={() => query({ page: page + 1 })}>Next</button>
        </div>
        {canWrite && directory === 'companies' && (
          <div className="ob-list">
            <button type="button" className="btn-ghost" disabled={pending} onClick={async () => {
              const res = await run(() => api.importResearch(entry.id, project.id, { catalog: 'frontier-ai-labs', dryRun: true }), 'The preview failed.');
              if (res) setNotice(summaryText(res.data.summary, true));
            }}>Preview catalog import</button>
            <button type="button" className="btn-app" disabled={pending} onClick={async () => {
              const res = await run(() => api.importResearch(entry.id, project.id, { catalog: 'frontier-ai-labs', dryRun: false }), 'The import failed.');
              if (res) setNotice(summaryText(res.data.summary, false));
            }}>Import Frontier AI labs catalog</button>
          </div>
        )}
        {canWrite && !listId && <AddRecord key={project.id} directory={directory} disabled={pending} onAdd={async (record) => {
          const res = await run(() => api.importResearch(entry.id, project.id, { records: [record], dryRun: false }), 'The record was not added.');
          if (res) setNotice(summaryText(res.data.summary, false));
          return res;
        }} />}
      </section>
      <QualityCard key={project.id} quality={quality} canWrite={canWrite} disabled={pending} onSave={(checklist) => run(() => api.saveResearchChecklist(entry.id, project.id, checklist), 'The checklist was not saved.')} />
      <section className="ob-card" aria-labelledby="research-runs-h">
        <h2 id="research-runs-h">Runs</h2>
        {canWrite && <RunForm disabled={pending} directory={directory || 'companies'} onCreate={async (body) => {
          const res = await run(() => api.createResearchRun(entry.id, project.id, body), 'The run was not proposed.');
          if (res) navigate(`${base}/runs/${res.data.run.id}`);
        }} />}
        {runs.length === 0 ? <p className="ob-muted">No runs yet. A proposed run fetches nothing until you start it.</p> : (
          <ul className="ob-list">
            {runs.map((run) => <li key={run.id}><Link to={`${base}/runs/${run.id}`}>{run.question}</Link> <span className="ob-muted">{run.status}</span></li>)}
          </ul>
        )}
      </section>
      <section className="ob-card" aria-labelledby="research-lists-h">
        <h2 id="research-lists-h">Lists</h2>
        <p className="ob-muted">A list is a shortlist you curate. It does not qualify a record.</p>
        {lists.length === 0 ? <p className="ob-muted">No lists yet.</p> : <ul className="ob-list">{lists.map((list) => <li key={list.id}>
          <strong>{list.name}</strong> <span className="ob-muted">{list.count} members</span>
          <Link to={`${base}?listId=${encodeURIComponent(list.id)}&page=1&sort=name`} aria-current={list.id === listId ? 'page' : undefined}>Inspect {list.name}</Link>
          <a href={api.researchExportUrl(entry.id, project.id, { listId: list.id })}>Export {list.name} CSV</a>
        </li>)}</ul>}
        {canWrite && <ListForm disabled={pending} onCreate={(body) => run(() => api.createResearchList(entry.id, project.id, body), 'The list was not created.')} />}
      </section>
    </WorkspaceShell>
  );
}

function summaryText(summary, preview) {
  const head = preview ? 'Preview' : 'Import';
  const errors = summary.errors?.length ? ` ${summary.errors[0]}` : '';
  return `${head}: ${summary.importedEntities} new records, ${summary.importedClaims} claims, ${summary.skippedEntities} existing records, ${summary.skippedClaims} existing claims, ${summary.failed} failed, ${summary.duplicates} duplicate candidates, ${summary.conflicts} conflicts.${errors}`;
}

function BriefForm({ project, disabled, onSave }) {
  const stored = useRef({ name: project.name, question: project.question, brief: project.brief });
  const [draft, setDraft] = useState(stored.current);
  useEffect(() => {
    const previous = stored.current;
    const next = { name: project.name, question: project.question, brief: project.brief };
    setDraft((current) => Object.fromEntries(Object.keys(next).map((key) => [key, current[key] === previous[key] ? next[key] : current[key]])));
    stored.current = next;
  }, [project.name, project.question, project.brief]);
  const change = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== stored.current[key]));
      if (Object.keys(patch).length) onSave(patch);
    }}>
      <fieldset disabled={disabled}>
      <legend>Edit brief</legend>
      <div className="ob-field"><label htmlFor="research-name">Name</label><input type="text" id="research-name" name="name" value={draft.name} onChange={change('name')} maxLength={160} required /></div>
      <div className="ob-field"><label htmlFor="research-question">Question</label><textarea id="research-question" name="question" value={draft.question} onChange={change('question')} maxLength={2000} required /></div>
      <div className="ob-field"><label htmlFor="research-brief">Brief</label><textarea id="research-brief" name="brief" value={draft.brief} onChange={change('brief')} maxLength={8000} /></div>
      <button type="submit" className="btn-ghost" disabled={disabled}>Save brief</button>
      </fieldset>
    </form>
  );
}

function AddRecord({ directory, disabled, onAdd }) {
  const kinds = KINDS[directory] ?? ['organization'];
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  return (
    <form onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const name = String(data.get('name') || '').trim();
      const url = String(data.get('url') || '').trim();
      const excerpt = String(data.get('excerpt') || '').trim();
      const kind = String(data.get('kind') || kinds[0]);
      if (!name || !url || !excerpt) return;
      setPreparing(true); setError('');
      try {
        const normalized = new URL(url);
        if (normalized.protocol !== 'https:' || normalized.username || normalized.password) throw new Error('invalid_url');
        const identity = JSON.stringify([kind, name.normalize('NFKC'), normalized.toString()]);
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)));
        const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        const result = await onAdd({
        externalKey: `manual:${kind}:${digest}`,
        kind, name, directory, curated: directory === 'prospects',
        source: { url: normalized.toString(), publisher: 'Person in this workspace', title: name, status: 'inaccessible', failure: 'The page was not fetched. A person pasted this excerpt.', excerpt },
        claims: [{ field: 'name', value: name, status: 'extracted', method: 'human_paste', excerpt }],
      });
        if (result?.ok) form.reset();
      } catch { setError('The record was not confirmed saved. Check the public HTTPS URL and connection; your input is kept.'); }
      finally { setPreparing(false); }
    }}>
      <h3>Add a sourced record</h3>
      <p className="ob-muted">The page is not fetched. The excerpt is what you pasted, and the source stays “not fetched”.</p>
      {error && <p className="ob-alert" role="alert">{error}</p>}
      <fieldset disabled={disabled || preparing}>
      <legend>Record and source</legend>
      <div className="ob-field"><label htmlFor="add-kind">Kind</label>
        <select key={directory} id="add-kind" name="kind" defaultValue={kinds[0]}>{kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select>
      </div>
      <div className="ob-field"><label htmlFor="add-name">Name</label><input type="text" id="add-name" name="name" required maxLength={200} /></div>
      <div className="ob-field"><label htmlFor="add-url">Public https URL</label><input id="add-url" name="url" type="url" required maxLength={2000} placeholder="https://" /></div>
      <div className="ob-field"><label htmlFor="add-excerpt">Excerpt you copied</label><textarea id="add-excerpt" name="excerpt" required maxLength={2000} /></div>
      <button type="submit" className="btn-ghost">{preparing ? 'Saving…' : 'Add record'}</button>
      </fieldset>
    </form>
  );
}

function RunForm({ directory, disabled, onCreate }) {
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const urls = String(data.get('urls') || '').split(/\s+/).map((url) => url.trim()).filter(Boolean);
      onCreate({ question: String(data.get('question') || ''), urls, search: data.get('search') ? 'wikimedia' : 'none', directory });
    }}>
      <fieldset disabled={disabled}><legend>Propose a public-source run</legend>
      <div className="ob-field"><label htmlFor="run-question">Question</label><textarea id="run-question" name="question" required maxLength={2000} /></div>
      <div className="ob-field"><label htmlFor="run-urls">HTTPS URLs, one per line, at most 5</label><textarea id="run-urls" name="urls" placeholder="https://" /></div>
      <label className="ob-check"><input type="checkbox" name="search" /> Also search public Wikimedia</label>
      <p className="ob-muted">Proposing a run fetches nothing. Paid web search is not called. The saved-note Agent is not used.</p>
      <button type="submit" className="btn-app" disabled={disabled}>Propose run</button>
      </fieldset>
    </form>
  );
}

function ListForm({ disabled, onCreate }) {
  return (
    <form onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const result = await onCreate({ name: String(data.get('name') || ''), purpose: String(data.get('purpose') || '') });
      if (result?.ok) form.reset();
    }}>
      <fieldset disabled={disabled}>
      <legend>New list</legend>
      <div className="ob-field"><label htmlFor="list-name">List name</label><input type="text" id="list-name" name="name" required maxLength={120} /></div>
      <div className="ob-field"><label htmlFor="list-purpose">Purpose</label><input type="text" id="list-purpose" name="purpose" maxLength={500} /></div>
      <button type="submit" className="btn-ghost" disabled={disabled}>Create list</button>
      </fieldset>
    </form>
  );
}

function QualityCard({ quality, canWrite, disabled, onSave }) {
  const report = quality.report;
  const coverage = report.claims.total ? `${report.claims.withSource} of ${report.claims.total} claims point at a source` : 'No claims yet';
  const stored = useRef(quality.checklist);
  const [draft, setDraft] = useState(quality.checklist);
  useEffect(() => {
    const previous = stored.current;
    setDraft((current) => Object.fromEntries(CHECKLIST.map(([key]) => [key, current[key] === previous[key] ? quality.checklist[key] : current[key]])));
    stored.current = quality.checklist;
  }, [quality.checklist]);
  return (
    <section className="ob-card" aria-labelledby="research-quality-h">
      <h2 id="research-quality-h">Quality</h2>
      <p>{coverage}. Conflicting claims: {report.conflicting}. Open duplicate candidates: {report.duplicateCandidatesOpen}. Unfetched or failed page snapshots: {report.failedSources}. Citation gaps: {report.citationGaps}.</p>
      <p>Claims not yet supported or reviewed: {report.unsupported}. This includes extracted claims; it does not mean they are false. Source snapshots retrieved more than {quality.staleAfterDays} days ago: {report.staleSources}. Age alone does not establish that a source is wrong.</p>
      <p className="ob-muted">{report.limitations}</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        const patch = Object.fromEntries(CHECKLIST.filter(([key]) => draft[key] !== stored.current[key]).map(([key]) => [key, draft[key] === true]));
        if (Object.keys(patch).length) onSave(patch);
      }}>
        <fieldset disabled={!canWrite || disabled}>
          <legend>Acceptance checklist</legend>
          {CHECKLIST.map(([key, label]) => (
            <label key={key} className="ob-check"><input type="checkbox" name={key} checked={draft[key] === true} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.checked }))} /> {label}</label>
          ))}
        </fieldset>
        {canWrite && <button type="submit" className="btn-ghost" disabled={disabled}>Save checklist</button>}
      </form>
    </section>
  );
}

export async function researchEntityLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const [detail, project] = await Promise.all([
    api.researchEntity(entry.id, params.entityId),
    api.researchProject(entry.id, params.projectId),
  ]);
  return { account, entry, detail, project, projectId: params.projectId };
}

export function ResearchEntity() {
  const { account, entry, detail, project, projectId } = useLoaderData();
  const { entity, claims, relationships, duplicates, lists, canWrite } = detail;
  const revalidator = useRevalidator();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const back = `/w/${entry.slug}/research/${projectId}`;
  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title={entity.name} current="research">
      <div className="ob-intro">
        <span className="ob-eyebrow"><Link to={back}>Research</Link> · {entity.kind}</span>
        <h1 className="ob-h1">{entity.name}</h1>
      </div>
      {error && <p className="ob-alert" role="alert">{error}</p>}
      <section className="ob-card" aria-labelledby="claims-h">
        <h2 id="claims-h">Claims</h2>
        {claims.length === 0 ? <p className="ob-muted">No claims.</p> : (
          <ul className="ob-list">
            {claims.map((claim) => (
              <li key={claim.id}>
                <div style={{ overflowWrap: 'anywhere' }}>
                  <strong>{claim.field}</strong>: {claim.value}
                  <span className="ob-muted">{CLAIM_LABEL[claim.status] ?? claim.status} · {claim.extractionMethod}</span>
                  {claim.excerpt && <p>{claim.excerpt}</p>}
                  {claim.source ? <p className="ob-muted">Source {claim.source.status}: {claim.source.url}</p> : <p className="ob-muted">No source record. A human correction is kept beside the earlier claims.</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="ob-card" aria-labelledby="rel-h">
        <h2 id="rel-h">Relationships</h2>
        {relationships.length === 0 ? <p className="ob-muted">No relationships recorded.</p> : (
          <ul className="ob-list">{relationships.map((row) => <li key={row.id}>{row.kind}</li>)}</ul>
        )}
        {duplicates.length > 0 && <p>Open duplicate candidates: {duplicates.filter((row) => row.status === 'open').length}. Same name and kind with a different key. They were not merged.</p>}
      </section>
      {canWrite && (
        <section className="ob-card" aria-labelledby="correct-h">
          <h2 id="correct-h">Correct a field</h2>
          <p className="ob-muted">This writes a human-reviewed claim. A different earlier value stays visible and becomes conflicting.</p>
          <form onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            setPending(true); setError('');
            try {
              const res = await api.correctResearchClaim(entry.id, entity.id, { field: String(data.get('field') || ''), value: String(data.get('value') || ''), excerpt: String(data.get('excerpt') || '') });
              if (!res.ok) { setError(message(res, 'The correction was not saved.')); return; }
              form.reset();
              revalidator.revalidate();
            } catch { setError('The correction was not confirmed saved. Your input is kept; refresh before retrying.'); }
            finally { setPending(false); }
          }}>
            <fieldset disabled={pending}><legend>Correction</legend>
            <div className="ob-field"><label htmlFor="corr-field">Field</label><input type="text" id="corr-field" name="field" required pattern="[a-z0-9_]+" /></div>
            <div className="ob-field"><label htmlFor="corr-value">Value</label><input type="text" id="corr-value" name="value" required maxLength={2000} /></div>
            <div className="ob-field"><label htmlFor="corr-excerpt">Excerpt</label><textarea id="corr-excerpt" name="excerpt" required maxLength={2000} /></div>
            <button type="submit" className="btn-app">Save correction</button>
            </fieldset>
          </form>
        </section>
      )}
      <section className="ob-card" aria-labelledby="entity-lists-h">
        <h2 id="entity-lists-h">Lists</h2>
        {lists.length === 0 ? <p className="ob-muted">Not on a list.</p> : <ul className="ob-list">{lists.map((list) => <li key={list.id}>{list.name}</li>)}</ul>}
        {canWrite && project.lists?.length > 0 && (
          <form onSubmit={async (event) => {
            event.preventDefault();
            const listId = String(new FormData(event.currentTarget).get('listId') || '');
            setPending(true); setError('');
            try {
              const res = await api.addResearchListItem(entry.id, listId, { entityId: entity.id });
              if (!res.ok) { setError(message(res, 'The record was not added to that list.')); return; }
              revalidator.revalidate();
            } catch { setError('The connection failed. Refresh to check whether the record was added before retrying.'); }
            finally { setPending(false); }
          }}>
            <label htmlFor="entity-list">Add to a list in this project</label>
            <select id="entity-list" name="listId">{project.lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select>
            <button type="submit" className="btn-ghost" disabled={pending}>Add</button>
          </form>
        )}
      </section>
    </WorkspaceShell>
  );
}

export async function researchRunLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const detail = await api.researchRun(entry.id, params.runId);
  return { account, entry, detail, projectId: params.projectId };
}

export function ResearchRun() {
  const { account, entry, detail, projectId } = useLoaderData();
  const { run, events, canWrite } = detail;
  const revalidator = useRevalidator();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [starting, setStarting] = useState(false);
  const [picked, setPicked] = useState([]);
  const output = run.output;
  const back = `/w/${entry.slug}/research/${projectId}`;
  useEffect(() => {
    if (!starting && run.status !== 'running') return undefined;
    revalidator.revalidate();
    const timer = setInterval(() => revalidator.revalidate(), 1000);
    return () => clearInterval(timer);
  }, [starting, run.status, revalidator.revalidate]);
  async function act(action, fallback, kind) {
    if (kind === 'start') setStarting(true);
    else setPending(kind);
    setError('');
    try {
      const res = await action();
      if (!res.ok) { setError(message(res, fallback)); return; }
      if (res.data?.summary?.failed) setError(summaryText(res.data.summary, false));
      else setNotice(res.data?.summary ? summaryText(res.data.summary, false) : '');
    } catch { setError(`${fallback} The connection failed; refresh the recorded state before retrying.`); }
    finally {
      if (kind === 'start') setStarting(false);
      else setPending('');
      revalidator.revalidate();
    }
  }
  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title="Research run" current="research">
      <div className="ob-intro">
        <span className="ob-eyebrow"><Link to={back}>Research</Link> · {run.status}</span>
        <h1 className="ob-h1">{run.question}</h1>
      </div>
      {error && <p className="ob-alert" role="alert">{error}</p>}
      {notice && <p className="ob-alert ob-alert--ok" role="status">{notice}</p>}
      <section className="ob-card" aria-labelledby="perm-h">
        <h2 id="perm-h">Permissions for this run</h2>
        <ul className="ob-list">
          <li>Fetch the https URLs named here: {(run.permissions?.urls ?? []).join(', ') || 'none'}</li>
          <li>Wikimedia search: {run.permissions?.wikimedia ? 'yes' : 'no'}</li>
          <li>Paid web search: not called</li>
          <li>Model extraction: not called</li>
          <li>Saved-note Agent: not used</li>
          <li>Shell, mail and database access: not granted to the worker</li>
        </ul>
        {canWrite && run.status === 'proposed' && <button type="button" className="btn-app" disabled={starting || pending !== ''} onClick={() => act(() => api.startResearchRun(entry.id, run.id), 'The run did not finish.', 'start')}>{starting ? 'Running…' : 'Start run'}</button>}
        {canWrite && (run.status === 'proposed' || run.status === 'running' || starting) && <button type="button" className="btn-ghost" disabled={pending !== ''} onClick={() => act(() => api.cancelResearchRun(entry.id, run.id), 'The run was not cancelled.', 'cancel')}>{pending === 'cancel' ? 'Cancelling…' : 'Cancel'}</button>}
        {(starting || run.status === 'running') && <p role="status">Fetching approved public sources. Status refreshes while the request is pending. Cancel stops remaining worker requests; an already received page cannot be unfetched.</p>}
        {run.error && <p className="ob-alert" role="status">{run.error}</p>}
      </section>
      {output && (
        <section className="ob-card" aria-labelledby="report-h">
          <h2 id="report-h">Report</h2>
          <h3>Findings</h3>
          {output.findings?.length ? <ul className="ob-list">{output.findings.map((finding) => <li key={finding.sourceUrl}>{finding.text} <span className="ob-muted">{finding.label}. {finding.sourceUrl}</span></li>)}</ul> : <p className="ob-muted">No findings.</p>}
          <h3>Interpretation</h3>
          <p className="ob-muted">{output.interpretation?.length ? output.interpretation.join(' ') : 'No interpretation was added.'}</p>
          <h3>Uncertainty</h3>
          <ul className="ob-list">{(output.uncertainty ?? []).map((item) => <li key={item}>{item}</li>)}</ul>
          <h3>Limitations</h3>
          <ul className="ob-list">{(output.limitations ?? []).map((item) => <li key={item}>{item}</li>)}</ul>
          <h3>Citations</h3>
          <ul className="ob-list">{(output.citations ?? []).map((citation) => <li key={citation.url}><a href={citation.url}>{citation.title || citation.url}</a></li>)}</ul>
          {canWrite && run.status === 'completed' && (
            <form onSubmit={(event) => { event.preventDefault(); act(() => api.acceptResearchRun(entry.id, run.id, picked), 'The findings were not accepted.', 'accept'); }}>
              <fieldset>
                <legend>Accept candidates into {output.candidates?.[0]?.directory || 'the directory'}</legend>
                {(output.candidates ?? []).map((candidate) => (
                  <label key={candidate.externalKey} className="ob-check">
                    <input type="checkbox" checked={picked.includes(candidate.externalKey)} onChange={(event) => setPicked((current) => event.target.checked ? [...current, candidate.externalKey] : current.filter((key) => key !== candidate.externalKey))} />
                    {candidate.name}
                  </label>
                ))}
              </fieldset>
              <button type="submit" className="btn-app" disabled={pending !== '' || picked.length === 0}>Accept selected</button>
            </form>
          )}
        </section>
      )}
      <section className="ob-card" aria-labelledby="events-h">
        <h2 id="events-h">Events</h2>
        <ul className="ob-list">{events.map((event) => <li key={event.id}><span className="ob-muted">{event.kind}</span> {event.message}</li>)}</ul>
      </section>
    </WorkspaceShell>
  );
}
