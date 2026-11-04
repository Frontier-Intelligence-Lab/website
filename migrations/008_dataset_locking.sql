-- Corrects 007. The guard from 005 read the parent project's status without locking it, so a write could pass
-- the check while another transaction was freezing the project, and commit after the freeze. This guard takes a
-- share lock on the parent row: it waits for an in-flight submit (which holds the row for update) and then sees
-- the frozen status, and a submit waits for in-flight writes that already passed. On updates it checks both the
-- old and the new parent. Freezes only get stricter; no snapshot or row is changed.
CREATE FUNCTION require_editable_project_locked() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO current_status FROM projects
      WHERE workspace_id = OLD.workspace_id AND id = OLD.project_id FOR SHARE;
    -- A missing project means the row is being removed with it (ON DELETE CASCADE).
    IF current_status IS NOT NULL AND current_status NOT IN ('draft', 'changes_requested') THEN
      RAISE EXCEPTION 'project_frozen' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO current_status FROM projects
      WHERE workspace_id = NEW.workspace_id AND id = NEW.project_id FOR SHARE;
    IF current_status IS NOT NULL AND current_status NOT IN ('draft', 'changes_requested') THEN
      RAISE EXCEPTION 'project_frozen' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER uploads_require_editable_project ON uploads;
CREATE TRIGGER uploads_require_editable_project BEFORE INSERT OR DELETE ON uploads
  FOR EACH ROW EXECUTE FUNCTION require_editable_project_locked();
DROP TRIGGER uploads_freeze_kind_offset ON uploads;
CREATE TRIGGER uploads_freeze_kind_offset BEFORE UPDATE OF kind, offset_ms, workspace_id, project_id ON uploads
  FOR EACH ROW EXECUTE FUNCTION require_editable_project_locked();
DROP TRIGGER annotations_require_editable_project ON annotations;
CREATE TRIGGER annotations_require_editable_project BEFORE INSERT OR UPDATE OR DELETE ON annotations
  FOR EACH ROW EXECUTE FUNCTION require_editable_project_locked();
DROP TRIGGER issue_notes_require_editable_project ON issue_notes;
CREATE TRIGGER issue_notes_require_editable_project BEFORE INSERT OR UPDATE OR DELETE ON issue_notes
  FOR EACH ROW EXECUTE FUNCTION require_editable_project_locked();

-- Rectangle labels on images, in fractions of the image size.
ALTER TABLE annotations ADD COLUMN box jsonb CHECK (box IS NULL OR (
  jsonb_typeof(box) = 'object' AND (box ->> 'x')::numeric >= 0 AND (box ->> 'y')::numeric >= 0
  AND (box ->> 'w')::numeric > 0 AND (box ->> 'h')::numeric > 0
  AND (box ->> 'x')::numeric + (box ->> 'w')::numeric <= 1.000001 AND (box ->> 'y')::numeric + (box ->> 'h')::numeric <= 1.000001));
ALTER TABLE annotations ADD CONSTRAINT annotations_box_or_span CHECK (box IS NULL OR (start_ms IS NULL AND end_ms IS NULL));
