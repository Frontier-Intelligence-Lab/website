import { createHash } from 'node:crypto';

/** Shared research rules. Dataset approval does not apply to these projects. */
export const TEMPLATES = Object.freeze(['collection', 'landscape', 'diligence']);
export const DIRECTORIES = Object.freeze(['founders', 'partners', 'companies', 'tools', 'repositories', 'prospects']);
export const KINDS = Object.freeze(['person', 'organization', 'tool', 'repository']);
export const CLAIM_STATUSES = Object.freeze(['retrieved', 'extracted', 'supported', 'corroborated', 'reviewed', 'inferred', 'conflicting', 'unknown']);
export const RELATIONSHIP_KINDS = Object.freeze(['founded', 'partner_role', 'develops', 'maintains']);
export const CHECKLIST_KEYS = Object.freeze([
  'claimsEvidenced', 'sourcesRecorded', 'datesShown', 'duplicatesReviewed', 'interpretationLabeled', 'questionAnswered',
]);
export const STALE_MS = 180 * 24 * 3600 * 1000;
export const DIRECTORY_LABELS = Object.freeze({
  founders: 'Founders',
  partners: 'Partners and investors',
  companies: 'Companies',
  tools: 'Tools and products',
  repositories: 'Projects and repositories',
  prospects: 'Prospects',
});

const NAME_LIMIT = 200;
const TEXT_LIMIT = 2000;
const norm = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Editable starter briefs. They name public pages and do not state private investment criteria.
 * YC and Speedrun organizations are demonstration workspaces, not endorsements.
 */
export function templateDraft(template, organizationName = '') {
  const org = organizationName.trim();
  const who = org ? `This brief is for the demonstration organization “${org}”.` : 'This brief is for one demonstration organization.';
  const common = `${who} It is not evidence of a commercial relationship or an endorsement. Edit it. Leave unknown facts blank. A catalog row is not the same as a page that was retrieved.`;
  if (template === 'collection') {
    return {
      name: 'Data collection and directories',
      question: 'Which public companies, people, tools and repositories belong in this workspace’s directories, and what does each source actually support?',
      brief: `${common} Directories: founders, partners and investors, companies, tools and products, repositories, and prospects you curate yourself. Prospects are not automatically qualified. The company directory can import the existing Frontier AI labs catalog already collected for this workspace. Each imported field stays “extracted” from that catalog until an official page is retrieved. Public pages to read while editing: https://www.ycombinator.com/companies and https://www.ycombinator.com/people for YC’s published directories, and https://speedrun.a16z.com/ plus https://a16z.com/ for a16z Speedrun’s public program pages.`,
    };
  }
  if (template === 'landscape') {
    return {
      name: 'Landscape and deep research',
      question: 'What do the retrieved public sources say about this sector, company or technology, and what is still unknown?',
      brief: `${common} Ask one bounded question. The research run may fetch HTTPS URLs you supply, or search the public Wikimedia API. It does not search the saved-note Agent, and it does not call a paid search provider. A finished report separates findings, interpretation, uncertainty and limitations. Citations point only at pages that run retrieved.`,
    };
  }
  if (template === 'diligence') {
    return {
      name: 'Diligence and research QA',
      question: 'Which material claims lack support, conflict with another claim, or depend on a stale or failed source?',
      brief: `${common} Review the checklist yourself: material claims have evidence, source limits are recorded, dates and uncertainty are visible, duplicate candidates were reviewed, interpretation is labeled, and the report answers the question. Coverage is a count of claims with a source, not a measure of factual accuracy. Research collections do not become approved training datasets.`,
    };
  }
  return null;
}

export const emptyChecklist = () => Object.fromEntries(CHECKLIST_KEYS.map((key) => [key, false]));

export function checklistPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const next = {};
  for (const key of CHECKLIST_KEYS) {
    if (!Object.hasOwn(value, key) || typeof value[key] !== 'boolean') return null;
    next[key] = value[key];
  }
  if (Object.keys(value).some((key) => !CHECKLIST_KEYS.includes(key))) return null;
  return next;
}

/** Apply only editable fields to the latest locked project, not a caller's stale full row. */
export function researchProjectPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) return null;
  if (Object.keys(patch).some((key) => !['name', 'brief', 'question', 'checklist'].includes(key))) return null;
  const next = {};
  for (const [key, max] of [['name', 160], ['brief', 8000], ['question', 2000]]) {
    if (!Object.hasOwn(patch, key)) continue;
    if (typeof patch[key] !== 'string' || patch[key].length > max || (key !== 'brief' && !patch[key].trim())) return null;
    next[key] = patch[key];
  }
  if (Object.hasOwn(patch, 'checklist')) {
    const value = patch.checklist;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.entries(value).some(([key, checked]) => !CHECKLIST_KEYS.includes(key) || typeof checked !== 'boolean')) return null;
    next.checklist = { ...current.checklist, ...value };
  }
  return next;
}

const timestamp = (value) => value == null ? null : new Date(value).toISOString();
function validTimestamp(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match || Number(match[1]) < 1 || !Number.isFinite(Date.parse(value))) return false;
  if (match[4] && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59)) return false;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`).toISOString().slice(0, 10) === `${match[1]}-${match[2]}-${match[3]}`;
}

/** A URL can have many immutable retrieval snapshots; repeated identical imports are idempotent. */
function sourceSnapshot(value) {
  const snapshot = {
    url: value.url, publisher: clip(value.publisher, 300), title: clip(value.title, 500), status: value.status,
    excerpt: clip(value.excerpt, 8000), sha256: value.sha256 ?? null,
    failure: value.failure ? clip(value.failure, 500) : null, retrievedAt: timestamp(value.retrievedAt),
  };
  return { ...snapshot, versionKey: sha256Text(JSON.stringify(snapshot)) };
}

const httpsUrl = (value) => {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
};

export function validateRecord(record) {
  if (!record || typeof record !== 'object') return 'A record must be an object.';
  if (typeof record.externalKey !== 'string' || record.externalKey.length < 1 || record.externalKey.length > 200) return 'Each record needs a stable external key.';
  if (!KINDS.includes(record.kind)) return 'Entity kind must be person, organization, tool or repository.';
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.trim().length > NAME_LIMIT) return 'Each record needs a name of 200 characters or fewer.';
  if (!DIRECTORIES.includes(record.directory)) return 'Directory is not one of the six research directories.';
  if (record.directory === 'prospects' && record.curated !== true) return 'Prospects are added by a person. A catalog import cannot fill that directory.';
  const source = record.source;
  if (!source || typeof source !== 'object') return 'Each record needs a source.';
  if (typeof source.url !== 'string' || source.url.length > 2000) return 'A source URL must be within 2000 characters.';
  const catalog = typeof source.url === 'string' && source.url.startsWith('catalog://');
  if (!catalog && !httpsUrl(source.url)) return 'A source URL must be https, or a catalog:// reference to an existing collection.';
  if (!['retrieved', 'failed', 'inaccessible', 'catalog'].includes(source.status)) return 'Source status is not recognized.';
  if (source.sha256 != null && (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256))) return 'A source hash must be a SHA-256.';
  if (source.status === 'retrieved' && !/^[0-9a-f]{64}$/.test(source.sha256 ?? '')) return 'A retrieved source needs a SHA-256 of the text that was kept.';
  if (!validTimestamp(source.retrievedAt)) return 'A source retrieval date must be an ISO date or timestamp.';
  if (!Array.isArray(record.claims) || record.claims.length < 1 || record.claims.length > 40) return 'Each record needs between 1 and 40 claims.';
  for (const claim of record.claims) {
    if (!claim || typeof claim.field !== 'string' || !/^[a-z0-9_]{1,80}$/.test(claim.field)) return 'A claim field must be a short lowercase name.';
    if (typeof claim.value !== 'string' || !claim.value.trim() || claim.value.trim().length > TEXT_LIMIT) return 'A claim value must be non-empty text within 2000 characters.';
    if (!CLAIM_STATUSES.includes(claim.status) || claim.status === 'conflicting') return 'Set a claim status other than conflicting. Conflicts are detected when values disagree.';
    if (typeof claim.method !== 'string' || !claim.method.trim() || claim.method.length > 80) return 'Each claim needs an extraction method.';
    if (['extracted', 'supported', 'corroborated', 'reviewed'].includes(claim.status) && (typeof claim.excerpt !== 'string' || !claim.excerpt.trim())) return 'A claim that is more than unknown needs an excerpt from its source.';
    if (claim.excerpt && claim.excerpt.length > TEXT_LIMIT) return 'An excerpt must be 2000 characters or fewer.';
    if (!validTimestamp(claim.observedAt)) return 'A claim observation date must be an ISO date or timestamp.';
  }
  if (record.relationships && !Array.isArray(record.relationships)) return 'Relationships must be a list.';
  return null;
}

/** Turn the existing Frontier AI labs catalog into company records. Fields stay extracted, not page-supported. */
export function recordsFromLabsCatalog(rows) {
  if (!Array.isArray(rows)) throw new Error('The labs catalog must be a JSON array.');
  return rows.map((row, index) => {
    const name = clip(row?.lab, NAME_LIMIT);
    const official = clip(row?.official_url, 2000);
    if (!name || !httpsUrl(official)) throw new Error(`Catalog row ${index + 1} needs a lab name and an https official_url.`);
    const key = `catalog:organization:${norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const excerpt = JSON.stringify({ lab: name, official_url: official, category: row.category ?? null, bay_area_hub: row.bay_area_hub ?? null, tier: row.tier ?? null });
    const claim = (field, value) => ({ field, value: clip(value, TEXT_LIMIT), status: 'extracted', method: 'existing_catalog', excerpt });
    const claims = [claim('name', name), claim('official_url', official)];
    if (row.category) claims.push(claim('category', String(row.category)));
    if (row.bay_area_hub) claims.push(claim('location', String(row.bay_area_hub)));
    if (row.tier) claims.push(claim('catalog_tier', String(row.tier)));
    return {
      externalKey: key,
      kind: 'organization',
      name,
      directory: 'companies',
      source: { url: `catalog://frontier-ai-labs-seed/${encodeURIComponent(key)}`, publisher: 'Existing Frontier AI labs catalog', title: name, status: 'catalog', excerpt },
      claims,
    };
  });
}

/**
 * Decide inserts without writing. Same name and kind with a different key becomes a duplicate candidate,
 * not a merge. A different value for the same field is kept and marked conflicting.
 */
export function planImport(graph, records) {
  const sources = graph.sources.map((row) => ({ ...row }));
  const entities = graph.entities.map((row) => ({ ...row }));
  const claims = graph.claims.map((row) => ({ ...row }));
  const summary = { importedEntities: 0, importedClaims: 0, skippedEntities: 0, skippedClaims: 0, failed: 0, duplicates: 0, conflicts: 0, errors: [] };
  const ops = { sources: [], entities: [], claims: [], memberships: [], relationships: [], conflictClaimIds: [], duplicates: [] };
  for (const record of records) {
    const error = validateRecord(record);
    if (error) { summary.failed += 1; summary.errors.push(error); continue; }
    const snapshot = sourceSnapshot(record.source);
    let source = sources.find((row) => row.url === snapshot.url && row.versionKey === snapshot.versionKey);
    if (!source) {
      source = { id: null, ...snapshot };
      sources.push(source);
      ops.sources.push(source);
    }
    let entity = entities.find((row) => row.externalKey === record.externalKey);
    if (!entity) {
      const twins = entities.filter((row) => row.kind === record.kind && norm(row.name) === norm(record.name));
      entity = { id: null, externalKey: record.externalKey, kind: record.kind, name: record.name.trim() };
      entities.push(entity);
      ops.entities.push(entity);
      summary.importedEntities += 1;
      for (const other of twins) {
        const left = entity.externalKey < other.externalKey ? entity.externalKey : other.externalKey;
        const right = entity.externalKey < other.externalKey ? other.externalKey : entity.externalKey;
        if (!ops.duplicates.some((row) => row.leftKey === left && row.rightKey === right)) {
          ops.duplicates.push({ leftKey: left, rightKey: right, reason: 'same_name' });
          summary.duplicates += 1;
        }
      }
    } else summary.skippedEntities += 1;
    ops.memberships.push({ entityKey: entity.externalKey, directory: record.directory });
    for (const claim of record.claims) {
      const value = claim.value.trim();
      const prior = claims.filter((row) => row.entityKey === entity.externalKey && row.field === claim.field);
      if (prior.some((row) => row.value === value && row.sourceUrl === source.url && row.sourceVersionKey === source.versionKey)) { summary.skippedClaims += 1; continue; }
      const differ = prior.filter((row) => row.value !== value && row.status !== 'unknown');
      const status = differ.length ? 'conflicting' : claim.status;
      const row = { entityKey: entity.externalKey, field: claim.field, value, status, sourceUrl: source.url, sourceVersionKey: source.versionKey, excerpt: clip(claim.excerpt, TEXT_LIMIT), method: claim.method.trim(), observedAt: timestamp(claim.observedAt) };
      claims.push(row);
      ops.claims.push(row);
      summary.importedClaims += 1;
      if (differ.length) {
        summary.conflicts += 1;
        for (const old of differ) {
          if (old.id && old.status !== 'conflicting') ops.conflictClaimIds.push(old.id);
          old.status = 'conflicting';
        }
      }
    }
  }
  return { ok: summary.errors.length === 0 || summary.importedEntities + summary.importedClaims + summary.skippedEntities + summary.skippedClaims > 0 || summary.failed === records.length, summary, ops };
}

export function qualityReport({ entities, claims, sources, duplicates, runs }, now = Date.now()) {
  const matchesCitation = (source, citation) => source.url === citation.url
    && (!citation.sha256 || source.contentSha256 === citation.sha256)
    && (!citation.retrievedAt || Date.parse(source.retrievedAt) === Date.parse(citation.retrievedAt));
  const sourceIds = new Set(claims.map((claim) => claim.sourceId).filter(Boolean));
  const citations = runs.flatMap((run) => run.output?.citations ?? []);
  // Sources are workspace-level snapshots, but this report describes only this project's claims and runs.
  sources = sources.filter((source) => sourceIds.has(source.id) || citations.some((citation) => matchesCitation(source, citation)));
  const claimList = claims;
  const withSource = claimList.filter((claim) => claim.sourceId || claim.sourceUrl);
  const conflicting = claimList.filter((claim) => claim.status === 'conflicting');
  const unsupported = claimList.filter((claim) => !['supported', 'corroborated', 'reviewed'].includes(claim.status));
  const stale = sources.filter((source) => source.retrievedAt && now - Date.parse(source.retrievedAt) > STALE_MS);
  const failed = sources.filter((source) => source.status === 'failed' || source.status === 'inaccessible');
  let citationGaps = 0;
  for (const run of runs) {
    for (const citation of run.output?.citations ?? []) {
      if (!sources.some((source) => source.status === 'retrieved' && matchesCitation(source, citation))) citationGaps += 1;
    }
  }
  return {
    entities: entities.length,
    claims: { withSource: withSource.length, total: claimList.length },
    conflicting: conflicting.length,
    unsupported: unsupported.length,
    duplicateCandidatesOpen: duplicates.filter((row) => row.status === 'open').length,
    staleSources: stale.length,
    failedSources: failed.length,
    citationGaps,
    limitations: 'Evidence coverage is the share of claims that point at a source record. It is not a measure of factual accuracy, and a retrieved page does not prove every field about its subject.',
  };
}

const FORMULA = /^[=+\-@\t\r]/;
export function spreadsheetCell(value) {
  const text = value == null ? '' : String(value);
  return FORMULA.test(text) ? `'${text}` : text;
}

export function toCsv(rows) {
  const headers = ['directory', 'kind', 'name', 'field', 'value', 'claim_status', 'source_url', 'source_status', 'retrieved_at', 'excerpt'];
  const escape = (value) => `"${spreadsheetCell(value).replaceAll('"', '""')}"`;
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((key) => escape(row[key] ?? '')).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function reportFromPages({ question, pages, modelConfigured = false }) {
  const retrieved = pages.filter((page) => page.status === 'retrieved' && typeof page.excerpt === 'string' && page.excerpt.trim());
  const findings = [];
  const cited = [];
  for (const page of retrieved) {
    const excerpt = page.excerpt.trim().slice(0, 1500);
    if (!page.text || !page.text.includes(excerpt)) continue;
    findings.push({
      text: excerpt.slice(0, 500),
      sourceUrl: page.finalUrl || page.url,
      status: 'extracted',
      label: 'Finding from retrieved text',
    });
    cited.push(page);
  }
  const failed = pages.filter((page) => page.status !== 'retrieved');
  return {
    question,
    findings,
    interpretation: [],
    uncertainty: findings.length ? ['These excerpts were taken from the retrieved text. They are not a judgement that the claim is complete or current.'] : ['No retrieved page contained text this run could quote.'],
    limitations: [
      'Paid web search is not configured and was not called.',
      'The saved-note Agent was not used.',
      modelConfigured
        ? 'A model is configured, but this run did not call it. Extraction is the retrieved text only.'
        : 'Model extraction is not configured. Nothing was filled from model memory.',
      failed.length ? `${failed.length} source request(s) failed or were refused.` : 'Every requested source in this run returned text.',
    ],
    citations: cited.map((page) => ({ url: page.finalUrl || page.url, title: page.title || '', sha256: page.sha256, retrievedAt: page.retrievedAt })),
  };
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Drop worker candidates whose excerpt is not contained in the retrieved page text. */
export function candidatesFromPages(pages, { directory = 'companies', kind = 'organization' } = {}) {
  const records = [];
  for (const page of pages) {
    if (page.status !== 'retrieved' || typeof page.text !== 'string' || !page.text.trim()) continue;
    const excerpt = typeof page.excerpt === 'string' ? page.excerpt.trim().slice(0, 1500) : '';
    if (!excerpt || !page.text.includes(excerpt)) continue;
    const title = clip(page.title, NAME_LIMIT) || clip(page.url, NAME_LIMIT);
    const key = `retrieved:${kind}:${sha256Text(`${page.finalUrl || page.url}|${title}`).slice(0, 24)}`;
    records.push({
      externalKey: key,
      kind,
      name: title,
      directory,
      ...(directory === 'prospects' ? { curated: true } : {}),
      source: {
        url: page.finalUrl || page.url,
        publisher: page.publisher || new URL(page.finalUrl || page.url).hostname,
        title,
        status: 'retrieved',
        excerpt,
        sha256: page.sha256 || sha256Text(page.text),
        retrievedAt: page.retrievedAt,
      },
      claims: [
        { field: 'name', value: title, status: 'extracted', method: 'retrieved_text', excerpt: excerpt.slice(0, 400) },
        { field: 'page_excerpt', value: excerpt.slice(0, 500), status: 'extracted', method: 'retrieved_text', excerpt: excerpt.slice(0, 500) },
      ],
    });
  }
  return records;
}
