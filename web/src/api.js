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
};
