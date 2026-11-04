import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLoaderData } from 'react-router';
import { api } from '../api.js';
import { FieldError, Icon, Tile, requireWorkspace } from './ui.jsx';
import { WorkspaceShell, plural } from './shell.jsx';
import { RuntimeError, browserHints, createRuntime } from './runtime.js';
import { ReferencePicker } from './reference.jsx';
import { referencePrompt } from './memory.js';
import { passesTask, readyAfterTest } from '../../../src/lib/devices.js';

// Which device record this browser is. Not a secret: the server ties every device to its owner.
const deviceKey = (workspaceId, userId) => `valcairn.device.${workspaceId}.${userId}`;
const readDeviceId = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeDeviceId = (key, id) => { try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* storage off: lasts for this page */ } };

const gb = (bytes) => (bytes == null ? '—' : `${(bytes / 1024 ** 3).toFixed(bytes < 1024 ** 3 ? 2 : 1)} GB`);
const short = (digest) => (digest ? `${digest.slice(0, 12)}…` : '—');
const num = (v, digits = 0) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits }));
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const CTX_OPTIONS = [2048, 4096, 8192, 16384, 32768];
const STATE_LABEL = { downloading: 'Downloading', installed: 'Installed', verified: 'Verified', ready: 'Ready', failed: 'Failed', removed: 'Removed' };
const STATE_TONE = { installed: 'tile--blue', verified: 'tile--teal', ready: 'tile--green', failed: 'tile--orange', downloading: 'tile--violet' };

const ERROR_TEXT = {
  unreachable: 'Ollama did not answer from this page.',
  disconnected: 'The connection to Ollama closed before it finished.',
  out_of_memory: 'This computer ran out of memory loading or running the model.',
  disk_full: 'The disk is full, so the download could not finish.',
  not_found: 'Ollama could not find that model.',
  remote: 'That model runs on ollama.com, not on this device, so Valcairn does not use it in local mode.',
  runtime_error: 'Ollama reported an error.',
  aborted: 'Stopped.',
};
// Saved to Valcairn: only the error's category. The runtime's own text can echo a local prompt, so it stays on screen.
const savedFailure = (err) => (err instanceof RuntimeError ? ERROR_TEXT[err.kind] ?? ERROR_TEXT.runtime_error : 'Something went wrong.');
const explain = (err) => (err instanceof RuntimeError ? `${ERROR_TEXT[err.kind] ?? ERROR_TEXT.runtime_error}${err.message && !['aborted', 'unreachable'].includes(err.kind) ? ` (${err.message})` : ''}` : 'Something went wrong. Try again.');

export async function deviceLoader({ params }) {
  const { account, entry } = await requireWorkspace(params.slug);
  const [local, { devices }] = await Promise.all([api.localModels(), api.devices(entry.id)]);
  return { account, entry, local, devices };
}

export function RunOnDevice() {
  const { account, entry, local, devices: initialDevices } = useLoaderData();
  const key = deviceKey(entry.id, account.user.id);
  const origin = local.runtimeOrigins[0];
  const runtime = useMemo(() => createRuntime(origin), [origin]);
  const [devices, setDevices] = useState(initialDevices);
  const [deviceId, setDeviceId] = useState(() => {
    const stored = readDeviceId(key);
    return initialDevices.some((d) => d.id === stored && d.status === 'active') ? stored : null;
  });
  const [detail, setDetail] = useState(null); // { device, installs, runs } from the server
  const [conn, setConn] = useState({ status: 'idle' }); // what this page could read from the runtime just now
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(null); // 'chat' | 'test' while a model operation runs
  const [notice, setNotice] = useState(null);

  const refreshDetail = useCallback(async (id = deviceId) => {
    if (!id) return null;
    const res = await api.device(entry.id, id).catch(() => null);
    if (res?.status === 404) { writeDeviceId(key, null); setDeviceId(null); setDetail(null); return null; }
    if (res?.ok) setDetail(res.data);
    return res?.ok ? res.data : null;
  }, [deviceId, entry.id, key]);

  // Saves an install state, and forgets this browser's device if Valcairn says it was disconnected.
  const saveInstall = useCallback(async (install) => {
    const res = await api.saveInstall(entry.id, deviceId, install).catch(() => null);
    if (res?.data?.code === 'device_revoked') { writeDeviceId(key, null); setDeviceId(null); }
    return res?.ok ? res.data.install : null;
  }, [deviceId, entry.id, key]);

  /** Reads the runtime, tells Valcairn what it found, and reconciles install records with what is actually installed. */
  const probe = useCallback(async (id = deviceId) => {
    setConn((c) => ({ ...c, checking: true })); // the last status stays, so a re-check never unmounts a reply or test in progress
    const hints = await browserHints();
    let snapshot;
    try {
      const [version, models, running] = await Promise.all([runtime.version(), runtime.models(), runtime.running()]);
      snapshot = { status: 'connected', version, models, running, hints, checkedAt: new Date().toISOString() };
    } catch (err) {
      snapshot = { status: 'unreachable', error: err, hints, checkedAt: new Date().toISOString() };
    }
    setConn((c) => (snapshot.status === 'connected' ? snapshot : { models: c.models, running: c.running, version: c.version, ...snapshot })); // a failed re-check keeps what Ollama last reported, so nothing in progress is unmounted
    if (!id) return snapshot;
    const connected = snapshot.status === 'connected';
    await api.deviceReport(entry.id, id, {
      reachable: connected,
      runtimeVersion: connected ? snapshot.version : null,
      models: connected ? snapshot.models : [],
      running: connected ? snapshot.running : [],
      browser: hints,
    }).catch(() => null);
    const current = await refreshDetail(id);
    if (connected && current) {
      const byRef = new Map(current.installs.map((i) => [i.runtimeRef, i]));
      const present = new Set();
      for (const m of snapshot.models.filter((x) => !x.remote)) {
        present.add(m.name);
        const known = byRef.get(m.name);
        const changed = !known || ['removed', 'downloading', 'failed'].includes(known.state) || known.digest !== m.digest;
        if (changed) await api.saveInstall(entry.id, id, { runtimeRef: m.name, catalogId: local.catalog.find((c) => c.ref === m.name)?.id, digest: m.digest, sizeBytes: m.sizeBytes, details: { format: m.format, family: m.family, parameterSize: m.parameterSize, quantization: m.quantization, capabilities: m.capabilities }, state: 'installed' }).catch(() => null);
      }
      for (const i of current.installs) {
        if (!present.has(i.runtimeRef) && ['installed', 'verified', 'ready'].includes(i.state)) await api.saveInstall(entry.id, id, { runtimeRef: i.runtimeRef, catalogId: i.catalogId, digest: i.digest, sizeBytes: i.sizeBytes, details: i.details, state: 'removed' }).catch(() => null);
      }
      await refreshDetail(id);
    }
    return snapshot;
  }, [deviceId, entry.id, local.catalog, refreshDetail, runtime]);

  useEffect(() => { if (deviceId) probe(deviceId); }, [deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function connect(label) {
    const res = await api.createDevice(entry.id, label).catch(() => null);
    if (!res?.ok) return res?.data?.errors?.label ?? res?.data?.error ?? 'Valcairn could not be reached. Check your connection and try again.';
    writeDeviceId(key, res.data.device.id);
    setDevices((d) => [...d, res.data.device]);
    setDeviceId(res.data.device.id);
    return null;
  }
  async function disconnect(id) {
    const res = await api.revokeDevice(entry.id, id).catch(() => null);
    if (!res?.ok) { setNotice({ tone: 'warn', text: res?.data?.error ?? 'That did not work. Try again.' }); return; }
    setDevices((list) => list.map((d) => (d.id === id ? res.data.device : d)));
    if (id === deviceId) { writeDeviceId(key, null); setDeviceId(null); setDetail(null); setConn({ status: 'idle' }); }
    setNotice({ tone: 'ok', text: 'Disconnected. Valcairn keeps this device’s history but records nothing new from it. Models stay installed in Ollama.' });
  }

  const device = detail?.device;
  const localModels = (conn.models ?? []).filter((m) => !m.remote);
  // Embedding-only models turn text into vectors; they cannot chat, so they are listed but not offered to run.
  const chatModels = localModels.filter((m) => !m.capabilities.length || m.capabilities.includes('completion'));
  const cloudModels = (conn.models ?? []).filter((m) => m.remote);
  const installOf = (ref) => detail?.installs.find((i) => i.runtimeRef === ref) ?? null;
  const ctx = { account, entry, runtime, conn, setConn, probe, refreshDetail, saveInstall, installOf, deviceId, local, selected, setSelected, busy, setBusy };
  const others = devices.filter((d) => d.status === 'active' && d.id !== deviceId);

  return (
    <WorkspaceShell account={account} entry={entry} role={entry.role} title="Run on this device" current="device">
      <div className="ob-intro" style={{ gap: 8 }}>
        <span className="ob-eyebrow">Run on this device · {entry.name}</span>
        <h1 className="ob-h1">Run on this device</h1>
        <p className="ob-lede">Open models run on this computer through Ollama. Prompts and replies stay here. Valcairn records which model ran, its exact digest and how fast it was.</p>
        <div className="ob-chips" style={{ gap: 6 }} aria-label="Where models can run">
          <span className="ob-badge tile--green">Available · Ollama on this computer</span>
          <span className="ob-badge">Planned · In the browser (WebGPU)</span>
          <span className="ob-badge">Planned · Remote GPUs</span>
        </div>
      </div>
      {notice && <p className={`ob-alert${notice.tone === 'ok' ? ' ob-alert--ok' : ''}`} role="status">{notice.text}</p>}

      {!deviceId ? <ConnectCard onConnect={connect} others={others} onAdopt={(id) => { writeDeviceId(key, id); setDeviceId(id); }} /> : (
        <>
          <ConnectionCard ctx={ctx} device={device} onDisconnect={() => disconnect(deviceId)} />
          {conn.models && (
            <>
              <ModelsCard ctx={ctx} localModels={localModels} cloudModels={cloudModels} />
              <RunCard ctx={ctx} localModels={chatModels} />
              <TestCard ctx={ctx} localModels={chatModels} />
            </>
          )}
          <MeasurementsCard runs={detail?.runs ?? []} />
          <DataNotice />
        </>
      )}
      {deviceId && others.length > 0 && <OtherDevices devices={others} onDisconnect={disconnect} />}
    </WorkspaceShell>
  );
}

/* ---------------- Connect ---------------- */

function ConnectCard({ onConnect, others, onAdopt }) {
  const [label, setLabel] = useState('');
  const [state, setState] = useState({ pending: false, error: null });
  async function submit(e) {
    e.preventDefault();
    setState({ pending: true, error: null });
    const error = await onConnect(label);
    setState({ pending: false, error });
  }
  return (
    <section className="ob-card" aria-labelledby="connect-h">
      <div className="row-between"><h2 id="connect-h">Connect this computer</h2><Tile icon="link" tone="green" /></div>
      <p className="ob-muted">Valcairn will ask Ollama on this computer which models are installed and running. Nothing runs until you choose it. Your browser may ask whether this site can reach apps on this device: allow it to continue.</p>
      <form className="ob-form" style={{ maxWidth: 520 }} onSubmit={submit} noValidate>
        <div className="ob-field">
          <label htmlFor="device-label">Name this device</label>
          <input id="device-label" type="text" value={label} maxLength={80} placeholder="For example Work laptop" aria-invalid={Boolean(state.error)} aria-describedby="device-label-error" onChange={(e) => setLabel(e.target.value)} />
          <FieldError id="device-label-error">{state.error}</FieldError>
        </div>
        <button type="submit" className="btn-app" disabled={state.pending}>{state.pending ? 'Connecting…' : 'Connect'}</button>
      </form>
      {others.length > 0 && (
        <div className="cell-stack" style={{ gap: 8 }}>
          <p className="ob-muted" style={{ fontSize: 13 }}>Already connected this computer before, then cleared this browser’s data? Pick it to keep its history instead of adding a new device.</p>
          <ul className="ob-list">
            {others.map((d) => (
              <li key={d.id} className="row-between">
                <span className="cell-stack"><strong>{d.label}</strong><span className="ob-muted" style={{ fontSize: 12 }}>Last seen {when(d.lastSeenAt)}</span></span>
                <button type="button" className="btn-small" onClick={() => onAdopt(d.id)}>This is {d.label}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ConnectionCard({ ctx, device, onDisconnect }) {
  const { conn, probe, runtime, busy } = ctx;
  const [confirming, setConfirming] = useState(false);
  const hints = conn.hints;
  return (
    <section className="ob-card" aria-labelledby="conn-h">
      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <div className="cell-stack">
          <h2 id="conn-h">{device?.label ?? 'This device'}</h2>
          <span className="ob-muted" style={{ fontSize: 13 }} aria-live="polite">
            {conn.checking ? 'Checking Ollama…' : conn.status === 'connected' ? `Connected to Ollama ${conn.version ?? ''} at ${runtime.origin}` : conn.status === 'unreachable' ? (conn.models ? 'Ollama did not answer the last check. Showing what it reported before.' : 'Ollama is not reachable from this page') : 'Not checked yet'}
          </span>
        </div>
        <div className="row-wrap gap-10">
          <button type="button" className="btn-ghost" onClick={() => probe()} disabled={conn.checking}>{conn.status === 'unreachable' ? 'Try again' : 'Refresh'}</button>
          {confirming ? (
            <span className="row-wrap gap-10" role="group" aria-label="Confirm disconnect">
              <button type="button" className="btn-app" onClick={onDisconnect}>Disconnect device</button>
              <button type="button" className="btn-text" onClick={() => setConfirming(false)}>Keep it</button>
            </span>
          ) : <button type="button" className="btn-text" onClick={() => setConfirming(true)}>Disconnect…</button>}
        </div>
      </div>

      {conn.status === 'unreachable' && !busy && <SetupHelp origin={runtime.origin} />}

      <div className="ob-grid dev-facts">
        <Facts title="Reported by your browser" note="Hints only. Browsers round, cap or hide these values.">
          <Fact label="CPU threads" value={num(hints?.hardwareConcurrency)} />
          <Fact label="Memory hint" value={hints?.deviceMemoryGb ? `≥ ${hints.deviceMemoryGb} GB (capped by the browser)` : 'Not shared'} />
          <Fact label="WebGPU" value={hints ? (hints.webgpu ? 'Available' : 'Not available') : '—'} />
          <Fact label="GPU" value={hints?.gpu ? [hints.gpu.vendor, hints.gpu.architecture].filter(Boolean).join(' · ') || 'Not shared' : 'Not shared'} />
        </Facts>
        <Facts title="Reported by Ollama" note="What the runtime says about itself and its loaded models. Not the computer’s full memory.">
          <Fact label="Version" value={conn.version ?? '—'} />
          <Fact label="Installed here" value={conn.models ? plural(conn.models.filter((m) => !m.remote).length, 'model') : '—'} />
          <Fact label="Loaded now" value={conn.running ? (conn.running.length ? conn.running.map((m) => `${m.name} (${gb(m.sizeVramBytes)} on GPU)`).join(', ') : 'None') : '—'} />
        </Facts>
        <Facts title="Measured by Valcairn" note="Timed on this device by this page. Shown below, run by run.">
          <Fact label="Last check" value={when(conn.checkedAt)} />
          <Fact label="Compatibility" value={<CompatSummary ctx={ctx} />} />
        </Facts>
      </div>
    </section>
  );
}

function SetupHelp({ origin }) {
  const site = typeof window === 'undefined' ? '' : window.location.origin;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(site);
  return (
    <div className="ob-alert" role="alert">
      <strong>Ollama did not answer at {origin}.</strong> The browser does not say why, so check these in order:
      <ol className="dev-steps">
        <li>Ollama is installed and running on this computer (<a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a>).</li>
        {local ? <li>This page runs on {site}, which Ollama allows by default.</li> : (
          <li>
            Ollama allows only sites you name. Add exactly this site, then quit and reopen Ollama:
            <pre className="dev-pre"><code>{`Windows (PowerShell):  setx OLLAMA_ORIGINS "${site}"\nmacOS:                 launchctl setenv OLLAMA_ORIGINS "${site}"\nLinux (systemd):       Environment="OLLAMA_ORIGINS=${site}" in the ollama service`}</code></pre>
            Do not use <code>*</code>: that lets any website use your models. Keep Ollama listening on 127.0.0.1 only.
          </li>
        )}
        <li>If the browser asked whether this site may reach apps on this device, allow it. You can change it in the site settings.</li>
      </ol>
    </div>
  );
}

const Facts = ({ title, note, children }) => (
  <div className="dev-facts-col">
    <h3>{title}</h3>
    <dl>{children}</dl>
    <p className="ob-muted" style={{ fontSize: 12 }}>{note}</p>
  </div>
);
const Fact = ({ label, value }) => <div className="dev-fact"><dt>{label}</dt><dd>{value}</dd></div>;

function CompatSummary({ ctx }) {
  const ready = (ctx.conn.models ?? []).filter((m) => ctx.installOf(m.name)?.state === 'ready');
  return ready.length ? `Tested: ${ready.map((m) => m.name).join(', ')}` : 'Not tested yet';
}

/* ---------------- Models ---------------- */

function ModelsCard({ ctx, localModels, cloudModels }) {
  const { local, conn } = ctx;
  const installedRefs = new Set(localModels.map((m) => m.name));
  return (
    <section className="ob-card" aria-labelledby="models-h">
      <div className="row-between"><h2 id="models-h">Models on this device</h2><span className="ob-muted" style={{ fontSize: 12 }}>Installed and managed by Ollama</span></div>
      {localModels.length === 0 ? <p className="ob-muted">No models installed in Ollama yet. Download one below.</p> : (
        <div className="ob-table-wrap">
          <table>
            <thead><tr><th scope="col">Model</th><th scope="col">Size</th><th scope="col">Digest</th><th scope="col">State</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {localModels.map((m) => <InstalledRow key={m.name} ctx={ctx} model={m} loaded={conn.running.some((r) => r.name === m.name)} />)}
            </tbody>
          </table>
        </div>
      )}
      {cloudModels.length > 0 && (
        <p className="ob-muted" style={{ fontSize: 13 }}>
          <Icon name="info" size={14} /> Not used here: {cloudModels.map((m) => m.name).join(', ')}. {cloudModels.length === 1 ? 'It runs' : 'They run'} on ollama.com, not on this device, so local mode never calls {cloudModels.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      <h3 style={{ marginTop: 8 }}>Download a model</h3>
      {local.catalog.length === 0 ? <p className="ob-muted">This server has no download catalog configured. Models already installed in Ollama still work here.</p> : (
        <div className="ob-grid">
          {local.catalog.map((m) => <DownloadCard key={m.id} ctx={ctx} model={m} installed={installedRefs.has(m.ref)} />)}
        </div>
      )}
    </section>
  );
}

function InstalledRow({ ctx, model, loaded }) {
  const { runtime, probe, saveInstall, installOf, setSelected } = ctx;
  const install = installOf(model.name);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const verifyAbort = useRef(null);
  useEffect(() => () => verifyAbort.current?.abort(), []);
  async function verify() {
    setBusy('verify'); setError(null);
    verifyAbort.current = new AbortController();
    try {
      const saved = await verifyModel(ctx, model.name, verifyAbort.current.signal);
      if (!saved) setError('Verified on this device, but Valcairn did not record it. Try Verify again.');
    } catch (err) { if (err.kind !== 'aborted') setError(explain(err)); }
    verifyAbort.current = null;
    setBusy(null);
  }
  async function unload() {
    setBusy('unload'); setError(null);
    try { await runtime.unload(model.name); await probe(); } catch (err) { setError(explain(err)); }
    setBusy(null);
  }
  async function remove() {
    setBusy('remove'); setError(null);
    try {
      await runtime.remove(model.name);
      const still = (await runtime.models()).some((m) => m.name === model.name);
      if (still) throw new RuntimeError('runtime_error', 'Ollama still lists the model.');
      await saveInstall({ runtimeRef: model.name, catalogId: install?.catalogId, digest: model.digest, sizeBytes: model.sizeBytes, details: install?.details ?? {}, state: 'removed' });
      await probe();
    } catch (err) { setError(explain(err)); }
    setBusy(null); setConfirmRemove(false);
  }
  const state = install?.state ?? 'installed';
  const chat = !model.capabilities.length || model.capabilities.includes('completion');
  return (
    <tr>
      <td>
        <div className="cell-stack">
          <strong>{model.name}</strong>
          <span className="ob-muted" style={{ fontSize: 12 }}>{[model.parameterSize, model.quantization, model.format].filter(Boolean).join(' · ')}{loaded ? ' · loaded in memory' : ''}</span>
          {error && <span className="ob-error" role="alert">{error}</span>}
        </div>
      </td>
      <td>{gb(model.sizeBytes)}</td>
      <td><code title={model.digest ?? ''}>{short(model.digest)}</code></td>
      <td><span className={`ob-badge ${STATE_TONE[state] ?? ''}`}>{STATE_LABEL[state]}</span></td>
      <td>
        <div className="row-wrap gap-10" style={{ justifyContent: 'flex-end' }}>
          {/* Same rule as the Run and Test selectors: the model cannot change while a reply or test is in progress. */}
          {chat ? <button type="button" className="btn-small" onClick={() => setSelected(model.name)} disabled={Boolean(ctx.busy)} aria-describedby={ctx.busy ? 'run-busy' : undefined} aria-label={`Use ${model.name}`}>Use</button> : <span className="ob-muted" style={{ fontSize: 12 }}>Embeddings only</span>}
          {chat && !['verified', 'ready'].includes(state) && <button type="button" className="btn-small" onClick={verify} disabled={Boolean(busy)}>{busy === 'verify' ? 'Verifying…' : 'Verify'}</button>}
          {loaded && <button type="button" className="btn-small" onClick={unload} disabled={Boolean(busy)}>{busy === 'unload' ? 'Unloading…' : 'Unload'}</button>}
          {confirmRemove ? (
            <span className="row-wrap gap-10" role="group" aria-label={`Confirm removing ${model.name}`}>
              <button type="button" className="btn-small" onClick={remove} disabled={Boolean(busy)}>{busy === 'remove' ? 'Removing…' : `Delete ${gb(model.sizeBytes)}`}</button>
              <button type="button" className="btn-text" onClick={() => setConfirmRemove(false)}>Keep</button>
            </span>
          ) : <button type="button" className="btn-text" onClick={() => setConfirmRemove(true)}>Remove…</button>}
        </div>
      </td>
    </tr>
  );
}

/**
 * Verified means: Ollama lists the model with a digest, Valcairn read its details back, and the model loaded and
 * produced one token on this device. Any failure is recorded as failed, with the runtime's reason.
 */
async function verifyModel(ctx, name, signal) {
  const { runtime, saveInstall, local, probe } = ctx;
  const catalogId = local.catalog.find((c) => c.ref === name)?.id;
  let listed = null;
  try {
    listed = (await runtime.models({ signal })).find((m) => m.name === name);
    if (!listed?.digest) throw new RuntimeError('not_found', 'Ollama does not list this model.');
    const info = await runtime.show(name, { signal });
    await runtime.chat({ model: name, messages: [{ role: 'user', content: 'Reply with OK.' }], options: { num_predict: 1, temperature: 0 }, think: info.thinking ? false : undefined, signal });
    const details = { format: info.details.format, family: info.details.family, parameterSize: info.details.parameter_size, quantization: info.details.quantization_level, license: info.license, capabilities: info.capabilities };
    const again = (await runtime.models({ signal })).find((m) => m.name === name);
    if (again?.digest !== listed.digest) throw new RuntimeError('runtime_error', 'The model changed while it was being checked.');
    return Boolean(await saveInstall({ runtimeRef: name, catalogId, digest: listed.digest, sizeBytes: listed.sizeBytes, details, state: 'verified' }));
  } catch (err) {
    // A stopped check is not a failed model: it stays installed and unverified.
    const stopped = err instanceof RuntimeError && err.kind === 'aborted';
    await saveInstall({ runtimeRef: name, catalogId, digest: listed?.digest ?? null, sizeBytes: listed?.sizeBytes ?? null, details: {}, ...(stopped && listed ? { state: 'installed' } : { state: 'failed', failure: savedFailure(err) }) });
    throw err;
  } finally {
    if (!signal?.aborted) await probe();
  }
}

function DownloadCard({ ctx, model, installed }) {
  const { runtime, saveInstall, installOf, probe } = ctx;
  const [phase, setPhase] = useState('idle'); // idle | confirm | downloading | verifying | done | stopped | failed
  const [progress, setProgress] = useState({ completed: 0, total: 0, status: '' });
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const previous = installOf(model.ref);
  const resumable = previous?.state === 'failed' || previous?.state === 'downloading';

  async function start() {
    setPhase('downloading'); setError(null); setProgress({ completed: 0, total: 0, status: 'Starting' });
    const controller = new AbortController();
    abortRef.current = controller;
    await saveInstall({ runtimeRef: model.ref, catalogId: model.id, digest: null, sizeBytes: null, details: { license: model.license }, state: 'downloading' });
    try {
      await runtime.pull(model.ref, { signal: controller.signal, onProgress: setProgress });
      setPhase('verifying');
      const saved = await verifyModel(ctx, model.ref, controller.signal);
      setPhase(saved ? 'done' : 'unsaved');
    } catch (err) {
      const stopped = err instanceof RuntimeError && err.kind === 'aborted';
      // A stopped download is not an install. Ollama keeps the partial layers and resumes from them next time.
      const listed = (await runtime.models().catch(() => [])).find((m) => m.name === model.ref);
      if (!listed) await saveInstall({ runtimeRef: model.ref, catalogId: model.id, digest: null, sizeBytes: null, details: { license: model.license }, state: 'failed', failure: stopped ? 'Download stopped before it finished.' : savedFailure(err) });
      setPhase(stopped ? (listed ? 'verify_stopped' : 'stopped') : 'failed');
      if (!stopped) setError(explain(err));
      if (err instanceof RuntimeError && ['unreachable', 'disconnected'].includes(err.kind)) await probe();
    }
    abortRef.current = null;
  }
  useEffect(() => () => abortRef.current?.abort(), []);

  const pct = progress.total ? Math.min(100, (progress.completed / progress.total) * 100) : 0;
  return (
    <div className="ob-card dev-model" aria-labelledby={`dl-${model.id}`}>
      <div className="row-between"><strong id={`dl-${model.id}`}>{model.name}</strong><span className="ob-badge">{model.params}</span></div>
      <p className="ob-muted" style={{ fontSize: 13 }}>{model.summary}</p>
      <dl className="dev-meta">
        <Fact label="Download" value={`about ${model.approxGb} GB`} />
        <Fact label="License" value={model.license} />
        <Fact label="Source" value={<a href={model.source} target="_blank" rel="noreferrer">{model.ref}</a>} />
      </dl>
      {installed && phase !== 'done' && <span className="ob-ok"><Icon name="check" size={14} stroke={2.4} /> Installed on this device</span>}
      {phase === 'done' && <span className="ob-ok" role="status"><Icon name="check" size={14} stroke={2.4} /> Downloaded and verified</span>}
      {!installed && phase === 'idle' && <button type="button" className="btn-ghost" onClick={() => setPhase('confirm')}>{resumable ? 'Resume download…' : 'Download…'}</button>}
      {phase === 'confirm' && (
        <div className="dev-confirm" role="group" aria-label={`Confirm downloading ${model.name}`}>
          <p style={{ fontSize: 13 }}>Download about <strong>{model.approxGb} GB</strong> from ollama.com into Ollama on this computer? You accept the model’s license: {model.license}.</p>
          <div className="row-wrap gap-10">
            <button type="button" className="btn-app" onClick={start}>Download</button>
            <button type="button" className="btn-text" onClick={() => setPhase('idle')}>Cancel</button>
          </div>
        </div>
      )}
      {phase === 'downloading' && (
        <div className="cell-stack" style={{ gap: 6 }}>
          <span className="mdl-meter" role="progressbar" aria-label={`Downloading ${model.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><span style={{ width: `${pct}%` }} /></span>
          <span className="ob-muted" style={{ fontSize: 12 }} aria-live="polite">{progress.total ? `${gb(progress.completed)} of ${gb(progress.total)} · ${pct.toFixed(0)}%` : progress.status || 'Starting'}</span>
          <button type="button" className="btn-small" onClick={() => abortRef.current?.abort()}>Stop download</button>
        </div>
      )}
      {phase === 'verifying' && (
        <div className="cell-stack" style={{ gap: 6 }}>
          <span className="ob-muted" role="status">Checking the digest and loading the model once. The first load can take 30 seconds or more…</span>
          <button type="button" className="btn-small" onClick={() => abortRef.current?.abort()}>Stop check</button>
        </div>
      )}
      {phase === 'verify_stopped' && <span role="status" style={{ fontSize: 13 }}>Downloaded. The check was stopped, so it is installed but not verified. Verify it from the table above.</span>}
      {phase === 'unsaved' && <span className="ob-error" role="alert">Downloaded and verified on this device, but Valcairn did not record it. Use Verify in the table above to try again.</span>}
      {phase === 'stopped' && (
        <div className="cell-stack" style={{ gap: 6 }}>
          <span role="status" style={{ fontSize: 13 }}>Stopped. Nothing was installed. Ollama keeps the part already downloaded and resumes from it.</span>
          <button type="button" className="btn-ghost" onClick={() => setPhase('confirm')}>Resume download…</button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="cell-stack" style={{ gap: 6 }}>
          <span className="ob-error" role="alert">{error}</span>
          <button type="button" className="btn-ghost" onClick={() => setPhase('confirm')}>Try again…</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Run ---------------- */

/** Times one chat on the local runtime and records it. Wall time and first-token time are measured here. */
async function timedChat(ctx, { model, messages, numCtx, numPredict, temperature, seed, think, signal, onToken }) {
  const { runtime } = ctx;
  const settings = { numCtx, numPredict, temperature, ...(seed == null ? {} : { seed }), ...(think == null ? {} : { think }) };
  let warm = false;
  let t0 = performance.now();
  let ttftMs = null;
  try {
    // Warm only if the model is already loaded with this context size: Ollama reloads it when num_ctx changes.
    warm = (await runtime.running({ signal })).some((m) => m.name === model && (m.contextLength == null || m.contextLength === numCtx));
    t0 = performance.now();
    const result = await runtime.chat({
      model, messages, think, signal,
      options: { num_ctx: numCtx, num_predict: numPredict, temperature, ...(seed == null ? {} : { seed }) },
      onToken: (piece, thinking) => { if (ttftMs == null && (piece || thinking)) ttftMs = performance.now() - t0; onToken?.(piece, thinking); },
    });
    return { ok: true, warm, settings, result, metrics: { wallMs: performance.now() - t0, ttftMs, ...stripNull(result.counters) } };
  } catch (err) {
    return { ok: false, warm, settings, error: err, metrics: { wallMs: performance.now() - t0, ...(ttftMs == null ? {} : { ttftMs }) } };
  }
}
const stripNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/** Records a measured run. Returns null when saved, or a retry function when Valcairn did not record it. */
async function recordRun(ctx, model, { kind, warm, status, settings, metrics, task, failure }) {
  const install = ctx.installOf(model);
  const listed = ctx.conn.models?.find((m) => m.name === model);
  const body = { installId: install?.id, modelRef: model, modelDigest: listed?.digest ?? null, location: 'local_runtime', kind, warm, status, settings, metrics, task, failure };
  const save = async () => Boolean((await api.recordRun(ctx.entry.id, ctx.deviceId, body).catch(() => null))?.ok);
  return (await save()) ? null : save;
}

/** Shown when a result was measured here but Valcairn did not record it. */
function UnsavedNotice({ retries, onDone }) {
  const [pending, setPending] = useState(false);
  if (!retries.length) return null;
  async function retry() {
    setPending(true);
    const left = [];
    for (const save of retries) if (!(await save())) left.push(save);
    setPending(false);
    onDone(left);
  }
  return (
    <p className="ob-alert" role="alert">
      {plural(retries.length, 'result')} measured on this device {retries.length === 1 ? 'was' : 'were'} not saved to Valcairn.{' '}
      <button type="button" className="btn-text" onClick={retry} disabled={pending}>{pending ? 'Saving…' : 'Save again'}</button>
    </p>
  );
}

function RunCard({ ctx, localModels }) {
  const { selected, setSelected, runtime, probe, busy, setBusy } = ctx;
  const model = localModels.find((m) => m.name === selected) ?? null;
  const [info, setInfo] = useState(null);
  const [numCtx, setNumCtx] = useState(4096);
  const [numPredict, setNumPredict] = useState('512');
  const [temperature, setTemperature] = useState('0.7');
  const [think, setThink] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState(null); // the reply being streamed
  const liveRef = useRef(null);
  const [last, setLast] = useState(null);
  const [error, setError] = useState(null);
  const [unsaved, setUnsaved] = useState([]);
  const [references, setReferences] = useState([]); // passages from the person's memory, chosen for the next message only
  const abortRef = useRef(null);
  const opRef = useRef(0); // identity of the current chat; late callbacks from an older one are ignored

  useEffect(() => {
    // A new model is a new conversation: stop any reply still streaming from the old one and drop its partial text
    // here. The stopped request still returns to send(), which records it under the model that produced it.
    opRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    liveRef.current = null;
    setLive(null);
    setInfo(null); setMessages([]); setLast(null); setError(null);
    if (!model) return undefined;
    const controller = new AbortController();
    runtime.show(model.name, { signal: controller.signal }).then(setInfo, (err) => { if (err.kind !== 'aborted') setError(explain(err)); });
    return () => controller.abort();
  }, [model?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => abortRef.current?.abort(), []);

  const ctxChoices = CTX_OPTIONS.filter((n) => !info?.contextLength || n <= info.contextLength);
  const predict = Number(numPredict);
  const temp = Number(temperature);
  const limitsOk = Number.isInteger(predict) && predict >= 1 && predict <= 8192 && temperature.trim() !== '' && temp >= 0 && temp <= 2;

  async function send(e) {
    e.preventDefault();
    if (!model || !draft.trim() || live || busy || !limitsOk) return;
    const op = ++opRef.current;
    const history = [...messages, { role: 'user', content: draft.trim() }];
    // Chosen passages are quoted ahead of this request only, as data; they are not part of the conversation shown.
    const quoted = references.map((p) => ({ id: p.id, title: p.title || 'Untitled', kind: p.source?.source_type ?? 'note' }));
    const request = references.length ? [{ role: 'system', content: referencePrompt(references) }, ...history] : history;
    setMessages(history); setDraft(''); setError(null);
    liveRef.current = { content: '', thinking: '' };
    setLive(liveRef.current);
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('chat');
    const out = await timedChat(ctx, {
      model: model.name, messages: request, numCtx, numPredict: predict, temperature: temp, signal: controller.signal,
      think: info?.thinking ? think : undefined,
      onToken: (piece, thinking) => {
        if (opRef.current !== op) return;
        liveRef.current = { content: liveRef.current.content + piece, thinking: liveRef.current.thinking + thinking };
        setLive(liveRef.current);
      },
    });
    setBusy(null);
    const stopped = !out.ok && out.error.kind === 'aborted';
    const outcome = { kind: 'chat', warm: out.warm, status: out.ok ? 'completed' : stopped ? 'stopped' : 'failed', settings: out.settings, metrics: out.metrics, failure: out.ok || stopped ? null : savedFailure(out.error) };
    if (opRef.current !== op) { // the conversation moved on: the reset already cleared the screen, so only record the run
      const retry = await recordRun(ctx, model.name, outcome);
      if (retry) setUnsaved((u) => [...u, retry]);
      return;
    }
    abortRef.current = null;
    const reply = liveRef.current?.content ?? '';
    if (reply || stopped) setMessages((m) => [...m, { role: 'assistant', content: reply, stopped, quoted }]);
    liveRef.current = null;
    setLive(null);
    setLast(out);
    const retry = await recordRun(ctx, model.name, outcome);
    if (retry) setUnsaved((u) => [...u, retry]);
    if (!out.ok && !stopped) {
      setError(explain(out.error));
      if (['unreachable', 'disconnected'].includes(out.error.kind)) await probe();
    }
    ctx.refreshDetail();
  }

  return (
    <section className="ob-card" aria-labelledby="run-h">
      <div className="row-between" style={{ flexWrap: 'wrap' }}>
        <h2 id="run-h">Run</h2>
        <span className="ob-badge tile--green dev-location" aria-label="Execution location"><Icon name="lock" size={12} stroke={2.2} /> Running on: this computer · Ollama at {runtime.origin}</span>
      </div>
      <div className="dev-run-settings">
        <div className="ob-field">
          <label htmlFor="run-model">Model</label>
          <select id="run-model" value={selected} disabled={Boolean(busy)} aria-describedby={busy ? 'run-busy' : undefined} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Choose an installed model</option>
            {localModels.map((m) => <option key={m.name} value={m.name}>{m.name} · {gb(m.sizeBytes)}</option>)}
          </select>
        </div>
        <div className="ob-field">
          <label htmlFor="run-ctx">Context window</label>
          <select id="run-ctx" value={numCtx} disabled={Boolean(busy)} onChange={(e) => setNumCtx(Number(e.target.value))}>
            {ctxChoices.map((n) => <option key={n} value={n}>{n.toLocaleString()} tokens</option>)}
          </select>
        </div>
        <div className="ob-field">
          <label htmlFor="run-max">Max reply tokens</label>
          <input id="run-max" type="text" inputMode="numeric" value={numPredict} onChange={(e) => setNumPredict(e.target.value)} aria-invalid={!(Number.isInteger(predict) && predict >= 1 && predict <= 8192)} aria-describedby="run-limits" />
        </div>
        <div className="ob-field">
          <label htmlFor="run-temp">Temperature</label>
          <input id="run-temp" type="text" inputMode="decimal" value={temperature} onChange={(e) => setTemperature(e.target.value)} aria-invalid={!(temp >= 0 && temp <= 2)} aria-describedby="run-limits" />
        </div>
      </div>
      <p id="run-limits" className={limitsOk ? 'ob-muted' : 'ob-error'} style={{ fontSize: 12 }}>
        {limitsOk ? `Replies stop at ${predict.toLocaleString()} tokens. The conversation must fit in ${numCtx.toLocaleString()} tokens; older turns are cut by the runtime beyond that.` : 'Max reply tokens is a whole number from 1 to 8,192; temperature is from 0 to 2.'}
      </p>
      {info?.thinking && <label className="ob-check" style={{ fontSize: 14 }}><input type="checkbox" checked={think} onChange={(e) => setThink(e.target.checked)} /> Let the model reason before answering (slower; reasoning is shown, not saved)</label>}

      <div className="dev-chat" aria-live="polite" aria-busy={Boolean(live)}>
        {!model && <p className="ob-muted">Choose a model to start. Nothing is sent anywhere until you press Send.</p>}
        {messages.map((m, i) => (
          <p key={i} className={`dev-msg dev-msg--${m.role}`}>
            <span className="sr-only">{m.role === 'user' ? 'You' : 'Model'}: </span>{m.content}{m.stopped && <em className="ob-muted"> (stopped)</em>}
            {m.quoted?.length > 0 && <span className="mem-cited">Quoted with the question, as information: {m.quoted.map((q, n) => `[${n + 1}] ${q.title} (${q.kind})`).join(' · ')}. A [number] in the reply points at one of these; the model may also have ignored them.</span>}
          </p>
        ))}
        {live && (
          <div className="dev-msg dev-msg--assistant">
            {live.thinking && <p className="ob-muted" style={{ fontSize: 12.5 }}>{live.thinking}</p>}
            <p>{live.content || (live.thinking ? '' : 'Loading the model and starting…')}</p>
          </div>
        )}
      </div>
      {busy && <p id="run-busy" className="ob-muted" style={{ fontSize: 12 }}>The model can be changed when the current {busy === 'test' ? 'test' : 'reply'} finishes or is stopped.</p>}
      {error && <p className="ob-alert" role="alert">{error}{/memory/i.test(error) && ' Try a smaller model or context window, or unload other loaded models above.'}</p>}
      <UnsavedNotice retries={unsaved} onDone={setUnsaved} />
      {model && <ReferencePicker entry={ctx.entry} account={ctx.account} draft={draft} disabled={Boolean(busy)} onChange={setReferences} />}
      <form className="dev-compose" onSubmit={send}>
        <label htmlFor="run-input" className="sr-only">Message</label>
        <textarea id="run-input" rows={2} value={draft} disabled={!model} placeholder={model ? `Message ${model.name}` : 'Choose a model first'} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(e); }} />
        {live ? <button type="button" className="btn-ghost" onClick={() => abortRef.current?.abort()}><Icon name="pause" size={14} /> Stop</button>
          : <button type="submit" className="btn-app" disabled={!model || !draft.trim() || !limitsOk || Boolean(busy)}>Send</button>}
      </form>
      {last && <RunMetrics out={last} />}
    </section>
  );
}

function RunMetrics({ out }) {
  const m = out.metrics;
  const tps = m.outputTokens && m.evalMs ? m.outputTokens / (m.evalMs / 1000) : null;
  return (
    <div className="kpis" aria-label="Last run">
      <div className="kpi"><span>Start</span><span className="kpi-value">{out.warm ? 'Warm' : 'Cold'}</span><span className="ob-muted">{out.warm ? 'Model was already loaded' : `Loaded in ${num(m.loadMs)} ms (runtime)`}</span></div>
      <div className="kpi"><span>First token</span><span className="kpi-value">{num(m.ttftMs)} ms</span><span className="ob-muted">Measured by Valcairn</span></div>
      <div className="kpi"><span>Output speed</span><span className="kpi-value">{num(tps, 1)} tok/s</span><span className="ob-muted">{num(m.outputTokens)} tokens · runtime counters</span></div>
      <div className="kpi"><span>Total</span><span className="kpi-value">{num(m.wallMs)} ms</span><span className="ob-muted">Measured by Valcairn</span></div>
    </div>
  );
}

/* ---------------- Compatibility test ---------------- */

function TestCard({ ctx, localModels }) {
  const { local, selected, setSelected, installOf, saveInstall, busy, setBusy } = ctx;
  const model = localModels.find((m) => m.name === selected) ?? null;
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [unsaved, setUnsaved] = useState([]);
  const abortRef = useRef(null);
  const s = local.taskSettings;
  useEffect(() => () => abortRef.current?.abort(), []); // leaving the page stops the test

  async function run() {
    const controller = new AbortController();
    const { signal } = controller;
    const untilStopped = new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true })); // Stop never waits on a stalled read-back
    abortRef.current = controller;
    setRunning(true); setBusy('test'); setResults([]); setError(null);
    const { name, digest } = model;
    const out = [];
    const retries = [];
    try {
      const info = await ctx.runtime.show(name, { signal }).catch((err) => { if (err.kind === 'aborted') throw err; return null; });
      for (const task of local.tasks) {
        if (signal.aborted) break;
        const r = await timedChat(ctx, { model: name, messages: [{ role: 'user', content: task.prompt }], numCtx: s.numCtx, numPredict: s.numPredict, temperature: s.temperature, seed: s.seed, think: info?.thinking ? false : undefined, signal });
        const stopped = !r.ok && r.error.kind === 'aborted';
        const passed = r.ok && passesTask(task, r.result.content);
        out.push({ task, ...r, passed, stopped, reply: r.ok ? r.result.content.trim().slice(0, 80) : null });
        setResults([...out]);
        const retry = await recordRun(ctx, name, { kind: 'compat_test', warm: r.warm, status: r.ok ? 'completed' : stopped ? 'stopped' : 'failed', settings: r.settings, metrics: r.metrics, task: { id: task.id, passed }, failure: r.ok || stopped ? null : savedFailure(r.error) });
        if (retry) retries.push(retry);
        if (!r.ok) { if (!stopped) setError(explain(r.error)); break; }
      }
      const install = (await Promise.race([ctx.refreshDetail(), untilStopped]))?.installs.find((i) => i.runtimeRef === name) ?? installOf(name); // read back: a Verify that overlapped this test may have just changed its state
      // Ready means every task ran on this device without a runtime error, for exactly the bytes that were tested. Correctness is the score, shown separately.
      if (!signal.aborted && readyAfterTest(install, digest, out, local.tasks.length)) {
        await saveInstall({ runtimeRef: install.runtimeRef, catalogId: install.catalogId, digest: install.digest, sizeBytes: install.sizeBytes, details: install.details, state: 'ready' });
      } else if (!signal.aborted && out.every((r) => r.ok) && install?.digest && install.digest !== digest) setError('The model changed while it was being tested, so it was not marked Ready. Verify it again.');
    } catch (err) {
      if (err.kind !== 'aborted') setError(explain(err));
    } finally {
      abortRef.current = null;
      setUnsaved(retries);
      setRunning(false); setBusy(null);
      ctx.refreshDetail();
    }
  }

  const install = model && installOf(model.name);
  return (
    <section className="ob-card" aria-labelledby="test-h">
      <div className="row-between"><h2 id="test-h">Compatibility test</h2><span className="ob-muted" style={{ fontSize: 12 }}>{plural(local.tasks.length, 'task')} · temperature {s.temperature} · seed {s.seed}</span></div>
      <p className="ob-muted">Three short tasks with one right answer each, run with fixed settings so results compare across devices. They are sent only to Ollama on this computer. A verified model that runs all three without an error is marked Ready; how many it answered correctly is its score.</p>
      <div className="row-wrap gap-10">
        <select aria-label="Model to test" value={selected} disabled={Boolean(busy)} onChange={(e) => setSelected(e.target.value)} style={{ maxWidth: 320 }}>
          <option value="">Choose an installed model</option>
          {localModels.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
        {running ? <button type="button" className="btn-ghost" onClick={() => abortRef.current?.abort()}><Icon name="pause" size={14} /> Stop test</button>
          : <button type="button" className="btn-app" onClick={run} disabled={!model || Boolean(busy)}>Run the test</button>}
        {model && install && !['verified', 'ready'].includes(install.state) && <span className="ob-muted" style={{ fontSize: 12 }}>Verify the model first to mark it Ready.</span>}
      </div>
      {results.length > 0 && !running && <p role="status"><strong>Score: {results.filter((r) => r.passed).length} of {local.tasks.length} correct</strong>{results.some((r) => r.stopped) ? ' · stopped before it finished' : results.some((r) => !r.ok) ? ' · stopped by a runtime error' : results.length < local.tasks.length ? ' · stopped before it finished' : ' · ran without errors on this device'}</p>}
      <UnsavedNotice retries={unsaved} onDone={setUnsaved} />
      {results.length > 0 && (
        <div className="ob-table-wrap">
          <table>
            <thead><tr><th scope="col">Task</th><th scope="col">Expected</th><th scope="col">Reply</th><th scope="col">Result</th><th scope="col">Start</th><th scope="col">Total</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.task.id}>
                  <td>{r.task.id}</td><td><code>{r.task.answer}</code></td><td>{r.reply ?? '—'}</td>
                  <td>{r.passed ? <span className="ob-ok">Pass</span> : r.stopped ? <span className="ob-muted">Stopped</span> : <span className="tone-warn">Fail</span>}</td>
                  <td>{r.warm ? 'Warm' : 'Cold'}</td><td>{num(r.metrics.wallMs)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="ob-alert" role="alert">{error}</p>}
    </section>
  );
}

/* ---------------- History ---------------- */

function MeasurementsCard({ runs }) {
  return (
    <section className="ob-card" aria-labelledby="hist-h">
      <div className="row-between"><h2 id="hist-h">Measured on this device</h2><span className="ob-muted" style={{ fontSize: 12 }}>Client-reported · latest 50</span></div>
      {runs.length === 0 ? <p className="ob-muted">No runs yet. Results appear here after you run a model or the compatibility test.</p> : (
        <div className="ob-table-wrap">
          <table>
            <thead><tr><th scope="col">When</th><th scope="col">Model</th><th scope="col">Kind</th><th scope="col">Start</th><th scope="col">First token</th><th scope="col">Output</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.createdAt)}</td>
                  <td><div className="cell-stack"><span>{r.modelRef}</span><code className="ob-muted" style={{ fontSize: 11 }}>{short(r.modelDigest)}</code></div></td>
                  <td>{r.kind === 'compat_test' ? `Test · ${r.task?.id} ${r.task?.passed ? '✓' : '✗'}` : 'Chat'}</td>
                  <td>{r.warm ? 'Warm' : 'Cold'}</td>
                  <td>{r.metrics.ttftMs == null ? '—' : `${num(r.metrics.ttftMs)} ms`}</td>
                  <td>{r.metrics.tokensPerSec == null ? '—' : `${num(r.metrics.tokensPerSec, 1)} tok/s`}</td>
                  <td>{r.status === 'completed' ? 'Completed' : r.status === 'stopped' ? 'Stopped' : <span className="tone-warn" title={r.failure ?? ''}>Failed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DataNotice() {
  return (
    <details>
      <summary>What leaves this computer</summary>
      <div className="ob-muted" style={{ fontSize: 13.5, padding: '0 0 16px', display: 'grid', gap: 8 }}>
        <p><strong>Stays here:</strong> your prompts, the model’s replies, the models themselves. Requests go from this page straight to Ollama at 127.0.0.1 and never through Valcairn. If you choose passages from your memory, they go to Ollama with that one message and nowhere else; Valcairn does not learn which, or that you did.</p>
        <p><strong>Sent to Valcairn:</strong> this device’s name; Ollama’s version; the names, sizes and digests of installed models; the browser’s hardware hints; and for each run, the model, its settings, timings, token counts and, for the test, pass or fail. All of it is marked client-reported.</p>
        <p><strong>Downloads</strong> come from ollama.com when you choose one. Models marked as cloud in Ollama run on ollama.com, so Valcairn never calls them in local mode.</p>
        <p><strong>Offline:</strong> not claimed. Valcairn’s pages load from its server; running a model uses only this computer once the page is open.</p>
      </div>
    </details>
  );
}

function OtherDevices({ devices, onDisconnect }) {
  return (
    <section className="ob-card" aria-labelledby="others-h">
      <h2 id="others-h">Your other devices</h2>
      <ul className="ob-list">
        {devices.map((d) => (
          <li key={d.id} className="row-between">
            <span className="cell-stack"><strong>{d.label}</strong><span className="ob-muted" style={{ fontSize: 12 }}>Last seen {when(d.lastSeenAt)}</span></span>
            <button type="button" className="btn-text" onClick={() => onDisconnect(d.id)}>Disconnect</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
