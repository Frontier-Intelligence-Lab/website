-- Dataset workspace: a label set per project, a chosen data type and timeline offset per file,
-- labels on files (whole-file or a time span), and notes that resolve open issues before review.
ALTER TABLE projects ADD COLUMN label_set jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(label_set) = 'array');
ALTER TABLE uploads ADD COLUMN kind text
  CHECK (kind IS NULL OR kind IN ('video', 'audio', 'image', 'text', 'sensor', 'robot', 'table', 'logs', 'file'));
ALTER TABLE uploads ADD COLUMN offset_ms bigint
  CHECK (offset_ms IS NULL OR abs(offset_ms) <= 31622400000);

CREATE TABLE annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  label_id text NOT NULL CHECK (length(label_id) BETWEEN 1 AND 64),
  start_ms bigint CHECK (start_ms IS NULL OR start_ms >= 0),
  end_ms bigint,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT annotations_span_check CHECK ((start_ms IS NULL AND end_ms IS NULL) OR (start_ms IS NOT NULL AND end_ms IS NOT NULL AND end_ms >= start_ms)),
  CONSTRAINT annotations_upload_fk FOREIGN KEY (workspace_id, project_id, upload_id)
    REFERENCES uploads(workspace_id, project_id, id) ON DELETE CASCADE
);
CREATE INDEX annotations_project_idx ON annotations (project_id, upload_id);

CREATE TABLE issue_notes (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  issue_key text NOT NULL CHECK (length(issue_key) BETWEEN 1 AND 200),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, issue_key),
  CONSTRAINT issue_notes_project_fk FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);

-- The label set is review content too, so it freezes with the rest.
CREATE OR REPLACE FUNCTION projects_freeze_reviewed_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('draft', 'changes_requested') AND (
    NEW.name IS DISTINCT FROM OLD.name OR NEW.task IS DISTINCT FROM OLD.task
    OR NEW.modalities IS DISTINCT FROM OLD.modalities OR NEW.starting_point IS DISTINCT FROM OLD.starting_point
    OR NEW.success IS DISTINCT FROM OLD.success OR NEW.data_source IS DISTINCT FROM OLD.data_source
    OR NEW.model IS DISTINCT FROM OLD.model OR NEW.label_set IS DISTINCT FROM OLD.label_set
  ) THEN
    RAISE EXCEPTION 'project_frozen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- Same guard as uploads: labels, issue notes and a file's type or offset change only while the project is editable.
CREATE TRIGGER uploads_freeze_kind_offset BEFORE UPDATE OF kind, offset_ms ON uploads
  FOR EACH ROW EXECUTE FUNCTION uploads_require_editable_project();
CREATE TRIGGER annotations_require_editable_project BEFORE INSERT OR UPDATE OR DELETE ON annotations
  FOR EACH ROW EXECUTE FUNCTION uploads_require_editable_project();
CREATE TRIGGER issue_notes_require_editable_project BEFORE INSERT OR UPDATE OR DELETE ON issue_notes
  FOR EACH ROW EXECUTE FUNCTION uploads_require_editable_project();
