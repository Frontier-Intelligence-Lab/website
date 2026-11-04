-- Read-only. Lists every stored box that annotations_box_stored_form (migrations/010) would refuse.
-- The WHERE clause is the constraint's predicate, negated, word for word: same CASE guard (so a non-number value
-- is reported, never cast), same key, type, millionth, minimum-side, bounds and edge-sum checks. When this returns
-- no rows, ALTER TABLE annotations VALIDATE CONSTRAINT annotations_box_stored_form will succeed; tests/store-postgres
-- checks that equivalence. It never changes data.
SELECT a.id, a.workspace_id, a.project_id, p.status AS project_status, a.box
FROM annotations a
JOIN projects p ON p.workspace_id = a.workspace_id AND p.id = a.project_id
WHERE a.box IS NOT NULL AND NOT (
  CASE
    WHEN jsonb_typeof(a.box) = 'object'
      AND a.box - 'x' - 'y' - 'w' - 'h' = '{}'::jsonb
      AND jsonb_typeof(a.box -> 'x') = 'number' AND jsonb_typeof(a.box -> 'y') = 'number'
      AND jsonb_typeof(a.box -> 'w') = 'number' AND jsonb_typeof(a.box -> 'h') = 'number'
    THEN
      (a.box ->> 'x')::numeric * 1000000 = trunc((a.box ->> 'x')::numeric * 1000000)
      AND (a.box ->> 'y')::numeric * 1000000 = trunc((a.box ->> 'y')::numeric * 1000000)
      AND (a.box ->> 'w')::numeric * 1000000 = trunc((a.box ->> 'w')::numeric * 1000000)
      AND (a.box ->> 'h')::numeric * 1000000 = trunc((a.box ->> 'h')::numeric * 1000000)
      AND (a.box ->> 'x')::numeric BETWEEN 0 AND 1 AND (a.box ->> 'y')::numeric BETWEEN 0 AND 1
      AND (a.box ->> 'w')::numeric >= 0.001 AND (a.box ->> 'h')::numeric >= 0.001
      AND (a.box ->> 'x')::numeric + (a.box ->> 'w')::numeric <= 1.000001
      AND (a.box ->> 'y')::numeric + (a.box ->> 'h')::numeric <= 1.000001
    ELSE false
  END
)
ORDER BY p.status, a.project_id, a.id;
