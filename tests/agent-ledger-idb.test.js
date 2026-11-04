import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { LedgerError, indexedDbBackend, openLedger } from '../web/src/app/agent-ledger.js';
import { newGrant, newRun } from '../web/src/app/agent.js';

// The ledger's IndexedDB backend, driven through a stand-in for the browser's event model. This is not a browser:
// it reproduces only what the backend relies on (requests answer in later tasks, a transaction commits once no
// request is pending, abort() and a failed request roll the stores back and fire `onabort` later, `error` is null
// after an explicit abort) so the completion lifecycle can be tested in Node. Root's real two-tab console check
// remains the proof for the browser itself.
const SCOPE = { tenant_id: 'qa-tenant', workspace_id: 'ws-1', user_id: 'user-1' };
// A model identity generated for this test run: the ledger only stores it, and no real tag is named anywhere.
const MODEL = { name: `qa-fixture-${randomBytes(4).toString('hex')}:test`, digest: randomBytes(32).toString('hex'), thinking: false };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const domError = (name) => Object.assign(new Error(`${name} (stand-in)`), { name });

/** `faults.put(store, value)` fails that request; `faults.commit()` returns an error to fail the commit; `faults.holdCommit` delays `oncomplete`. `stats.commits` counts read-write commits. */
function fakeIndexedDb(faults) {
  const stats = { commits: 0, aborts: 0 };
  const stores = new Map(); // name → { keyPath, rows }
  const keyText = (key) => [key].flat().join('\u0000');
  const keyOf = (keyPath, value) => [keyPath].flat().map((k) => value[k]).join('\u0000');
  const db = {
    createObjectStore: (name, { keyPath }) => { stores.set(name, { keyPath, rows: new Map() }); return { createIndex: () => {} }; },
    close: () => {},
    transaction: (names, mode) => {
      const tx = { error: null, oncomplete: null, onabort: null, onerror: null };
      const before = new Map(names.map((n) => [n, new Map(stores.get(n).rows)]));
      let pending = 0; let finished = false;
      const end = (error) => {
        if (finished) return;
        finished = true;
        if (error === undefined) { if (mode === 'readwrite') stats.commits++; setTimeout(async () => { await faults.holdCommit; tx.oncomplete?.(); }, 0); return; }
        for (const [n, rows] of before) stores.get(n).rows = rows;
        tx.error = error; stats.aborts++;
        setTimeout(() => tx.onabort?.(), 0);
      };
      tx.abort = () => { if (finished) throw domError('InvalidStateError'); end(null); };
      const request = (perform) => {
        if (finished) throw domError('TransactionInactiveError');
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        pending++;
        setTimeout(() => {
          pending--;
          try { req.result = perform(); } catch (err) { req.error = err; req.onerror?.(); tx.error = err; tx.onerror?.(); end(err); return; }
          req.onsuccess?.();
          // The browser commits once the success event and the microtasks after it queued nothing more.
          setTimeout(() => { if (!pending && !finished) end(faults.commit?.()); }, 0);
        }, 0);
        return req;
      };
      tx.objectStore = (name) => {
        const s = stores.get(name);
        const all = (filter) => request(() => [...s.rows.values()].filter(filter).map((v) => structuredClone(v)));
        return {
          get: (key) => request(() => structuredClone(s.rows.get(keyText(key)))),
          put: (value) => request(() => { if (faults.put?.(name, value)) throw domError('QuotaExceededError'); s.rows.set(keyOf(s.keyPath, value), structuredClone(value)); return keyOf(s.keyPath, value); }),
          delete: (key) => request(() => { s.rows.delete(keyText(key)); }),
          getAll: () => all(() => true),
          clear: () => request(() => { s.rows = new Map(); }),
          index: (field) => ({ getAll: (value) => all((v) => v[field] === value) }),
        };
      };
      return tx;
    },
  };
  return {
    stats,
    open: () => {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => { req.result = db; req.onupgradeneeded?.(); req.onsuccess?.(); }, 0);
      return req;
    },
  };
}

test('IndexedDB completion lifecycle (event-model stand-in): a refused stale Approve or Decline rejects once with its own kind and leaves no unhandled abort rejection; a failed request and a failed commit still surface after rollback; a successful write waits for the commit', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const faults = { put: null, commit: null, holdCommit: null };
  const idb = fakeIndexedDb(faults);
  const backend = await indexedDbBackend('valcairn-agent.test', idb);
  t.after(() => backend.close());
  const ledger = openLedger({ scopeKey: 'ws-1.user-1', backend });
  const fresh = async () => ledger.createRun(await newRun({ scope: SCOPE, scopeKey: ledger.scopeKey, model: MODEL, question: 'q', gateway: 'http://127.0.0.1:9', runtime: 'http://127.0.0.1:8' }));

  // A current approval commits the grant and the run together.
  const draft = await fresh();
  const { run: approved } = await ledger.approveDraft(draft.id, draft.revision, newGrant);
  assert.deepEqual([approved.status, approved.revision, (await ledger.grant(draft.id)).runId, idb.stats.commits, idb.stats.aborts], ['approved', 1, draft.id, 2, 0]);

  // The stale screen's Approve and Decline, then a stale Approve of a declined draft: each rejects exactly once with
  // the refusal the page shows; the aborted transaction is settled, so the abort's own rejection never escapes.
  const stale = await Promise.allSettled([ledger.approveDraft(draft.id, draft.revision, newGrant), ledger.declineDraft(draft.id, draft.revision)]);
  assert.deepEqual(stale.map((o) => [o.status, o.reason instanceof LedgerError, o.reason?.kind]), [['rejected', true, 'not_draft'], ['rejected', true, 'not_draft']]);
  const second = await fresh();
  const declined = await ledger.declineDraft(second.id, second.revision);
  await assert.rejects(ledger.approveDraft(second.id, second.revision, newGrant), (e) => e instanceof LedgerError && e.kind === 'stale');
  await tick(20); // abort events fire in later tasks; an unobserved rejection would have been reported by now
  assert.deepEqual(unhandled.map((e) => e?.message), [], 'no "The local database aborted the write." escapes the refusal');
  assert.equal(idb.stats.aborts, 3, 'each refusal aborted and settled its transaction');
  assert.deepEqual([(await ledger.run(draft.id)).revision, (await ledger.grant(draft.id)).runId, (await ledger.run(second.id)).revision, await ledger.grant(second.id)], [1, draft.id, declined.revision, null], 'the refusals changed nothing');

  // A request that the browser fails (quota) during approval: the caller sees that request's own error, the grant
  // written just before it is rolled back with the transaction, and nothing is left unhandled.
  const third = await fresh();
  faults.put = (store) => store === 'runs';
  await assert.rejects(ledger.approveDraft(third.id, third.revision, newGrant), (e) => e.name === 'QuotaExceededError');
  faults.put = null;
  await tick(20);
  assert.deepEqual([unhandled, await ledger.grant(third.id), (await ledger.run(third.id)).status, idb.stats.aborts], [[], null, 'draft', 4]);
  assert.equal((await ledger.approveDraft(third.id, third.revision, newGrant)).run.status, 'approved', 'the draft is still approvable once storage works again');

  // A failure reported at commit time, after the callback finished, still rejects the write; nothing pretends it landed.
  const fourth = await newRun({ scope: SCOPE, scopeKey: ledger.scopeKey, model: MODEL, question: 'q', gateway: 'http://127.0.0.1:9', runtime: 'http://127.0.0.1:8' });
  faults.commit = () => domError('QuotaExceededError');
  await assert.rejects(ledger.createRun(fourth), (e) => e.name === 'QuotaExceededError');
  faults.commit = null;
  assert.equal(await ledger.run(fourth.id), null);

  // A successful write resolves only after the browser reports the commit.
  let release;
  faults.holdCommit = new Promise((r) => { release = r; });
  let settled = false;
  const writing = ledger.createRun(fourth).then((r) => { settled = true; return r; });
  await tick(20);
  assert.equal(settled, false, 'still waiting for oncomplete');
  release();
  assert.equal((await writing).id, fourth.id);
  faults.holdCommit = null;
  assert.equal((await ledger.run(fourth.id)).id, fourth.id);
  await tick(20);
  assert.deepEqual(unhandled, [], 'nothing escaped anywhere in the lifecycle');
});
