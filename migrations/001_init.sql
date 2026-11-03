CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email)),
  name text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE email_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  purpose text NOT NULL CHECK (purpose IN ('signup', 'academic')),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_codes_active_lookup ON email_codes (user_id, purpose, created_at DESC, id DESC)
  WHERE consumed_at IS NULL;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('organization', 'personal')),
  name text NOT NULL,
  slug text NOT NULL CONSTRAINT workspaces_slug_key UNIQUE CHECK (slug = lower(slug)),
  website text,
  domain text CHECK (domain = lower(domain)),
  domain_verified boolean NOT NULL DEFAULT false,
  join_by_domain boolean NOT NULL DEFAULT false,
  industry text,
  size_band text,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object'),
  personal_owner_id uuid CONSTRAINT workspaces_personal_owner_id_key UNIQUE REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT join_by_domain OR domain_verified),
  CHECK (NOT domain_verified OR domain IS NOT NULL),
  CHECK ((kind = 'personal') = (personal_owner_id IS NOT NULL))
);
CREATE INDEX workspaces_join_domain_lookup ON workspaces (domain)
  WHERE kind = 'organization' AND domain_verified AND join_by_domain;

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'finance', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_lookup ON memberships (user_id, created_at);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'finance', 'viewer')),
  token_hash text NOT NULL CONSTRAINT invitations_token_hash_key UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_pending_email_key ON invitations (workspace_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX join_requests_pending_key ON join_requests (workspace_id, user_id)
  WHERE status = 'pending';
CREATE INDEX join_requests_user_lookup ON join_requests (user_id, created_at);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  task text NOT NULL,
  modalities text[] NOT NULL DEFAULT '{}',
  starting_point text NOT NULL CHECK (starting_point IN ('own', 'need', 'model', 'unsure')),
  success jsonb CHECK (jsonb_typeof(success) = 'object'),
  data_source jsonb CHECK (jsonb_typeof(data_source) = 'object'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  setup_step text NOT NULL DEFAULT 'success',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_workspace_lookup ON projects (workspace_id, created_at);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace_newest ON audit_events (workspace_id, created_at DESC, id DESC);
