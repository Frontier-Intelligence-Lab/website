-- Capital: a cost plan and company financing request per case, immutable submitted revisions, append-only external
-- credit records and private evidence references. Money is US dollar integer cents, bounded here as well as in the
-- application. Nothing here issues credit, moves money or records a lender decision: statuses stop at Valcairn's
-- internal review ("evidence reviewed"); offer, approval and funding do not exist in this schema.

-- Composite keys so a case can only point at a project or enhance run inside its own workspace.
ALTER TABLE projects ADD CONSTRAINT projects_id_workspace_key UNIQUE (id, workspace_id);
ALTER TABLE enhance_runs ADD CONSTRAINT enhance_runs_id_workspace_key UNIQUE (id, workspace_id);

-- A plain-digit cents amount: a JSON number that prints as 1 to 13 digits (whole, non-negative, no fraction or
-- exponent) within $10 billion in cents. Never NULL: a missing key or another type is false, and the cast runs only
-- after the digit check has passed.
CREATE FUNCTION capital_cents_valid(value jsonb, minimum numeric) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^[0-9]{1,13}$' THEN (value #>> '{}')::numeric BETWEEN minimum AND 1000000000000
    ELSE false END
$$;

-- One cost item of a draft. Every required key must be present with the right type; anything else is false.
CREATE FUNCTION capital_cost_item_valid(item jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    jsonb_typeof(item) = 'object'
    AND capital_cents_valid(item -> 'amountCents', 0)
    AND coalesce(item ->> 'category' IN ('compute', 'deployment', 'storage', 'equipment'), false)
    AND coalesce(item ->> 'period' IN ('one_time', 'monthly', 'annual'), false)
    AND coalesce(item ->> 'basis' IN ('quoted', 'estimated', 'incurred'), false)
    AND (item ->> 'basis' <> 'incurred' OR coalesce(jsonb_typeof(item -> 'evidenceId') = 'string', false)),
  false)
$$;

-- The draft is bounded JSON: an object with a costItems array of at most 40 valid items, and a requestedAmountCents
-- that is absent, null or plain-digit cents from 1. A valid draft may be otherwise incomplete. Never NULL.
CREATE FUNCTION capital_draft_valid(draft jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    jsonb_typeof(draft) = 'object'
    AND coalesce(jsonb_typeof(draft -> 'costItems') = 'array', false)
    AND coalesce(jsonb_array_length(draft -> 'costItems') <= 40, false)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(draft -> 'costItems') AS item WHERE NOT capital_cost_item_valid(item))
    AND (NOT (draft ? 'requestedAmountCents')
      OR jsonb_typeof(draft -> 'requestedAmountCents') = 'null'
      OR capital_cents_valid(draft -> 'requestedAmountCents', 1)),
  false)
$$;

CREATE TABLE capital_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id uuid,
  enhance_run_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'changes_requested', 'evidence_reviewed')),
  draft jsonb NOT NULL DEFAULT '{"costItems": []}'::jsonb CHECK (capital_draft_valid(draft)),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  submitted_revision integer CHECK (submitted_revision IS NULL OR submitted_revision BETWEEN 1 AND revision),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'draft' OR submitted_revision IS NOT NULL),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES projects (id, workspace_id) ON DELETE SET NULL (project_id),
  FOREIGN KEY (enhance_run_id, workspace_id) REFERENCES enhance_runs (id, workspace_id) ON DELETE SET NULL (enhance_run_id)
);
CREATE INDEX capital_cases_workspace_idx ON capital_cases (workspace_id, created_at);
CREATE INDEX capital_cases_status_idx ON capital_cases (status, updated_at);

-- Exactly what an owner or admin sent to internal review. One row per case revision, so a retried submit cannot
-- duplicate a request, and one open (undecided) submission per case. content_hash is the SHA-256 of the canonical
-- snapshot: the owner consented to that exact content (draft, links, evidence and credit records as frozen).
CREATE TABLE capital_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decision text CHECK (decision IS NULL OR decision IN ('changes_requested', 'evidence_reviewed', 'withdrawn')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (decision IS NULL OR decided_by IS NOT NULL),
  UNIQUE (case_id, revision),
  FOREIGN KEY (case_id, workspace_id) REFERENCES capital_cases (id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX capital_submissions_open_key ON capital_submissions (case_id) WHERE decision IS NULL;
CREATE INDEX capital_submissions_case_idx ON capital_submissions (case_id, revision);

-- A submission is frozen: its snapshot never changes, and its decision is written once.
CREATE OR REPLACE FUNCTION capital_submissions_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'submission_frozen';
  END IF;
  IF NEW.id <> OLD.id OR NEW.case_id <> OLD.case_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.revision <> OLD.revision
     OR NEW.snapshot <> OLD.snapshot OR NEW.content_hash <> OLD.content_hash OR NEW.submitted_by <> OLD.submitted_by
     OR NEW.submitted_at <> OLD.submitted_at OR OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'submission_frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capital_submissions_freeze BEFORE UPDATE OR DELETE ON capital_submissions
  FOR EACH ROW EXECUTE FUNCTION capital_submissions_freeze();

-- External credits as the customer states them. Append-only: a correction is a new row that supersedes one earlier
-- row, which can be corrected only once. A claimed amount is a statement, never a balance.
CREATE TABLE credit_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('claimed', 'evidenced', 'withdrawn')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 1000000000000),
  expires_on date,
  restrictions text NOT NULL DEFAULT '' CHECK (length(restrictions) <= 1000),
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 200),
  supersedes uuid UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'evidenced' OR length(reference) > 0),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (supersedes, workspace_id) REFERENCES credit_records (id, workspace_id)
);
CREATE INDEX credit_records_workspace_idx ON credit_records (workspace_id, created_at);

CREATE OR REPLACE FUNCTION credit_records_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit_record_frozen';
END $$;
CREATE TRIGGER credit_records_append_only BEFORE UPDATE OR DELETE ON credit_records
  FOR EACH ROW EXECUTE FUNCTION credit_records_append_only();

-- Evidence behind a case: bounded references with the cited facts copied in, never file bytes. Finance documents do
-- not enter the dataset upload path; uploading them privately is planned. The customer's claim is never edited by
-- staff: verification records only how the claim arrived (typed in, or reported by the customer's own browser).
CREATE TABLE capital_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cost_assumption', 'credit_restriction', 'dataset_provenance', 'model_provenance', 'local_benchmark', 'company_record')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  source text NOT NULL DEFAULT '' CHECK (length(source) <= 300),
  reference jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reference) = 'object'),
  verification text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified', 'client_reported')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, workspace_id) REFERENCES capital_cases (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX capital_evidence_case_idx ON capital_evidence (case_id, created_at);

-- A staff "reviewed" mark is an append-only annotation on one sent revision and one evidence id frozen in it. The
-- store checks that the id is in that submission's snapshot; records sent later are never marked through an old one.
CREATE TABLE capital_review_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES capital_submissions(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL,
  reviewer_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, evidence_id)
);

CREATE OR REPLACE FUNCTION capital_review_marks_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review_mark_frozen';
END $$;
CREATE TRIGGER capital_review_marks_append_only BEFORE UPDATE OR DELETE ON capital_review_marks
  FOR EACH ROW EXECUTE FUNCTION capital_review_marks_append_only();
