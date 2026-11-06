-- Research projects, evidence-backed entities and runs. Additive. Research rows are not dataset
-- projects: they never enter the review/approval state machine in 005–010.

CREATE TABLE research_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users (id),
  template text NOT NULL CHECK (template IN ('collection', 'landscape', 'diligence')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  brief text NOT NULL DEFAULT '' CHECK (char_length(brief) <= 8000),
  question text NOT NULL DEFAULT '' CHECK (char_length(question) <= 2000),
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX research_projects_workspace_idx ON research_projects (workspace_id, updated_at DESC);

CREATE TABLE research_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2000),
  publisher text NOT NULL DEFAULT '' CHECK (char_length(publisher) <= 300),
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 500),
  published_at timestamptz,
  retrieved_at timestamptz,
  status text NOT NULL CHECK (status IN ('retrieved', 'failed', 'inaccessible', 'catalog')),
  failure text CHECK (failure IS NULL OR char_length(failure) <= 500),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  excerpt text NOT NULL DEFAULT '' CHECK (char_length(excerpt) <= 8000),
  http_status integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, url)
);
CREATE INDEX research_sources_workspace_idx ON research_sources (workspace_id);

CREATE TABLE research_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('person', 'organization', 'tool', 'repository')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  external_key text NOT NULL CHECK (char_length(external_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, external_key)
);
CREATE INDEX research_entities_workspace_name_idx ON research_entities (workspace_id, kind, name);

CREATE TABLE research_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES research_entities (id) ON DELETE CASCADE,
  field text NOT NULL CHECK (char_length(field) BETWEEN 1 AND 80),
  value_text text NOT NULL CHECK (char_length(value_text) BETWEEN 1 AND 2000),
  status text NOT NULL CHECK (status IN ('retrieved', 'extracted', 'supported', 'corroborated', 'reviewed', 'inferred', 'conflicting', 'unknown')),
  source_id uuid REFERENCES research_sources (id) ON DELETE SET NULL,
  excerpt text NOT NULL DEFAULT '' CHECK (char_length(excerpt) <= 2000),
  extraction_method text NOT NULL CHECK (char_length(extraction_method) BETWEEN 1 AND 80),
  observed_at timestamptz,
  retrieved_at timestamptz,
  content_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX research_claims_source_identity ON research_claims (entity_id, field, value_text, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX research_claims_entity_idx ON research_claims (entity_id, field);

CREATE TABLE research_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  from_entity_id uuid NOT NULL REFERENCES research_entities (id) ON DELETE CASCADE,
  to_entity_id uuid NOT NULL REFERENCES research_entities (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('founded', 'partner_role', 'develops', 'maintains')),
  started_on date,
  ended_on date,
  claim_id uuid REFERENCES research_claims (id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_entity_id <> to_entity_id),
  CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX research_relationships_workspace_idx ON research_relationships (workspace_id);

CREATE TABLE research_memberships (
  project_id uuid NOT NULL REFERENCES research_projects (id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES research_entities (id) ON DELETE CASCADE,
  directory text NOT NULL CHECK (directory IN ('founders', 'partners', 'companies', 'tools', 'repositories', 'prospects')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, entity_id, directory)
);

CREATE TABLE research_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES research_projects (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  purpose text NOT NULL DEFAULT '' CHECK (char_length(purpose) <= 500),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, name)
);

CREATE TABLE research_list_items (
  list_id uuid NOT NULL REFERENCES research_lists (id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES research_entities (id) ON DELETE CASCADE,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (list_id, entity_id)
);

CREATE TABLE research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES research_projects (id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users (id),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 2000),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('proposed', 'running', 'completed', 'failed', 'cancelled')),
  output jsonb,
  error text CHECK (error IS NULL OR char_length(error) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK (status <> 'completed' OR output IS NOT NULL),
  CHECK (status <> 'failed' OR output IS NULL)
);
CREATE INDEX research_runs_project_idx ON research_runs (project_id, created_at DESC);

CREATE TABLE research_run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('progress', 'source', 'failure', 'output')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX research_run_events_run_idx ON research_run_events (run_id, id);

CREATE TABLE research_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES research_entities (id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users (id),
  patch jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE research_duplicate_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  left_entity_id uuid NOT NULL REFERENCES research_entities (id) ON DELETE CASCADE,
  right_entity_id uuid NOT NULL REFERENCES research_entities (id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('same_name')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (left_entity_id <> right_entity_id),
  UNIQUE (workspace_id, left_entity_id, right_entity_id)
);
