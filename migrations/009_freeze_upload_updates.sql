-- Corrects 008. Its update trigger fired only when kind, offset_ms, workspace_id or project_id changed, so direct SQL
-- could still rewrite filename, content_type, size_bytes, sha256, object_key or any other column of an upload in a
-- frozen project. Every column of an upload is review content or its provenance, and the application never updates
-- an upload outside an editable project, so the locked guard now covers every UPDATE, with no column exceptions.
-- It still checks both the old and the new parent and still waits for an in-flight freeze. No row or snapshot changes.
DROP TRIGGER uploads_freeze_kind_offset ON uploads;
CREATE TRIGGER uploads_freeze_updates BEFORE UPDATE ON uploads
  FOR EACH ROW EXECUTE FUNCTION require_editable_project_locked();
