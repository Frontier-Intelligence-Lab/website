// JSON calls to the Fastify API. Same-origin only; the server checks Origin on every POST.
async function request(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function load(path) {
  const res = await request(path);
  if (!res.ok) throw new Response(res.data.error ?? 'Request failed', { status: res.status });
  return res.data;
}

export const api = {
  config: () => load('/api/config'),
  session: () => load('/api/session'),
  contact: (fields) => request('/api/contact', fields),
  login: (fields) => request('/api/login', fields),
  logout: () => request('/api/logout', {}),
  demoOverview: () => request('/api/demo/overview'),
  demoEnter: () => request('/api/demo/enter', {}),

  account: () => load('/api/account'),
  signup: (fields) => request('/api/account/signup', fields),
  signin: (fields) => request('/api/account/signin', fields),
  signout: () => request('/api/account/signout', {}),
  verify: (code) => request('/api/account/verify', { code }),
  resendCode: () => request('/api/account/verify/resend', {}),
  slugAvailable: (slug) => load(`/api/workspaces/slug-available?slug=${encodeURIComponent(slug)}`),
  createOrganization: (fields) => request('/api/workspaces', fields),
  createPersonal: (fields) => request('/api/workspaces/personal', fields),
  workspace: (id) => load(`/api/workspaces/${id}`),
  requestToJoin: (id, note) => request(`/api/workspaces/${id}/join-requests`, { note }),
  invite: (id, invites) => request(`/api/workspaces/${id}/invitations`, { invites }),
  decideJoin: (id, requestId, approve) => request(`/api/workspaces/${id}/join-requests/${requestId}/decision`, { approve }),
  projects: (id) => load(`/api/workspaces/${id}/projects`),
  project: (id, projectId) => load(`/api/workspaces/${id}/projects/${projectId}`),
  createProject: (id, fields) => request(`/api/workspaces/${id}/projects`, fields),
  updateProject: (id, projectId, patch) => request(`/api/workspaces/${id}/projects/${projectId}`, patch),
  uploadGrant: (id, projectId) => request(`/api/workspaces/${id}/projects/${projectId}/upload-grant`, {}),
  recordUpload: (id, projectId, receipt) => request(`/api/workspaces/${id}/projects/${projectId}/uploads`, { receipt }),
  submitReview: (id, projectId) => request(`/api/workspaces/${id}/projects/${projectId}/submit`, {}),
  createVersion: (id, projectId) => request(`/api/workspaces/${id}/projects/${projectId}/dataset-versions`, {}),
  reopenProject: (id, projectId) => request(`/api/workspaces/${id}/projects/${projectId}/reopen`, {}),
  deleteUpload: (id, projectId, uploadId) => request(`/api/workspaces/${id}/projects/${projectId}/uploads/${uploadId}/delete`, {}),
  dataset: (id, projectId) => load(`/api/workspaces/${id}/projects/${projectId}/dataset`),
  setLabelSet: (id, projectId, labels) => request(`/api/workspaces/${id}/projects/${projectId}/label-set`, { labels }),
  updateItem: (id, projectId, uploadId, patch) => request(`/api/workspaces/${id}/projects/${projectId}/items/${uploadId}`, patch),
  annotate: (id, projectId, uploadId, body) => request(`/api/workspaces/${id}/projects/${projectId}/items/${uploadId}/annotations`, body),
  updateAnnotation: (id, projectId, annotationId, patch) => request(`/api/workspaces/${id}/projects/${projectId}/annotations/${annotationId}`, patch),
  versionFileUrl: (id, projectId, number, fileId) => request(`/api/workspaces/${id}/projects/${projectId}/dataset-versions/${number}/files/${fileId}/download`),
  deleteAnnotation: (id, projectId, annotationId) => request(`/api/workspaces/${id}/projects/${projectId}/annotations/${annotationId}/delete`, {}),
  noteIssue: (id, projectId, key, note) => request(`/api/workspaces/${id}/projects/${projectId}/issues/note`, { key, note }),
  deleteIssueNote: (id, projectId, key) => request(`/api/workspaces/${id}/projects/${projectId}/issues/note/delete`, { key }),
  downloadUrl: (id, projectId, uploadId) => request(`/api/workspaces/${id}/projects/${projectId}/items/${uploadId}/download`),
  manifestUrl: (id, projectId, number) => `/api/workspaces/${id}/projects/${projectId}/dataset-versions/${number}/manifest`,
  revokeInvite: (id, invitationId) => request(`/api/workspaces/${id}/invitations/${invitationId}/revoke`, {}),
  invitation: (token) => request(`/api/invitations/${encodeURIComponent(token)}`),
  acceptInvitation: (token) => request(`/api/invitations/${encodeURIComponent(token)}/accept`, {}),
  academicSend: (id, email) => request(`/api/workspaces/${id}/academic/send`, { email }),
  academicVerify: (id, code) => request(`/api/workspaces/${id}/academic/verify`, { code }),
  models: (id) => load(`/api/workspaces/${id}/models`),
  pullModel: (id, modelId) => request(`/api/workspaces/${id}/models/pulls`, { modelId }),
  enhanceOptions: (id) => load(`/api/workspaces/${id}/enhance-runs/options`),
  enhanceRun: (id, runId) => load(`/api/workspaces/${id}/enhance-runs/${runId}`),
  createEnhanceRun: (id, plan) => request(`/api/workspaces/${id}/enhance-runs`, plan),
  updateEnhanceRun: (id, runId, plan) => request(`/api/workspaces/${id}/enhance-runs/${runId}`, plan),
  requestEnhanceRun: (id, runId, expectedUpdatedAt) => request(`/api/workspaces/${id}/enhance-runs/${runId}/request`, { expectedUpdatedAt }),
  localModels: () => load('/api/local-models'),
  localMemory: () => load('/api/local-memory'),
  devices: (id) => load(`/api/workspaces/${id}/devices`),
  device: (id, deviceId) => request(`/api/workspaces/${id}/devices/${deviceId}`),
  createDevice: (id, label) => request(`/api/workspaces/${id}/devices`, { label }),
  revokeDevice: (id, deviceId) => request(`/api/workspaces/${id}/devices/${deviceId}/revoke`, {}),
  deviceReport: (id, deviceId, report) => request(`/api/workspaces/${id}/devices/${deviceId}/reports`, report),
  saveInstall: (id, deviceId, install) => request(`/api/workspaces/${id}/devices/${deviceId}/installs`, install),
  recordRun: (id, deviceId, run) => request(`/api/workspaces/${id}/devices/${deviceId}/runs`, run),
  capital: (id) => load(`/api/workspaces/${id}/capital`),
  capitalCase: (id, caseId) => load(`/api/workspaces/${id}/capital/cases/${caseId}`),
  createCapitalCase: (id, fields) => request(`/api/workspaces/${id}/capital/cases`, fields),
  updateCapitalCase: (id, caseId, body) => request(`/api/workspaces/${id}/capital/cases/${caseId}`, body),
  submitCapitalCase: (id, caseId, body) => request(`/api/workspaces/${id}/capital/cases/${caseId}/submit`, body),
  withdrawCapitalCase: (id, caseId) => request(`/api/workspaces/${id}/capital/cases/${caseId}/withdraw`, {}),
  addCapitalEvidence: (id, caseId, item) => request(`/api/workspaces/${id}/capital/cases/${caseId}/evidence`, item),
  deleteCapitalEvidence: (id, caseId, evidenceId) => request(`/api/workspaces/${id}/capital/cases/${caseId}/evidence/${evidenceId}/delete`, {}),
  capitalExportUrl: (id, caseId) => `/api/workspaces/${id}/capital/cases/${caseId}/export`,
  addCreditRecord: (id, record) => request(`/api/workspaces/${id}/capital/credits`, record),
  staffCapital: (status = 'submitted') => load(`/api/staff/capital?status=${status}`),
  staffCapitalCase: (caseId) => load(`/api/staff/capital/${caseId}`),
  staffCapitalDecide: (caseId, body) => request(`/api/staff/capital/${caseId}/decision`, body),
  staffCapitalReviewEvidence: (caseId, evidenceId, submissionId) => request(`/api/staff/capital/${caseId}/evidence/${evidenceId}/review`, { submissionId }),
  runners: (id) => load(`/api/workspaces/${id}/runners`),
  linkRunner: (id, label) => request(`/api/workspaces/${id}/runners`, { label }),
  revokeRunner: (id, runnerId) => request(`/api/workspaces/${id}/runners/${runnerId}/revoke`, {}),
  jobs: (id) => load(`/api/workspaces/${id}/jobs`),
  job: (id, jobId, after = 0) => request(`/api/workspaces/${id}/jobs/${jobId}?after=${after}`),
  createJob: (id, body) => request(`/api/workspaces/${id}/jobs`, body),
  cancelJob: (id, jobId) => request(`/api/workspaces/${id}/jobs/${jobId}/cancel`, {}),
  staffReviews: (status = 'pending') => load(`/api/staff/reviews?status=${status}`),
  staffReview: (reviewId) => load(`/api/staff/reviews/${reviewId}`),
  staffDecide: (reviewId, body) => request(`/api/staff/reviews/${reviewId}/decision`, body),
  evaluations: (id, projectId) => load(`/api/workspaces/${id}/projects/${projectId}/evaluations`),
  evaluation: (id, projectId, setId) => load(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}`),
  createEvaluation: (id, projectId, body) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations`, body),
  updateEvaluation: (id, projectId, setId, body) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}`, body),
  saveEvalCase: (id, projectId, setId, body) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/cases`, body),
  deleteEvalCase: (id, projectId, setId, caseId, expectedRevision) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/cases/${caseId}/delete`, { expectedRevision }),
  importEvalCases: (id, projectId, setId, expectedRevision, jsonl) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/import`, { expectedRevision, jsonl }),
  noteEvalIssue: (id, projectId, setId, body) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/issues/note`, body),
  freezeEvaluation: (id, projectId, setId, expectedRevision) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/freeze`, { expectedRevision }),
  reopenEvaluation: (id, projectId, setId) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/reopen`, {}),
  importEvalPredictions: (id, projectId, setId, versionId, body) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/versions/${versionId}/predictions`, body),
  createEvalComparison: (id, projectId, setId, body) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/comparisons`, body),
  evalComparison: (id, projectId, comparisonId) => load(`/api/workspaces/${id}/projects/${projectId}/evaluations/comparisons/${comparisonId}`),
  caseRuns: (id, projectId, setId, versionId) => load(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/versions/${versionId}/runs`),
  caseRun: (id, projectId, setId, versionId, runId) => load(`/api/workspaces/${id}/projects/${projectId}/evaluations/${setId}/versions/${versionId}/runs/${runId}`),
  evalPreview: (id, projectId, comparisonId) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/comparisons/${comparisonId}/preview`),
  evalBlind: (id, projectId, comparisonId, body) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/comparisons/${comparisonId}/blind`, body),
  evalJudgment: (id, projectId, comparisonId, body) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/comparisons/${comparisonId}/judgments`, body),
  approveEvalReport: (id, projectId, comparisonId, body) => request(`/api/workspaces/${id}/projects/${projectId}/evaluations/comparisons/${comparisonId}/approve`, body),
  evalReport: (id, projectId, reportId) => load(`/api/workspaces/${id}/projects/${projectId}/evaluations/reports/${reportId}`),
  evalExportUrl: (id, projectId, reportId) => `/api/workspaces/${id}/projects/${projectId}/evaluations/reports/${reportId}/export`,
};

/**
 * Sends one file straight to the ingest service with a grant from the web server, reporting progress.
 * Resolves with the ingest response ({ receipt, sha256, ... }) or rejects with a readable message.
 */
export function uploadFile({ uploadUrl, grant }, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('authorization', `Bearer ${grant}`);
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status === 201) resolve(data);
      else reject(new Error(data.error ?? `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('The upload service could not be reached. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(file);
  });
}
