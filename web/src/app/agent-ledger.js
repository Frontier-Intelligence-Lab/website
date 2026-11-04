// The local run ledger for agents: what a run was allowed to do, every step it took, the exact source text each
// step used, and the draft the person reviewed. It lives in this browser's IndexedDB, one database per workspace
// and person, unencrypted and without any key: the memory gateway key never enters it. A second backend keeps the
// same records in memory so the runner is tested without a browser.

export class LedgerError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// Store name → key fields (compound keys are arrays) and the one index each store is read by.
const STORES = {
  runs: { key: ['id'], index: 'scopeKey' },
  grants: { key: ['runId'], index: null },
  steps: { key: ['runId', 'stepIndex'], index: 'runId' },
  snapshots: { key: ['runId', 'noteId'], index: 'runId' },
  proposals: { key: ['id'], index: 'runId' },
};
const NAMES = Object.keys(STORES);
export const dbName = (workspaceId, userId) => `valcairn-agent.${workspaceId}.${userId}`;
export const scopeKeyOf = (workspaceId, userId) => `${workspaceId}.${userId}`;

/** Records kept in memory, copied on the way in and out like IndexedDB copies them. */
export function memoryBackend() {
  const tables = Object.fromEntries(NAMES.map((n) => [n, new Map()]));
  const keyOf = (name, value) => STORES[name].key.map((k) => value[k]).join('\u0000');
  const api = (name) => ({
    get: async (key) => structuredClone(tables[name].get([key].flat().join('\u0000')) ?? undefined),
    put: async (value) => { tables[name].set(keyOf(name, value), structuredClone(value)); },
    delete: async (key) => { tables[name].delete([key].flat().join('\u0000')); },
    all: async (index, value) => [...tables[name].values()].filter((v) => !index || v[index] === value).map((v) => structuredClone(v)),
    clear: async () => tables[name].clear(),
  });
  return { transact: (names, _mode, fn) => fn(Object.fromEntries(names.map((n) => [n, api(n)]))) };
}

const request = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/** The browser's IndexedDB. A refusal (private mode, storage off, quota) rejects here and is shown, never swallowed. */
export async function indexedDbBackend(name, idb = globalThis.indexedDB) {
  if (!idb) throw new LedgerError('no_storage', 'This browser offers no local database, so agent runs cannot be recorded here.');
  const open = idb.open(name, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const [store, { key, index }] of Object.entries(STORES)) {
      const os = db.createObjectStore(store, { keyPath: key.length === 1 ? key[0] : key });
      if (index) os.createIndex(index, index);
    }
  };
  let db;
  try { db = await request(open); } catch (err) { throw new LedgerError('storage_denied', `The local database could not be opened (${err?.name ?? 'error'}).`); }
  const wrap = (os) => ({
    get: (key) => request(os.get(key)),
    put: (value) => request(os.put(value)),
    delete: (key) => request(os.delete(key)),
    all: (index, value) => request(index ? os.index(index).getAll(value) : os.getAll()),
    clear: () => request(os.clear()),
  });
  return {
    // The callback may only await the requests it is given: a transaction commits as soon as nothing is pending.
    async transact(names, mode, fn) {
      const tx = db.transaction(names, mode);
      const done = new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new LedgerError('storage_failed', 'The local database aborted the write.')); tx.onerror = () => reject(tx.error); });
      let result;
      try { result = await fn(Object.fromEntries(names.map((n) => [n, wrap(tx.objectStore(n))]))); } catch (err) { try { tx.abort(); } catch { /* already finished */ } throw err; }
      await done;
      return result;
    },
    close: () => db.close(),
  };
}

export const sameScope = (a, b) => Boolean(a && b) && a.tenant_id === b.tenant_id && a.workspace_id === b.workspace_id && a.user_id === b.user_id;

/**
 * The ledger of one workspace and person. Every read filters by that scope key as well, so a run recorded for
 * someone else is never returned even if the same database were opened.
 */
export function openLedger({ scopeKey, backend }) {
  const tx = (names, mode, fn) => backend.transact(names, mode, fn);
  // A run is owned by one execution at a time. Every write of that execution first proves, inside the same
  // transaction, that the run still exists, is still running and still names this execution; otherwise the write
  // is refused. So a late result cannot overwrite Stop, resurrect a deleted history or land on another tab's run.
  const owned = async (runs, runId, executionId) => {
    const r = await runs.get(runId);
    if (!r || r.scopeKey !== scopeKey) throw new LedgerError('not_found', 'That run is no longer in this ledger.');
    if (r.status !== 'running' || r.executionId !== executionId) throw new LedgerError('superseded', `That run is ${r.status} and no longer owned by this execution.`);
    return r;
  };
  const ledger = {
    scopeKey,
    runs: () => tx(['runs'], 'readonly', ({ runs }) => runs.all('scopeKey', scopeKey)).then((list) => list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))),
    run: (id) => tx(['runs'], 'readonly', ({ runs }) => runs.get(id)).then((r) => (r?.scopeKey === scopeKey ? r : null)),
    createRun: (run) => tx(['runs'], 'readwrite', ({ runs }) => runs.put({ ...run, scopeKey, revision: 0 })).then(() => ({ ...run, scopeKey, revision: 0 })),
    /** Applies a patch to the stored run inside one transaction and returns the new record. Every run write bumps `revision`. */
    updateRun: (id, patch) => tx(['runs'], 'readwrite', async ({ runs }) => {
      const current = await runs.get(id);
      if (current?.scopeKey !== scopeKey) throw new LedgerError('not_found', 'That run is not in this ledger.');
      const next = { ...current, ...patch, revision: (current.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      await runs.put(next);
      return next;
    }),
    /**
     * A conditional write for a run that is not executing (a preflight outcome): lands only if the run is still
     * exactly the revision that was validated, so it can never overwrite a concurrent Stop, deletion or other change.
     */
    settle: (id, expectedRevision, patch) => tx(['runs'], 'readwrite', async ({ runs }) => {
      const current = await runs.get(id);
      if (!current || current.scopeKey !== scopeKey) throw new LedgerError('not_found', 'That run is no longer in this ledger.');
      if (current.revision !== expectedRevision || current.status === 'running') throw new LedgerError('superseded', `That run changed meanwhile (${current.status}).`);
      const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      await runs.put(next);
      return next;
    }),
    grant: (runId) => tx(['grants'], 'readonly', ({ grants }) => grants.get(runId)).then((g) => g ?? null),
    putGrant: (grant) => tx(['grants'], 'readwrite', ({ grants }) => grants.put(grant)).then(() => grant),
    steps: (runId) => tx(['steps'], 'readonly', ({ steps }) => steps.all('runId', runId)).then((list) => list.sort((a, b) => a.stepIndex - b.stepIndex)),
    snapshots: (runId) => tx(['snapshots'], 'readonly', ({ snapshots }) => snapshots.all('runId', runId)),
    proposal: (runId) => tx(['proposals'], 'readonly', ({ proposals }) => proposals.all('runId', runId)).then((list) => list[0] ?? null),
    // Unguarded writers for fixtures and repairs only. An execution never uses them: see `execution()`.
    putStep: (step) => tx(['steps'], 'readwrite', ({ steps }) => steps.put(step)).then(() => step),
    putSnapshot: (snapshot) => tx(['snapshots'], 'readwrite', ({ snapshots }) => snapshots.put(snapshot)).then(() => snapshot),
    putProposal: (proposal) => tx(['proposals'], 'readwrite', ({ proposals }) => proposals.put(proposal)).then(() => proposal),
    /**
     * The one atomic way a run starts executing: inside a single transaction the current run and grant are read,
     * `check` validates them (synchronously, from current records, never from a tab's earlier view) and the run
     * becomes `running` under a fresh execution id. `check` returns the patch to apply or throws.
     */
    beginExecution: (runId, check, expectedRevision = null) => tx(['runs', 'grants'], 'readwrite', async ({ runs, grants }) => {
      const run = await runs.get(runId);
      if (!run || run.scopeKey !== scopeKey) throw new LedgerError('not_found', 'That run is no longer in this ledger.');
      if (expectedRevision !== null && run.revision !== expectedRevision) throw new LedgerError('superseded', `That run changed meanwhile (${run.status}).`);
      const grant = (await grants.get(runId)) ?? null;
      const executionId = crypto.randomUUID();
      const next = { ...run, ...check(run, grant), status: 'running', executionId, executions: (run.executions ?? 0) + 1, revision: (run.revision ?? 0) + 1, startedAt: run.startedAt ?? new Date().toISOString(), failure: null, updatedAt: new Date().toISOString() };
      await runs.put(next);
      return { run: next, grant, executionId };
    }),
    /** The guarded writers of one execution; each refuses once the run is gone, finished, stopped or taken over. */
    execution: (runId, executionId) => ({
      putStep: (step) => tx(['runs', 'steps'], 'readwrite', async ({ runs, steps }) => { await owned(runs, runId, executionId); await steps.put(step); return step; }),
      /** A snapshot is written once; the text a step used is never replaced by newer text. */
      putSnapshot: (snapshot) => tx(['runs', 'snapshots'], 'readwrite', async ({ runs, snapshots }) => {
        await owned(runs, runId, executionId);
        const existing = await snapshots.get([snapshot.runId, snapshot.noteId]);
        if (!existing) await snapshots.put(snapshot);
        return existing ?? snapshot;
      }),
      putProposal: (proposal) => tx(['runs', 'proposals'], 'readwrite', async ({ runs, proposals }) => { await owned(runs, runId, executionId); await proposals.put(proposal); return proposal; }),
      /** The terminal transition: compare-and-set from running under this execution to the final status. */
      finish: (patch) => tx(['runs'], 'readwrite', async ({ runs }) => {
        const run = await owned(runs, runId, executionId);
        const next = { ...run, ...patch, revision: (run.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
        await runs.put(next);
        return next;
      }),
    }),
    /**
     * Keep local draft: one transaction keyed by the proposal id and the hash of the exact text reviewed. A second
     * click, or a retry after reload, returns the one accepted record; a different hash is refused. `checkedAt`
     * records when the sources were last read back from the gateway before this acceptance. `cancelled` is asked
     * once more inside the transaction, right before the write is dispatched: a cancellation seen there aborts the
     * transaction and the draft stays pending. Dispatching the write is the point of no return: a cancellation that
     * arrives while it is pending does not undo it, and the draft is kept.
     */
    acceptProposal: ({ id, outputHash, checkedAt = null, cancelled = () => false }) => tx(['proposals'], 'readwrite', async ({ proposals }) => {
      const p = await proposals.get(id);
      if (!p) throw new LedgerError('not_found', 'That draft is not in this ledger.');
      if (p.outputHash !== outputHash) throw new LedgerError('hash_mismatch', 'The draft changed since it was reviewed, so it was not kept.');
      if (p.state === 'accepted') return { proposal: p, already: true };
      if (p.state === 'rejected') throw new LedgerError('rejected', 'That draft was discarded.');
      if (cancelled()) throw new LedgerError('cancelled', 'Keep was cancelled before the draft was stored, so it stays pending.');
      const accepted = { ...p, state: 'accepted', acceptedAt: new Date().toISOString(), sourcesCheckedAt: checkedAt };
      await proposals.put(accepted);
      return { proposal: accepted, already: false };
    }),
    rejectProposal: (id) => tx(['proposals'], 'readwrite', async ({ proposals }) => {
      const p = await proposals.get(id);
      if (!p) throw new LedgerError('not_found', 'That draft is not in this ledger.');
      if (p.state !== 'pending') return p;
      const rejected = { ...p, state: 'rejected', rejectedAt: new Date().toISOString() };
      await proposals.put(rejected);
      return rejected;
    }),
    /**
     * After a reload, a run still marked running that no tab is executing was cut off: it becomes interrupted, and
     * so does its unfinished step. Each run is marked only while holding its own lock, so a tab that is executing
     * it (and therefore holds that lock) can never be marked under its feet. Nothing resumes by itself.
     */
    markInterrupted: async (locks = globalThis.navigator?.locks) => {
      let marked = 0;
      for (const run of (await ledger.runs()).filter((r) => r.status === 'running')) {
        await withRunLock(run.id, async () => {
          const open = (await ledger.steps(run.id)).find((s) => s.state === 'pending');
          await tx(['runs', 'steps'], 'readwrite', async ({ runs, steps }) => {
            const r = await runs.get(run.id);
            if (r?.scopeKey !== scopeKey || r.status !== 'running') return;
            if (open) await steps.put({ ...open, state: 'interrupted', endedAt: new Date().toISOString() });
            await runs.put({ ...r, status: 'interrupted', revision: (r.revision ?? 0) + 1, updatedAt: new Date().toISOString() });
            marked += 1;
          });
        }, locks).catch((err) => { if (err?.kind !== 'busy') throw err; }); // busy: a tab is executing it right now
      }
      return marked;
    },
    /** Delete history: every record of this ledger. Notes in the memory store are untouched. Callers hold the ledger lock exclusively. */
    clear: () => tx(NAMES, 'readwrite', async (stores) => { for (const n of NAMES) await stores[n].clear(); }),
  };
  return ledger;
}

const LOCK_PREFIX = 'valcairn-agent-run:';
const LEDGER_PREFIX = 'valcairn-agent-ledger:';
const noLocks = () => new LedgerError('no_locks', 'This browser cannot lock a run across tabs, so agent runs do not start here.');

/**
 * Runs `fn` while holding this browser's exclusive lock for the run, across every tab of this site. Without Web
 * Locks nothing executes: a second runner could not be ruled out, so the answer is no rather than maybe.
 */
export async function withRunLock(runId, fn, locks = globalThis.navigator?.locks) {
  if (!locks?.request) throw noLocks();
  return locks.request(`${LOCK_PREFIX}${runId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new LedgerError('busy', 'This run is already executing in another tab of this browser.');
    return fn();
  });
}

/**
 * The lock of one person's ledger in this browser. Executions hold it shared for their whole duration; Delete
 * history takes it exclusively, so deletion is refused while any tab executes a run, and no run can start while
 * history is being deleted. Both sides ask without waiting: a refusal is reported, never queued.
 */
export async function withLedgerLock(scopeKey, mode, fn, locks = globalThis.navigator?.locks) {
  if (!locks?.request) throw noLocks();
  return locks.request(`${LEDGER_PREFIX}${scopeKey}`, { mode, ifAvailable: true }, async (lock) => {
    if (!lock) throw new LedgerError(mode === 'exclusive' ? 'ledger_busy' : 'ledger_clearing', mode === 'exclusive' ? 'A run is executing in this browser, maybe in another tab. Stop it or let it finish, then delete history.' : 'History is being deleted in another tab; try again in a moment.');
    return fn();
  });
}
