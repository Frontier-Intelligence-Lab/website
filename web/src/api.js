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
  revokeInvite: (id, invitationId) => request(`/api/workspaces/${id}/invitations/${invitationId}/revoke`, {}),
  invitation: (token) => request(`/api/invitations/${encodeURIComponent(token)}`),
  acceptInvitation: (token) => request(`/api/invitations/${encodeURIComponent(token)}/accept`, {}),
  academicSend: (id, email) => request(`/api/workspaces/${id}/academic/send`, { email }),
  academicVerify: (id, code) => request(`/api/workspaces/${id}/academic/verify`, { code }),
  staffReviews: (status = 'pending') => load(`/api/staff/reviews?status=${status}`),
  staffReview: (reviewId) => load(`/api/staff/reviews/${reviewId}`),
  staffDecide: (reviewId, body) => request(`/api/staff/reviews/${reviewId}/decision`, body),
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
