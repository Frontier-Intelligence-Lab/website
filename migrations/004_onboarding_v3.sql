ALTER TABLE projects DROP CONSTRAINT projects_status_check;
-- A legacy setup submission did not include a review; keep it eligible for review submission.
UPDATE projects SET status = 'draft', updated_at = clock_timestamp() WHERE status = 'submitted';
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('draft', 'in_review', 'changes_requested', 'approved', 'versioned'));
ALTER TABLE projects ADD CONSTRAINT projects_workspace_id_key UNIQUE (workspace_id, id);

CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  object_key text NOT NULL CONSTRAINT uploads_object_key_key UNIQUE,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 9007199254740991),
  content_type text NOT NULL,
  filename text NOT NULL,
  duplicate_of uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uploads_project_workspace_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT uploads_project_id_key UNIQUE (workspace_id, project_id, id),
  CONSTRAINT uploads_duplicate_project_fk FOREIGN KEY (workspace_id, project_id, duplicate_of)
    REFERENCES uploads(workspace_id, project_id, id)
);
CREATE INDEX uploads_project_sha256_lookup ON uploads (project_id, sha256);

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'changes_requested')),
  reviewer_id uuid REFERENCES users(id),
  notes text,
  checks jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checks) = 'object'),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviews_project_workspace_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX reviews_status_created_lookup ON reviews (status, created_at);
CREATE UNIQUE INDEX reviews_project_pending_key ON reviews (project_id) WHERE status = 'pending';

CREATE TABLE dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dataset_versions_project_workspace_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT dataset_versions_project_number_key UNIQUE (project_id, number)
);
