// Import the existing Frontier AI labs catalog into one local research project.
// Default is a dry run. Refuses production, a non-loopback host, and a database whose name
// does not have a "test" name component. Does not fetch pages. Does not invent investor rows.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createStore } from '../src/store/index.js';
import { recordsFromLabsCatalog, templateDraft, emptyChecklist } from '../src/lib/research.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const apply = args.includes('--apply');
const environment = flag('--environment');
const workspaceId = flag('--workspace');
const projectId = flag('--project');
const catalogPath = flag('--catalog') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'frontier-ai-labs-seed.json');

function refuse(message) {
  console.error(message);
  process.exitCode = 2;
}

if (args.includes('--retrieve')) {
  refuse('Bootstrap does not fetch pages. Start a research run on specific https URLs. --retrieve was not executed.');
} else if (!['local', 'test'].includes(environment)) {
  refuse('Pass --environment local or --environment test.');
} else if (!/^[0-9a-f-]{36}$/i.test(workspaceId ?? '')) {
  refuse('Pass --workspace with the workspace UUID.');
} else if ((process.env.NODE_ENV ?? 'development') === 'production') {
  refuse('Refusing to run while NODE_ENV is production.');
} else {
  let database;
  let refusal;
  try {
    // pg understands routing and session parameters in the URL, and its native driver also obeys libpq's
    // environment. Refuse those before config, store creation or any network call, not just a displayed host.
    database = new URL(process.env.DATABASE_URL ?? '');
    const name = decodeURIComponent(database.pathname.slice(1));
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.username
      || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname.toLowerCase())
      || !/^\d{1,5}$/.test(database.port) || Number(database.port) < 1 || Number(database.port) > 65535
      || database.search || database.hash || !/^[a-z0-9_]{1,63}$/.test(name) || !/(^|_)test(_|$)/.test(name)) {
      refusal = 'DATABASE_URL must name a loopback PostgreSQL, explicit port and lowercase test database, with no query or fragment.';
    }
    if (Object.entries(process.env).some(([key, value]) => value && (/^PG[A-Z_]/i.test(key) || /^NODE_PG_FORCE_NATIVE$/i.test(key)))) {
      refusal = 'Refusing ambient PG or native-driver overrides. Remove them before running the local bootstrap.';
    }
  } catch {
    refusal = 'DATABASE_URL is required and must name an explicit local PostgreSQL test database.';
  }
  if (refusal) refuse(refusal);
  else {
    const rows = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const records = recordsFromLabsCatalog(rows);
    if (!apply && !projectId) {
      console.log(JSON.stringify({ environment, workspaceId, projectId: null, dryRun: true, records: records.length, investors: 0, note: 'No project was created. Pass --project to preview against one, or --apply to create a collection project and import.' }));
    } else {
      // A verified, nonempty database URL is mandatory: the non-production memory fallback is never an import target.
      const config = loadConfig({ ...process.env, DATABASE_URL: database.href });
      const store = await createStore(config, console);
      try {
        const members = await store.listMembers(workspaceId);
        const owner = members.find((member) => member.role === 'owner');
        if (!owner) throw new Error('That workspace has no owner, or it does not exist.');
        let target = projectId;
        if (!target) {
          const draft = templateDraft('collection', '');
          const created = await store.createResearchProject({ workspaceId, createdBy: owner.user.id, template: 'collection', name: draft.name, brief: draft.brief, question: draft.question, checklist: emptyChecklist() });
          target = created.id;
        }
        const summary = await store.importResearchRecords({ workspaceId, projectId: target, actorId: owner.user.id, records, dryRun: !apply });
        console.log(JSON.stringify({ environment, workspaceId, projectId: target, dryRun: !apply, summary }));
      } catch (err) {
        console.error(err.message || 'Import failed.');
        process.exitCode = 1;
      } finally {
        await store.close();
      }
    }
  }
}
