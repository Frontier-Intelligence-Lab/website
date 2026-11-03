-- Reviews keep a snapshot of exactly what was submitted; dataset versions are built from an approved snapshot.
ALTER TABLE reviews ADD COLUMN snapshot jsonb CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object');
ALTER TABLE reviews DROP CONSTRAINT reviews_status_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_status_check
  CHECK (status IN ('pending', 'approved', 'changes_requested', 'withdrawn'));

-- Defense in depth: review-relevant content and files cannot change unless the project is editable,
-- whatever code path issues the write. Lifecycle methods change status in separate statements.
CREATE FUNCTION projects_freeze_reviewed_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('draft', 'changes_requested') AND (
    NEW.name IS DISTINCT FROM OLD.name OR NEW.task IS DISTINCT FROM OLD.task
    OR NEW.modalities IS DISTINCT FROM OLD.modalities OR NEW.starting_point IS DISTINCT FROM OLD.starting_point
    OR NEW.success IS DISTINCT FROM OLD.success OR NEW.data_source IS DISTINCT FROM OLD.data_source
    OR NEW.model IS DISTINCT FROM OLD.model
  ) THEN
    RAISE EXCEPTION 'project_frozen' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER projects_freeze_reviewed_content BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_freeze_reviewed_content();

CREATE FUNCTION uploads_require_editable_project() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
BEGIN
  SELECT status INTO current_status FROM projects
    WHERE workspace_id = COALESCE(NEW.workspace_id, OLD.workspace_id) AND id = COALESCE(NEW.project_id, OLD.project_id);
  -- A missing project means the upload is being removed with it (ON DELETE CASCADE).
  IF current_status IS NOT NULL AND current_status NOT IN ('draft', 'changes_requested') THEN
    RAISE EXCEPTION 'project_frozen' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER uploads_require_editable_project BEFORE INSERT OR DELETE ON uploads
  FOR EACH ROW EXECUTE FUNCTION uploads_require_editable_project();
