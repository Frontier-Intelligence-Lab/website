-- Models: open-weight models a workspace has asked to pull, and enhance runs built on them.
-- A pull is a request to copy a catalog model's weights into the workspace's storage. An enhance run is a
-- plan (base model, approved dataset versions, steps, compute, spending cap) that is editable while it is a
-- draft and frozen once requested; running it on GPUs is not automated yet.
CREATE TABLE model_pulls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model_id text NOT NULL CHECK (model_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'ready', 'failed')),
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, model_id)
);

CREATE TABLE enhance_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  base_model_id text NOT NULL CHECK (base_model_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  datasets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(datasets) = 'array'),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  compute text CHECK (compute IS NULL OR compute IN ('nebius', 'coreweave', 'lambda')),
  spend_cap_usd integer CHECK (spend_cap_usd IS NULL OR spend_cap_usd BETWEEN 1 AND 100000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'requested')),
  created_by uuid NOT NULL REFERENCES users(id),
  requested_by uuid REFERENCES users(id),
  requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enhance_runs_requested_check CHECK (
    (status = 'draft' AND requested_at IS NULL AND requested_by IS NULL)
    OR (status = 'requested' AND requested_at IS NOT NULL AND requested_by IS NOT NULL
        AND compute IS NOT NULL AND spend_cap_usd IS NOT NULL
        AND jsonb_array_length(datasets) > 0 AND jsonb_array_length(steps) > 0))
);
CREATE INDEX enhance_runs_workspace_idx ON enhance_runs (workspace_id, created_at);

-- A requested run is what an owner approved spend for: its plan cannot change afterwards, even by direct SQL.
CREATE OR REPLACE FUNCTION enhance_runs_freeze_requested() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'requested' THEN
    RAISE EXCEPTION 'run_frozen';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER enhance_runs_freeze BEFORE UPDATE OR DELETE ON enhance_runs
  FOR EACH ROW EXECUTE FUNCTION enhance_runs_freeze_requested();
