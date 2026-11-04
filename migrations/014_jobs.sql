-- Valcairn Runners and jobs.
-- A runner is a machine a workspace owner or admin linked with a one-time key; it runs Valcairn jobs (sandbox
-- probes, training, evaluation, export) on that machine and reports back. Only a hash of its key is stored.
-- Jobs are the durable queue between the web app and runners: leased one at a time with an expiry, retried a
-- bounded number of times, cancellable, and append-only in their event log.

CREATE TABLE runners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix text NOT NULL CHECK (char_length(key_prefix) BETWEEN 4 AND 16),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- The runner's latest self-report: platform, GPUs, Ollama, sandbox. Reported by the runner, never verified here.
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX runners_workspace_idx ON runners (workspace_id, created_at);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('probe', 'train', 'evaluate', 'export')),
  enhance_run_id uuid,
  -- Everything the runner needs, frozen when the job is created; never edited afterwards.
  spec jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_hash text CHECK (lease_hash IS NULL OR lease_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  result jsonb,
  failure text CHECK (failure IS NULL OR char_length(failure) <= 200),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  created_by uuid NOT NULL REFERENCES users(id),
  cancelled_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id),
  -- NO ACTION (checked at statement end) so deleting a workspace removes runners, plans and jobs together.
  FOREIGN KEY (runner_id, workspace_id) REFERENCES runners (id, workspace_id),
  FOREIGN KEY (enhance_run_id, workspace_id) REFERENCES enhance_runs (id, workspace_id),
  -- Training, evaluation and export always come from an approved plan; a probe never does.
  CHECK ((kind = 'probe') = (enhance_run_id IS NULL)),
  -- A live lease exists exactly while a runner holds the job.
  CHECK ((status IN ('leased', 'running', 'cancel_requested')) = (lease_hash IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK ((status = 'failed') = (failure IS NOT NULL)),
  CHECK (status <> 'succeeded' OR result IS NOT NULL)
);
CREATE INDEX jobs_queue_idx ON jobs (runner_id, created_at) WHERE status = 'queued';
CREATE INDEX jobs_workspace_idx ON jobs (workspace_id, created_at DESC);

CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  seq integer NOT NULL CHECK (seq >= 0),
  kind text NOT NULL CHECK (kind IN ('log', 'metric', 'stage', 'artifact')),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A runner retrying a report after a dropped response sends the same (attempt, seq): it is stored once.
  UNIQUE (job_id, attempt, seq),
  FOREIGN KEY (job_id, workspace_id) REFERENCES jobs (id, workspace_id) ON DELETE CASCADE
);

-- A job's frozen inputs never change, and its log is append-only.
CREATE FUNCTION jobs_spec_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.spec IS DISTINCT FROM OLD.spec OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.runner_id IS DISTINCT FROM OLD.runner_id
     OR NEW.enhance_run_id IS DISTINCT FROM OLD.enhance_run_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'job_frozen';
  END IF;
  -- Finished jobs are history.
  IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'job_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_spec_frozen BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_spec_frozen();

CREATE FUNCTION job_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'job_event_frozen';
END $$;
CREATE TRIGGER job_events_append_only BEFORE UPDATE OR DELETE ON job_events FOR EACH ROW
  WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION job_events_append_only();
