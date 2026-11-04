// Seeds a clearly labelled synthetic workspace that is ready to train on a Valcairn Runner, for local demos.
//
//   node --env-file-if-exists=.env scripts/seed-train-demo.js --model <catalog id> --objects <ingest storage dir>
//
// Creates (or reuses) a demo owner with a confirmed email and a freshly generated password, shown once; a project
// whose rights record allows training; one synthetic JSONL file of 252 support conversations for a fictional
// company, stored where a local ingest service with INGEST_STORAGE=file://<dir> keeps committed objects; an
// approved dataset version; a model pull; and an enhance plan approved to run on "Your Valcairn Runner".
// Approval is recorded as a separate synthetic staff account. Nothing here is real customer data.
// Refuses to run with NODE_ENV=production.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hashPassword } from '../src/lib/passwords.js';
import { createStore } from '../src/store/index.js';
import { loadConfig } from '../src/config.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const modelId = arg('--model');
const objects = arg('--objects') ? resolve(arg('--objects')) : null;
if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed demo data with NODE_ENV=production.'); process.exit(2); }
const config = loadConfig();
if (!modelId || !config.modelCatalog.some((m) => m.id === modelId)) {
  console.error(`Pass --model with a model id from MODEL_CATALOG_FILE (${config.modelCatalog.map((m) => m.id).join(', ') || 'the catalog is empty'}).`);
  process.exit(2);
}
if (!objects) { console.error('Pass --objects with the directory your local ingest service uses (INGEST_STORAGE=file://<dir>).'); process.exit(2); }

// Deterministic synthetic conversations: three fictional robots and four kinds of question.
function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); }
const next = rng(7);
const pick = (list) => list[Math.floor(next() * list.length)];
const PRODUCTS = {
  'Courier C2': { battery: '9 hours', payload: 12, warranty: '24 months', reset: 'hold the blue button for 8 seconds' },
  'Scout S1': { battery: '6 hours', payload: 3, warranty: '12 months', reset: 'hold the power and dock buttons together for 5 seconds' },
  'Hauler H4': { battery: '11 hours', payload: 40, warranty: '36 months', reset: 'turn the key to SERVICE and back twice' },
};
const NAMES = ['Priya', 'Marcus', 'Lena', 'Tomás', 'Aiko', 'Sam', 'Nadia', 'Owen', 'Grace', 'Ravi'];
const QUESTIONS = {
  battery: ['How long does the {p} battery last?', "What's the runtime on a full charge for the {p}?", 'My {p} dies quickly, how long should a charge last?'],
  payload: ['How much can the {p} carry?', "What's the max payload for the {p}?", 'Can the {p} carry {n} kg?'],
  warranty: ['What warranty comes with the {p}?', 'Is my {p} still under warranty after a year?', 'How long is the {p} covered?'],
  reset: ['How do I reset my {p}?', 'The {p} is frozen, how do I restart it?', "What's the factory reset for a {p}?"],
};
const answer = (name, product, topic, f, n, asksWeight) => {
  const body = {
    battery: `A fully charged ${product} runs for about ${f.battery} of normal use.`,
    payload: `The ${product} carries up to ${f.payload} kg.${asksWeight ? (n <= f.payload ? ` ${n} kg is within that limit.` : ` ${n} kg is over that limit, so split the load.`) : ''}`,
    warranty: `Every ${product} comes with a ${f.warranty} Acme Care warranty from the delivery date.`,
    reset: `To reset the ${product}, ${f.reset}. It restarts in about a minute.`,
  }[topic];
  return `Hi ${name}, thanks for reaching out to Acme Robotics support. ${body} If that doesn't help, reply with your unit's serial number and we'll take it from there. – Acme Support`;
};
const rows = [];
for (const [product, facts] of Object.entries(PRODUCTS)) {
  for (const [topic, templates] of Object.entries(QUESTIONS)) {
    for (const template of templates) {
      for (let i = 0; i < 7; i += 1) {
        const name = pick(NAMES), n = pick([2, 5, 10, 15, 30, 45]);
        rows.push({ messages: [
          { role: 'system', content: 'You are the Acme Robotics support assistant.' },
          { role: 'user', content: `${template.replace('{p}', product).replace('{n}', n)} - ${name}` },
          { role: 'assistant', content: answer(name, product, topic, facts, n, template.includes('{n}')) },
        ] });
      }
    }
  }
}
const bytes = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const store = await createStore(config);
if (!store) { console.error('No store: set DATABASE_URL.'); process.exit(2); }
const password = randomBytes(12).toString('base64url');
const ownerEmail = 'train.owner@acme-demo.example';
let owner = (await store.getUserAuthByEmail(ownerEmail))?.user;
const created = !owner;
owner ??= await store.createUser({ email: ownerEmail, name: 'Demo Owner (synthetic)', passwordHash: await hashPassword(password) });
await store.setEmailVerified(owner.id);
const staffEmail = 'train.reviewer@valcairn.example';
const staff = (await store.getUserAuthByEmail(staffEmail))?.user ?? await store.createUser({ email: staffEmail, name: 'Valcairn Reviewer (synthetic)', passwordHash: await hashPassword(randomBytes(12).toString('base64url')) });
const stamp = Date.now().toString(36).slice(-5);
const ws = await store.createWorkspace({ kind: 'organization', name: `Acme Robotics (synthetic demo ${stamp})`, slug: `acme-demo-${stamp}`, ownerId: owner.id });
const project = await store.createProject({ workspaceId: ws.id, createdBy: owner.id, name: 'Support replies (synthetic)', task: 'Answer customer questions about Acme robots with the right facts, in the support team’s format.', modalities: ['Text'], startingPoint: 'own' });
const where = { workspaceId: ws.id, projectId: project.id };
await store.updateProject({ ...where, patch: { success: { measure: 'held-out answer accuracy', target: 'better than the base model' }, dataSource: { mode: 'upload', provenance: 'ours', allowedUses: ['training', 'testing'], personalData: 'no' } } });
// Committed-object layout of services/ingest (ws/<workspace>/projects/<project>/uploads/<uuid>).
const objectKey = `ws/${ws.id}/projects/${project.id}/uploads/${randomUUID()}`;
mkdirSync(dirname(join(objects, objectKey)), { recursive: true });
writeFileSync(join(objects, objectKey), bytes);
await store.createUpload({ ...where, uploadedBy: owner.id, objectKey, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, contentType: 'application/jsonl', filename: 'acme-support.synthetic.jsonl' });
const review = await store.submitForReview({ ...where, submittedBy: owner.id });
await store.decideReview({ reviewId: review.id, reviewerId: staff.id, decision: 'approved', checks: {} });
const version = await store.createDatasetVersion({ ...where, createdBy: owner.id });
await store.requestModelPull({ workspaceId: ws.id, modelId, requestedBy: owner.id });
const draft = await store.createEnhanceRun({ workspaceId: ws.id, createdBy: owner.id, run: { name: 'Support replies (synthetic)', baseModelId: modelId, datasets: [{ projectId: project.id, version: version.number }], steps: ['sft'], compute: 'runner', spendCapUsd: 1 } });
await store.requestEnhanceRun({ workspaceId: ws.id, runId: draft.id, requestedBy: owner.id, expectedUpdatedAt: draft.updatedAt });
await store.close?.();

console.log(`Workspace: /w/${ws.slug}/compute   (${rows.length} synthetic conversations, dataset version ${version.number}, plan approved for your runner)`);
console.log(`Owner: ${ownerEmail}`);
console.log(created ? `Password (shown once): ${password}` : 'Existing account: sign in with the password shown when it was created.');
