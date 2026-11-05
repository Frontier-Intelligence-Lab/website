-- Evaluation sets, imported predictions and frozen comparison reports.
-- 014_jobs.sql is reserved by the open jobs work (PR #13, feat/jobs-runner) and is not on master.
-- This file does not read or alter jobs, runners or enhance_runs. It sorts after 014, so a database
-- that later gains 014 applies that file on its own. A database that applies 015 first is left ready
-- for 014 afterwards. Do not renumber this file once it has been applied.

-- A structured acceptance rule. Prose is not stored here and cannot be executed.
-- Never returns NULL: a missing key or a wrong type is false, and the numeric cast runs only after the text check.
CREATE FUNCTION eval_unit_interval(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^(0|1|0?\.[0-9]{1,4}|1\.0{1,4})$'
      THEN (value #>> '{}')::numeric BETWEEN 0 AND 1
    ELSE false END
$$;

CREATE FUNCTION eval_acceptance_valid(rule jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    jsonb_typeof(rule) = 'object'
    AND jsonb_typeof(rule -> 'version') = 'number' AND (rule ->> 'version') = '1'
    AND coalesce(rule ->> 'scoreBasis' IN ('human_else_auto', 'human_only', 'auto_exact'), false)
    AND eval_unit_interval(rule -> 'minPassRate')
    AND eval_unit_interval(rule -> 'minCoverage')
    AND jsonb_typeof(rule -> 'criticalMustPass') = 'boolean'
    AND jsonb_typeof(rule -> 'requireHumanOnCritical') = 'boolean'
    AND jsonb_typeof(rule -> 'requireHumanOnDisagreement') = 'boolean'
    AND jsonb_typeof(rule -> 'requireHumanWhenNoExpectedAnswer') = 'boolean',
  false)
$$;

CREATE FUNCTION eval_source_refs_valid(refs jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    jsonb_typeof(refs) = 'array'
    AND jsonb_array_length(refs) <= 8
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(refs) AS ref
      WHERE jsonb_typeof(ref) <> 'object'
        OR coalesce(ref ->> 'projectId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) = false
        OR coalesce(ref ->> 'versionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) = false
        OR (ref ? 'fileId' AND jsonb_typeof(ref -> 'fileId') <> 'null' AND coalesce(ref ->> 'fileId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) = false)
    ),
  false)
$$;

CREATE TABLE eval_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  purpose text NOT NULL CHECK (purpose IN ('development', 'final_assessment')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  acceptance jsonb NOT NULL CHECK (eval_acceptance_valid(acceptance)),
  rubric_version text NOT NULL CHECK (rubric_version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX eval_sets_project_idx ON eval_sets (workspace_id, project_id, created_at);

-- While a set is frozen, only a reopen may change it, and only its status, revision and updated_at.
-- A freeze itself may change status and updated_at and nothing else, so a direct UPDATE cannot
-- rewrite the rule in the same statement that freezes the set.
CREATE FUNCTION eval_sets_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'frozen' THEN
    IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.project_id <> OLD.project_id
       OR NEW.name <> OLD.name OR NEW.purpose <> OLD.purpose OR NEW.revision <> OLD.revision
       OR NEW.acceptance <> OLD.acceptance OR NEW.rubric_version <> OLD.rubric_version
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.status = 'frozen' THEN
    IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.project_id <> OLD.project_id
       OR NEW.name <> OLD.name OR NEW.purpose <> OLD.purpose
       OR NEW.acceptance <> OLD.acceptance OR NEW.rubric_version <> OLD.rubric_version
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
       OR NEW.status NOT IN ('draft', 'frozen') THEN
      RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status = 'frozen' AND NEW.revision <> OLD.revision THEN
      RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status = 'draft' AND NEW.revision <= OLD.revision THEN
      RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER eval_sets_freeze BEFORE UPDATE ON eval_sets
  FOR EACH ROW EXECUTE FUNCTION eval_sets_freeze();

CREATE TABLE eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  case_key text NOT NULL CHECK (case_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  input text NOT NULL CHECK (char_length(input) BETWEEN 1 AND 4000),
  expected_answer text CHECK (expected_answer IS NULL OR char_length(expected_answer) BETWEEN 1 AND 4000),
  review_criteria text CHECK (review_criteria IS NULL OR char_length(review_criteria) BETWEEN 1 AND 2000),
  category text CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 80),
  severity text CHECK (severity IS NULL OR severity IN ('critical', 'major', 'minor')),
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (eval_source_refs_valid(source_refs)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, case_key),
  FOREIGN KEY (set_id, workspace_id) REFERENCES eval_sets (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX eval_cases_set_idx ON eval_cases (set_id, case_key);

CREATE TABLE eval_issue_notes (
  set_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  issue_key text NOT NULL CHECK (char_length(issue_key) BETWEEN 1 AND 200),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (set_id, issue_key),
  FOREIGN KEY (set_id, workspace_id) REFERENCES eval_sets (id, workspace_id) ON DELETE CASCADE
);

-- Share-locks the parent set so a case write cannot pass while a freeze is in flight,
-- and a freeze waits for the write it would otherwise miss.
CREATE FUNCTION eval_require_draft_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  parent_set uuid;
  parent_ws uuid;
BEGIN
  parent_set := CASE WHEN TG_OP = 'DELETE' THEN OLD.set_id ELSE NEW.set_id END;
  parent_ws := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  SELECT status INTO parent_status FROM eval_sets WHERE id = parent_set AND workspace_id = parent_ws FOR SHARE;
  IF parent_status IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
  END IF;
  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.set_id <> OLD.set_id OR NEW.workspace_id <> OLD.workspace_id) THEN
    RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER eval_cases_draft BEFORE INSERT OR UPDATE OR DELETE ON eval_cases
  FOR EACH ROW EXECUTE FUNCTION eval_require_draft_set();
CREATE TRIGGER eval_issue_notes_draft BEFORE INSERT OR UPDATE OR DELETE ON eval_issue_notes
  FOR EACH ROW EXECUTE FUNCTION eval_require_draft_set();

-- One immutable snapshot per freeze. Later edits to the draft do not rewrite it.
CREATE TABLE eval_set_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  revision integer NOT NULL CHECK (revision >= 1),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, number),
  UNIQUE (set_id, revision),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (set_id, workspace_id) REFERENCES eval_sets (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX eval_set_versions_set_idx ON eval_set_versions (set_id, number);

CREATE TABLE eval_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  version_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('baseline', 'candidate')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  claimed_system jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(claimed_system) = 'object'),
  claimed_scorer text CHECK (claimed_scorer IS NULL OR char_length(claimed_scorer) BETWEEN 1 AND 80),
  rubric_version text NOT NULL CHECK (rubric_version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  imported_by uuid NOT NULL REFERENCES users(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, role, label),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (version_id, workspace_id) REFERENCES eval_set_versions (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX eval_batches_version_idx ON eval_batches (version_id, imported_at);

CREATE TABLE eval_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES eval_batches(id) ON DELETE CASCADE,
  case_key text NOT NULL CHECK (case_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  status text NOT NULL CHECK (status IN ('answered', 'abstained', 'error')),
  output text CHECK (output IS NULL OR char_length(output) BETWEEN 1 AND 8000),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  CHECK ((status = 'answered') = (output IS NOT NULL)),
  CHECK ((status = 'error') = (error_code IS NOT NULL)),
  UNIQUE (batch_id, case_key)
);
CREATE INDEX eval_predictions_batch_idx ON eval_predictions (batch_id);

CREATE TABLE eval_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  set_id uuid NOT NULL,
  version_id uuid NOT NULL,
  baseline_batch_id uuid NOT NULL,
  candidate_batch_id uuid NOT NULL,
  acceptance jsonb NOT NULL CHECK (eval_acceptance_valid(acceptance)),
  blind jsonb NOT NULL DEFAULT '{"hideIdentity": false, "swap": false}'::jsonb CHECK (jsonb_typeof(blind) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (baseline_batch_id <> candidate_batch_id),
  UNIQUE (version_id, baseline_batch_id, candidate_batch_id),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (version_id, workspace_id) REFERENCES eval_set_versions (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (baseline_batch_id, workspace_id) REFERENCES eval_batches (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (candidate_batch_id, workspace_id) REFERENCES eval_batches (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX eval_comparisons_set_idx ON eval_comparisons (set_id, created_at);

CREATE TABLE eval_judgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  case_key text NOT NULL CHECK (case_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  baseline_decision text CHECK (baseline_decision IS NULL OR baseline_decision IN ('pass', 'fail', 'insufficient')),
  candidate_decision text CHECK (candidate_decision IS NULL OR candidate_decision IN ('pass', 'fail', 'insufficient')),
  adjudication_baseline text CHECK (adjudication_baseline IS NULL OR adjudication_baseline IN ('human', 'automatic')),
  adjudication_candidate text CHECK (adjudication_candidate IS NULL OR adjudication_candidate IN ('human', 'automatic')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  reviewer_id uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comparison_id, case_key),
  FOREIGN KEY (comparison_id, workspace_id) REFERENCES eval_comparisons (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX eval_judgments_comparison_idx ON eval_judgments (comparison_id);

-- The approved report. One row per comparison revision, so a retry cannot file a second report.
CREATE TABLE eval_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  comparison_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('pass', 'fail', 'insufficient_evidence')),
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comparison_id, revision),
  FOREIGN KEY (comparison_id, workspace_id) REFERENCES eval_comparisons (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX eval_reports_comparison_idx ON eval_reports (comparison_id, revision);

CREATE FUNCTION eval_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER eval_set_versions_append_only BEFORE UPDATE OR DELETE ON eval_set_versions
  FOR EACH ROW EXECUTE FUNCTION eval_append_only();
CREATE TRIGGER eval_batches_append_only BEFORE UPDATE OR DELETE ON eval_batches
  FOR EACH ROW EXECUTE FUNCTION eval_append_only();
CREATE TRIGGER eval_predictions_append_only BEFORE UPDATE OR DELETE ON eval_predictions
  FOR EACH ROW EXECUTE FUNCTION eval_append_only();
CREATE TRIGGER eval_reports_append_only BEFORE UPDATE OR DELETE ON eval_reports
  FOR EACH ROW EXECUTE FUNCTION eval_append_only();

-- The pair a comparison scores, and the rule it was opened with, never change.
-- Blind assignment and the revision counter still move as review proceeds.
CREATE FUNCTION eval_comparison_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.set_id <> OLD.set_id
     OR NEW.version_id <> OLD.version_id OR NEW.baseline_batch_id <> OLD.baseline_batch_id
     OR NEW.candidate_batch_id <> OLD.candidate_batch_id OR NEW.acceptance <> OLD.acceptance
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER eval_comparison_identity BEFORE UPDATE ON eval_comparisons
  FOR EACH ROW EXECUTE FUNCTION eval_comparison_identity();

CREATE FUNCTION eval_judgment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.comparison_id <> OLD.comparison_id OR NEW.workspace_id <> OLD.workspace_id
     OR NEW.case_key <> OLD.case_key THEN
    RAISE EXCEPTION 'eval_frozen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER eval_judgment_identity BEFORE UPDATE ON eval_judgments
  FOR EACH ROW EXECUTE FUNCTION eval_judgment_identity();
