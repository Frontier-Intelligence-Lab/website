-- Executed case runs for one frozen evaluation version.
-- The job kind "evaluate" stays the post-training metric. "case_eval" is this table's job:
-- the vetted support-qa recipe, with no model call. A run stores a score only when it is complete.

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('probe', 'train', 'evaluate', 'export', 'case_eval'));

DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'jobs'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%enhance_run_id IS NULL%';
  IF cname IS NULL THEN RAISE EXCEPTION 'jobs plan check missing'; END IF;
  EXECUTE format('ALTER TABLE jobs DROP CONSTRAINT %I', cname);
END $$;

ALTER TABLE jobs ADD CONSTRAINT jobs_plan_kind_check
  CHECK ((kind IN ('probe', 'case_eval')) = (enhance_run_id IS NULL));

CREATE TABLE eval_case_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  version_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('baseline', 'candidate')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'partial', 'failed', 'cancelled')),
  scored boolean NOT NULL DEFAULT false,
  recipe_id text NOT NULL CHECK (recipe_id = 'support-qa'),
  recipe_version text NOT NULL CHECK (recipe_version ~ '^[A-Za-z0-9._-]{1,20}$'),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  passages jsonb NOT NULL CHECK (jsonb_typeof(passages) = 'array'),
  runtime jsonb NOT NULL CHECK (jsonb_typeof(runtime) = 'object'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (scored = (status = 'complete')),
  CHECK ((status IN ('complete', 'partial', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (version_id, workspace_id) REFERENCES eval_set_versions (id, workspace_id),
  FOREIGN KEY (job_id, workspace_id) REFERENCES jobs (id, workspace_id)
);
CREATE INDEX eval_case_runs_version_idx ON eval_case_runs (version_id, created_at);

CREATE TABLE eval_case_results (
  run_id uuid NOT NULL REFERENCES eval_case_runs(id) ON DELETE CASCADE,
  case_key text NOT NULL CHECK (case_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  output text CHECK (output IS NULL OR char_length(output) BETWEEN 1 AND 8000),
  error_kind text CHECK (error_kind IS NULL OR error_kind IN ('timeout', 'transport', 'no_source', 'missing')),
  passages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(passages) = 'array'),
  citations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array'),
  scores jsonb CHECK (scores IS NULL OR jsonb_typeof(scores) = 'object'),
  explanation text CHECK (explanation IS NULL OR char_length(explanation) BETWEEN 1 AND 2000),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000),
  PRIMARY KEY (run_id, case_key),
  CHECK (output IS NULL OR error_kind IS NULL)
);

-- Scores are written once, after the run row is marked complete. Output cannot change after that.
-- A score on any other status is refused, including at commit if the run is rolled back to unscored.
CREATE FUNCTION eval_case_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE finished timestamptz;
DECLARE scored boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT r.finished_at INTO finished FROM eval_case_runs r WHERE r.id = OLD.run_id FOR UPDATE;
    IF finished IS NOT NULL THEN RAISE EXCEPTION 'eval_case_run_frozen'; END IF;
    RETURN OLD;
  END IF;
  -- A result belongs to one case in one run for its whole lifetime, including while open.
  -- Checking only NEW's parent lets a terminal receipt be moved under an unfinished run.
  IF TG_OP = 'UPDATE' AND (NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.case_key IS DISTINCT FROM OLD.case_key) THEN
    RAISE EXCEPTION 'eval_case_run_frozen';
  END IF;
  SELECT r.finished_at, r.scored INTO finished, scored FROM eval_case_runs r WHERE r.id = NEW.run_id FOR UPDATE;
  IF NEW.scores IS NOT NULL AND scored IS NOT TRUE THEN RAISE EXCEPTION 'eval_unscored'; END IF;
  IF finished IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN RAISE EXCEPTION 'eval_case_run_frozen'; END IF;
  IF scored IS NOT TRUE OR OLD.scores IS NOT NULL OR NEW.scores IS NULL
     OR NEW.output IS DISTINCT FROM OLD.output OR NEW.error_kind IS DISTINCT FROM OLD.error_kind
     OR NEW.latency_ms IS DISTINCT FROM OLD.latency_ms OR NEW.passages::text IS DISTINCT FROM OLD.passages::text
     OR NEW.citations::text IS DISTINCT FROM OLD.citations::text THEN
    RAISE EXCEPTION 'eval_case_run_frozen';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER eval_case_results_guard BEFORE INSERT OR UPDATE OR DELETE ON eval_case_results
  FOR EACH ROW EXECUTE FUNCTION eval_case_run_guard();

CREATE FUNCTION eval_case_scores_final() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scored boolean;
BEGIN
  SELECT r.scored INTO scored FROM eval_case_runs r WHERE r.id = NEW.run_id;
  IF NEW.scores IS NOT NULL AND scored IS NOT TRUE THEN RAISE EXCEPTION 'eval_unscored'; END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER eval_case_results_scores_final
  AFTER INSERT OR UPDATE ON eval_case_results
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION eval_case_scores_final();

CREATE FUNCTION eval_case_run_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finished_at IS NOT NULL THEN RAISE EXCEPTION 'eval_case_run_frozen'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER eval_case_runs_freeze BEFORE UPDATE OR DELETE ON eval_case_runs
  FOR EACH ROW EXECUTE FUNCTION eval_case_run_freeze();
