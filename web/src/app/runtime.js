// The browser's client for a model runtime on this computer (Ollama on loopback). Requests go from this page
// straight to the person's own machine; nothing here passes through Valcairn's servers.

/** Errors the screen can explain. `message` is the runtime's own text, shortened; it never includes prompts. */
export class RuntimeError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const NS = 1e6; // Ollama reports durations in nanoseconds.
const ms = (ns) => (typeof ns === 'number' ? Math.round((ns / NS) * 1000) / 1000 : null);

function classify(text, status) {
  const t = String(text ?? '');
  if (/out of memory|requires more system memory|insufficient memory|cudaMalloc|unable to allocate/i.test(t)) return new RuntimeError('out_of_memory', t.slice(0, 300));
  if (/no space left|disk full|not enough space/i.test(t)) return new RuntimeError('disk_full', t.slice(0, 300));
  if (status === 404 || /not found/i.test(t)) return new RuntimeError('not_found', t.slice(0, 300));
  return new RuntimeError('runtime_error', t.slice(0, 300) || `The runtime answered ${status}.`);
}

/** Ollama marks models that run on ollama.com. Local mode never calls them, not even to read their details. */
export const isRemote = (m) => Boolean(m?.remote_host || m?.remote_model || m?.remote || /(^|[:-])cloud$/.test(String(m?.name ?? m?.model ?? '')));
const digestHex = (d) => (typeof d === 'string' ? d.replace(/^sha256:/, '') : null);

export function createRuntime(origin) {
  async function call(path, { method = 'GET', body, signal } = {}) {
    let res;
    try {
      res = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), signal, headers: body === undefined ? {} : { 'content-type': 'application/json' } });
    } catch (err) {
      if (err?.name === 'AbortError') throw new RuntimeError('aborted', 'Stopped.');
      // Not running, this site not allowed by OLLAMA_ORIGINS, or local network access declined in the browser:
      // the browser hides which one, so the screen explains all three.
      throw new RuntimeError('unreachable', 'The local runtime did not answer.');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw classify(data.error, res.status);
    }
    return res;
  }
  const json = async (path, opts) => (await call(path, opts)).json();

  /** Reads newline-delimited JSON as it streams. Each line can carry an error the runtime hit mid-stream. */
  async function* lines(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const data = JSON.parse(line);
          if (data.error) throw classify(data.error, 200);
          yield data;
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw new RuntimeError('aborted', 'Stopped.');
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError('disconnected', 'The connection to the local runtime closed.');
    }
    if (buffer.trim()) {
      const data = JSON.parse(buffer);
      if (data.error) throw classify(data.error, 200);
      yield data;
    }
  }

  return {
    origin,
    version: async () => (await json('/api/version')).version ?? null,
    async models({ signal } = {}) {
      const { models = [] } = await json('/api/tags', { signal });
      return models.map((m) => ({
        name: m.name, digest: digestHex(m.digest), sizeBytes: m.size ?? null, remote: isRemote(m), modifiedAt: m.modified_at ?? null,
        family: m.details?.family ?? null, parameterSize: m.details?.parameter_size ?? null, quantization: m.details?.quantization_level ?? null,
        format: m.details?.format ?? null, capabilities: m.capabilities ?? [],
      }));
    },
    async running({ signal } = {}) {
      const { models = [] } = await json('/api/ps', { signal });
      return models.map((m) => ({ name: m.name, digest: digestHex(m.digest), sizeBytes: m.size ?? null, sizeVramBytes: m.size_vram ?? null, expiresAt: m.expires_at ?? null, contextLength: m.context_length ?? null, remote: isRemote(m) }));
    },
    async show(name, { signal } = {}) {
      if (isRemote({ name })) throw new RuntimeError('remote', 'Cloud models are not inspected or run from this device.');
      const d = await json('/api/show', { method: 'POST', body: { model: name }, signal });
      const license = String(d.license ?? '').trim().split('\n').map((l) => l.trim()).find(Boolean) ?? null;
      return { details: d.details ?? {}, capabilities: d.capabilities ?? [], license, contextLength: Object.entries(d.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1] ?? null, thinking: Boolean(d.capabilities?.includes('thinking')) };
    },
    /**
     * Downloads a model into the runtime, reporting real byte progress per layer. Aborting the signal closes the
     * connection; Ollama then stops and keeps the partial layers, and a later pull resumes from them.
     */
    async pull(name, { signal, onProgress } = {}) {
      const layers = new Map();
      for await (const p of lines(await call('/api/pull', { method: 'POST', body: { model: name, stream: true }, signal }))) {
        if (p.digest && p.total) layers.set(p.digest, { total: p.total, completed: p.completed ?? 0 });
        const total = [...layers.values()].reduce((s, l) => s + l.total, 0);
        const completed = [...layers.values()].reduce((s, l) => s + l.completed, 0);
        onProgress?.({ status: p.status, total, completed });
        if (p.status === 'success') return;
      }
      throw new RuntimeError('disconnected', 'The download ended before the runtime confirmed it.');
    },
    remove: (name) => call('/api/delete', { method: 'DELETE', body: { model: name } }),
    /** Frees the model's memory now (keep_alive 0). The model stays installed. */
    unload: (name) => json('/api/generate', { method: 'POST', body: { model: name, keep_alive: 0 } }),
    /**
     * Streams a chat reply. Returns the full text and the runtime's own counters; the caller measures wall time and
     * time to first token itself, so the two sources stay separate.
     */
    async chat({ model, messages, options, think, signal, onToken }) {
      const body = { model, messages, stream: true, options, ...(think == null ? {} : { think }) };
      let content = '';
      let final = null;
      for await (const part of lines(await call('/api/chat', { method: 'POST', body, signal }))) {
        const piece = part.message?.content ?? '';
        if (piece || part.message?.thinking) onToken?.(piece, part.message?.thinking ?? '');
        content += piece;
        if (part.done) { final = part; break; }
      }
      if (!final) throw new RuntimeError('disconnected', 'The reply ended before the runtime finished it.');
      return {
        content,
        doneReason: final.done_reason ?? null,
        counters: { loadMs: ms(final.load_duration), promptTokens: final.prompt_eval_count ?? null, promptEvalMs: ms(final.prompt_eval_duration), outputTokens: final.eval_count ?? null, evalMs: ms(final.eval_duration) },
      };
    },
  };
}

/** What this browser says about the machine. Hints only: browsers round, cap or hide these values. */
export async function browserHints() {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  let gpu = null;
  let webgpu = false;
  try {
    const adapter = nav.gpu ? await nav.gpu.requestAdapter() : null;
    webgpu = Boolean(adapter);
    if (adapter?.info) gpu = { vendor: adapter.info.vendor || null, architecture: adapter.info.architecture || null, description: adapter.info.description || null };
  } catch { webgpu = false; }
  return {
    platform: nav.userAgentData?.platform ?? null,
    hardwareConcurrency: Number.isInteger(nav.hardwareConcurrency) ? nav.hardwareConcurrency : null,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    webgpu,
    gpu,
  };
}
