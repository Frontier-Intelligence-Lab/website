-- Aligns the database with the stored box contract in src/lib/dataset.js (checkAnnotation). 008's check let through a
-- box with missing keys (they read as NULL, and a CHECK only fails on false), and any positive side however small.
-- A stored box is exactly { x, y, w, h }: JSON numbers in whole millionths, each side at least 0.001, inside the
-- image within one millionth of rounding tolerance.
--
-- Added NOT VALID: every new or changed row is checked from now on, but existing rows are not, so the upgrade can
-- never fail on, delete or rewrite data that is already stored, including frozen, approved history. The app flags
-- old non-conforming labels (findInvalid) so drafts are repaired before review. An operator can list remaining rows
-- with the query in docs/RELEASE.md and run VALIDATE CONSTRAINT once none are left.
ALTER TABLE annotations ADD CONSTRAINT annotations_box_stored_form CHECK (
  box IS NULL OR CASE
    WHEN jsonb_typeof(box) = 'object'
      AND box - 'x' - 'y' - 'w' - 'h' = '{}'::jsonb
      AND jsonb_typeof(box -> 'x') = 'number' AND jsonb_typeof(box -> 'y') = 'number'
      AND jsonb_typeof(box -> 'w') = 'number' AND jsonb_typeof(box -> 'h') = 'number'
    THEN
      (box ->> 'x')::numeric * 1000000 = trunc((box ->> 'x')::numeric * 1000000)
      AND (box ->> 'y')::numeric * 1000000 = trunc((box ->> 'y')::numeric * 1000000)
      AND (box ->> 'w')::numeric * 1000000 = trunc((box ->> 'w')::numeric * 1000000)
      AND (box ->> 'h')::numeric * 1000000 = trunc((box ->> 'h')::numeric * 1000000)
      AND (box ->> 'x')::numeric BETWEEN 0 AND 1 AND (box ->> 'y')::numeric BETWEEN 0 AND 1
      AND (box ->> 'w')::numeric >= 0.001 AND (box ->> 'h')::numeric >= 0.001
      AND (box ->> 'x')::numeric + (box ->> 'w')::numeric <= 1.000001
      AND (box ->> 'y')::numeric + (box ->> 'h')::numeric <= 1.000001
    ELSE false
  END
) NOT VALID;
