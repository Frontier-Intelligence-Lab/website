-- Run on this device: a person's own devices, what their local runtime reported, models installed through it and
-- runs measured on it. Everything here is reported by the person's browser from their own machine
-- (provenance 'client_reported'); the server never contacts the runtime. A device belongs to one user in one
-- workspace: other members, including owners and admins, cannot read or use it.
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  runtime text NOT NULL CHECK (runtime IN ('ollama')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  UNIQUE (id, workspace_id, owner_id)
);
CREATE INDEX devices_owner_idx ON devices (workspace_id, owner_id, created_at);

CREATE TABLE device_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  reachable boolean NOT NULL,
  runtime_version text CHECK (runtime_version IS NULL OR runtime_version ~ '^[0-9A-Za-z.+-]{1,40}$'),
  models jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(models) = 'array'),
  running jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(running) = 'array'),
  browser jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(browser) = 'object'),
  provenance text NOT NULL DEFAULT 'client_reported' CHECK (provenance = 'client_reported'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (device_id, workspace_id, owner_id) REFERENCES devices (id, workspace_id, owner_id) ON DELETE CASCADE
);
CREATE INDEX device_reports_device_idx ON device_reports (device_id, created_at DESC);

-- One row per model reference on a device. The digest is the runtime's manifest digest, recorded once the model is
-- installed; a name:tag reference can later point at different bytes, so the digest is the identity.
CREATE TABLE model_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  runtime_ref text NOT NULL CHECK (runtime_ref ~ '^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,64})?$'),
  catalog_id text CHECK (catalog_id IS NULL OR catalog_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  digest text CHECK (digest IS NULL OR digest ~ '^[0-9a-f]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  state text NOT NULL CHECK (state IN ('downloading', 'installed', 'verified', 'ready', 'failed', 'removed')),
  failure text CHECK (failure IS NULL OR length(failure) <= 300),
  verified_at timestamptz,
  provenance text NOT NULL DEFAULT 'client_reported' CHECK (provenance = 'client_reported'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Verified and ready mean Valcairn read the exact digest back from the runtime and ran it.
  CHECK (state NOT IN ('verified', 'ready') OR (digest IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK ((state = 'failed') = (failure IS NOT NULL)),
  UNIQUE (device_id, runtime_ref),
  UNIQUE (id, device_id),
  FOREIGN KEY (device_id, workspace_id, owner_id) REFERENCES devices (id, workspace_id, owner_id) ON DELETE CASCADE
);

-- A measured run. Prompts and replies stay on the device: only an optional SHA-256 of the prompt is stored.
CREATE TABLE execution_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  install_id uuid,
  model_ref text NOT NULL CHECK (length(model_ref) BETWEEN 1 AND 200),
  model_digest text CHECK (model_digest IS NULL OR model_digest ~ '^[0-9a-f]{64}$'),
  location text NOT NULL CHECK (location IN ('local_runtime')),
  kind text NOT NULL CHECK (kind IN ('chat', 'compat_test')),
  warm boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'stopped', 'failed')),
  failure text CHECK (failure IS NULL OR length(failure) <= 300),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  task jsonb CHECK (task IS NULL OR jsonb_typeof(task) = 'object'),
  prompt_sha256 text CHECK (prompt_sha256 IS NULL OR prompt_sha256 ~ '^[0-9a-f]{64}$'),
  provenance text NOT NULL DEFAULT 'client_reported' CHECK (provenance = 'client_reported'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'compat_test') = (task IS NOT NULL)),
  FOREIGN KEY (device_id, workspace_id, owner_id) REFERENCES devices (id, workspace_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (install_id, device_id) REFERENCES model_installs (id, device_id) ON DELETE SET NULL (install_id)
);
CREATE INDEX execution_runs_device_idx ON execution_runs (device_id, created_at DESC);
