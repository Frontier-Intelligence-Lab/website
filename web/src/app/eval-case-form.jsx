import { useState } from 'react';
import { api } from '../api.js';

export function caseEditForScope(editing, scope) {
  return scope.canWrite && scope.draft && editing?.workspaceId === scope.workspaceId
    && editing.projectId === scope.projectId && editing.setId === scope.setId ? editing : null;
}

export function caseFormPayload(row, fields, expectedRevision) {
  return {
    expectedRevision,
    ...(row ? { caseId: row.id } : {}),
    case: {
      id: fields.caseKey, input: fields.input, expectedAnswer: fields.expectedAnswer,
      reviewCriteria: fields.reviewCriteria, category: fields.category, severity: fields.severity,
      sources: fields.sourceRefs,
    },
  };
}

export function CaseForm({ entry, project, set, sources, row = null, expectedRevision = set.revision, pending, act, onDone }) {
  const [fields, setFields] = useState(() => ({
    caseKey: row?.caseKey ?? '', input: row?.input ?? '', expectedAnswer: row?.expectedAnswer ?? null,
    reviewCriteria: row?.reviewCriteria ?? null, category: row?.category ?? null, severity: row?.severity ?? null,
    sourceRefs: row ? row.sourceRefs.map((ref) => ({ ...ref })) : sources[0]
      ? [{ projectId: sources[0].projectId, versionId: sources[0].versionId, fileId: null }] : [],
  }));
  const ref = fields.sourceRefs[0];
  const source = sources.find((item) => item.projectId === ref?.projectId && item.versionId === ref?.versionId);
  const field = (key, value) => setFields((current) => ({ ...current, [key]: value }));
  function chooseSource(versionId) {
    const selected = sources.find((item) => item.versionId === versionId);
    field('sourceRefs', selected ? [{ projectId: selected.projectId, versionId: selected.versionId, fileId: null }] : []);
  }
  function chooseFile(fileId) {
    field('sourceRefs', [{ ...ref, fileId: fileId || null }, ...fields.sourceRefs.slice(1)]);
  }
  async function submit(event) {
    event.preventDefault();
    const saved = await act(() => api.saveEvalCase(entry.id, project.id, set.id,
      caseFormPayload(row, fields, expectedRevision)), 'Saving the case…', 'Case saved.');
    if (!saved) return;
    if (row) onDone();
    else setFields((current) => ({ ...current, caseKey: '', input: '', expectedAnswer: null, reviewCriteria: null }));
  }
  return (
    <form className="ob-card" onSubmit={submit} aria-busy={pending} aria-labelledby="case-form-heading">
      <h2 id="case-form-heading">{row ? `Edit ${row.caseKey}` : 'Add a case'}</h2>
      {sources.length === 0 && <p className="ob-alert">No frozen dataset version in this workspace allows testing. You can save a case, and the quality check will keep it blocked until you cite one.</p>}
      <div className="eval-grid">
        <div className="ob-field"><label htmlFor="case-id">Case id</label><input id="case-id" value={fields.caseKey} autoFocus={Boolean(row)} required disabled={pending} onChange={(e) => field('caseKey', e.target.value)} /></div>
        <div className="ob-field"><label htmlFor="case-category">Category</label><input id="case-category" value={fields.category ?? ''} disabled={pending} onChange={(e) => field('category', e.target.value)} /></div>
      </div>
      <div className="ob-field"><label htmlFor="case-input">Question</label><textarea id="case-input" value={fields.input} required rows={3} disabled={pending} onChange={(e) => field('input', e.target.value)} /></div>
      <div className="ob-field"><label htmlFor="case-expected">Expected answer</label><textarea id="case-expected" value={fields.expectedAnswer ?? ''} rows={2} disabled={pending} onChange={(e) => field('expectedAnswer', e.target.value)} /></div>
      <div className="ob-field"><label htmlFor="case-criteria">Review criteria</label><textarea id="case-criteria" value={fields.reviewCriteria ?? ''} rows={2} disabled={pending} onChange={(e) => field('reviewCriteria', e.target.value)} /></div>
      <div className="eval-grid">
        <div className="ob-field"><label htmlFor="case-severity">Severity</label><select id="case-severity" value={fields.severity ?? ''} disabled={pending} onChange={(e) => field('severity', e.target.value || null)}>
          <option value="">Not set</option><option value="critical">Critical</option><option value="major">Major</option><option value="minor">Minor</option>
        </select></div>
        <div className="ob-field"><label htmlFor="case-source">Frozen source</label><select id="case-source" value={ref?.versionId ?? ''} disabled={pending || fields.sourceRefs.length > 1} onChange={(e) => chooseSource(e.target.value)}>
          <option value="">None</option>
          {ref && !source && <option value={ref.versionId}>Saved source (unavailable)</option>}
          {sources.map((item) => <option key={item.versionId} value={item.versionId}>{item.projectName} version {item.number}</option>)}
        </select></div>
      </div>
      {fields.sourceRefs.length > 1 && <p className="ob-muted">{fields.sourceRefs.length} saved sources are retained. Editing multiple citations is not available here.</p>}
      {(source?.files?.length > 0 || ref?.fileId) && <div className="ob-field"><label htmlFor="case-file">File in that version</label><select id="case-file" value={ref?.fileId ?? ''} disabled={pending || fields.sourceRefs.length > 1} onChange={(e) => chooseFile(e.target.value)}>
        <option value="">Whole version</option>
        {ref?.fileId && !source?.files?.some((file) => file.id === ref.fileId) && <option value={ref.fileId}>Saved file (unavailable)</option>}
        {(source?.files ?? []).map((file) => <option key={file.id} value={file.id}>{file.filename}</option>)}
      </select></div>}
      <div className="ob-row-actions">
        <button className="btn-app" type="submit" disabled={pending}>{pending ? 'Saving…' : row ? 'Save changes' : 'Save case'}</button>
        {row && <button className="btn-ghost" type="button" disabled={pending} onClick={onDone}>Cancel edit</button>}
      </div>
    </form>
  );
}
