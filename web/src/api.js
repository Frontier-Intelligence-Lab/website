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
};
