import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidatesFromPages, planImport, recordsFromLabsCatalog, reportFromPages, spreadsheetCell, toCsv, validateRecord } from '../src/lib/research.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const labs = JSON.parse(readFileSync(path.join(root, 'data', 'frontier-ai-labs-seed.json'), 'utf8'));

const record = (extra = {}) => ({
  externalKey: 'catalog:organization:example',
  kind: 'organization',
  name: 'Example Lab',
  directory: 'companies',
  source: { url: 'https://example.com/research', publisher: 'Example', title: 'Example Lab', status: 'catalog', excerpt: 'Example Lab' },
  claims: [{ field: 'name', value: 'Example Lab', status: 'extracted', method: 'existing_catalog', excerpt: 'Example Lab' }],
  ...extra,
});

test('the labs catalog is the existing company list, and every row has a public https URL', () => {
  assert.equal(labs.length, 62);
  assert.equal(JSON.stringify(labs).includes('Atlas'), false);
  const records = recordsFromLabsCatalog(labs);
  assert.equal(records.length, 62);
  assert.equal(records.every((row) => row.directory === 'companies' && row.claims.every((claim) => claim.status === 'extracted' && claim.method === 'existing_catalog')), true);
  assert.equal(records[0].source.url.startsWith('catalog://frontier-ai-labs-seed/'), true);
  assert.throws(() => recordsFromLabsCatalog([{ lab: 'Missing URL' }]), /official_url/);
});

test('a prospect without a curator is refused, and conflicting is assigned by the planner', () => {
  assert.match(validateRecord(record({ directory: 'prospects' })), /Prospects/);
  assert.equal(validateRecord(record({ directory: 'prospects', curated: true })), null);
  assert.match(validateRecord(record({ claims: [{ field: 'name', value: 'Example Lab', status: 'conflicting', method: 'human', excerpt: 'Example Lab' }] })), /conflicting/);
});

test('the same name with a different key is a duplicate, and a different value stays conflicting', () => {
  const first = planImport({ sources: [], entities: [], claims: [] }, [record()]);
  const graph = {
    sources: first.ops.sources.map((row) => ({ ...row, id: 's1' })),
    entities: first.ops.entities.map((row) => ({ ...row, id: 'e1' })),
    claims: first.ops.claims.map((row) => ({ ...row, id: 'c1' })),
  };
  const again = planImport(graph, [record({ claims: [{ field: 'name', value: 'Other name', status: 'extracted', method: 'existing_catalog', excerpt: 'Other name' }] })]);
  assert.equal(again.summary.conflicts, 1);
  assert.equal(again.ops.claims[0].status, 'conflicting');
  const twin = planImport(graph, [record({ externalKey: 'catalog:organization:example-2', name: 'Example Lab' })]);
  assert.equal(twin.summary.duplicates, 1);
  const pasted = planImport({ sources: [], entities: [], claims: [] }, [record({ source: { url: 'https://example.com/lab', publisher: 'Example', title: 'Example Lab', status: 'inaccessible', failure: 'not fetched', excerpt: 'Example Lab' } })]);
  const upgraded = planImport({
    sources: pasted.ops.sources.map((row) => ({ ...row, id: 's1', status: 'inaccessible' })),
    entities: pasted.ops.entities.map((row) => ({ ...row, id: 'e1' })),
    claims: [],
  }, [record({ source: { url: 'https://example.com/lab', publisher: 'Example', title: 'Example Lab', status: 'retrieved', excerpt: 'Quoted fact.', sha256: 'a'.repeat(64), retrievedAt: '2026-11-05T00:00:00.000Z' } })]);
  assert.equal(upgraded.ops.sources.length, 1);
  assert.equal(upgraded.ops.sources[0].status, 'retrieved');
  assert.notEqual(upgraded.ops.sources[0].versionKey, pasted.ops.sources[0].versionKey);
  const kept = planImport({
    sources: [{ ...upgraded.ops.sources[0], id: 's1' }],
    entities: [{ id: 'e1', externalKey: 'catalog:organization:example', kind: 'organization', name: 'Example Lab' }],
    claims: [],
  }, [record({ source: { url: 'https://example.com/lab', publisher: 'Example', title: 'Example Lab', status: 'inaccessible', failure: 'paste', excerpt: 'Example Lab' } })]);
  assert.equal(kept.ops.sources.length, 1);
  assert.equal(kept.ops.sources[0].status, 'inaccessible');
  assert.equal(upgraded.ops.sources[0].status, 'retrieved');
});

test('spreadsheet cells that start like formulas are prefixed, and unquoted excerpts are not cited', () => {
  assert.equal(spreadsheetCell('=1+1'), "'=1+1");
  assert.equal(spreadsheetCell('+1'), "'+1");
  assert.equal(spreadsheetCell('safe'), 'safe');
  const csv = toCsv([{ directory: 'companies', kind: 'organization', name: 'Lab', field: 'name', value: '=cmd', claim_status: 'extracted', source_url: 'https://example.com', source_status: 'catalog', retrieved_at: '', excerpt: 'Lab' }]);
  assert.match(csv, /"'=cmd"/);
  const pages = [
    { status: 'retrieved', url: 'https://example.com/a', text: 'Quoted fact.', excerpt: 'Quoted fact.', title: 'A', sha256: 'a'.repeat(64), retrievedAt: '2026-01-01T00:00:00.000Z' },
    { status: 'retrieved', url: 'https://example.com/b', text: 'Other text.', excerpt: 'Not in the page.', title: 'B', sha256: 'b'.repeat(64), retrievedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const report = reportFromPages({ question: 'What does the page say?', pages });
  assert.equal(report.findings.length, 1);
  assert.deepEqual(report.citations.map((row) => row.url), ['https://example.com/a']);
  assert.equal(report.interpretation.length, 0);
  assert.match(report.limitations.join(' '), /Paid web search is not configured/);
  assert.equal(candidatesFromPages(pages).length, 1);
  assert.equal(candidatesFromPages(pages, { directory: 'prospects', kind: 'organization' })[0].curated, true);
});
