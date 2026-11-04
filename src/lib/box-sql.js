// The stored-form box predicate of migrations/010_annotation_box_stored_form.sql, word for word, for any jsonb
// expression. Stored boxes are checked with it in Postgres because node-postgres reads JSON numbers into JavaScript
// numbers: a legacy 0.100000000000000001 arrives as 0.1, so a check in JavaScript alone cannot see what 010 refuses.
// tests/store-postgres checks that this text matches the migration.
const PREDICATE = `CASE
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
  END`;

/** 010's CASE with `box` replaced by the given jsonb expression; true when the box is in the stored form. */
export const boxStoredForm = (expr = 'box') => PREDICATE.replace(/\bbox\b/g, expr);

/** True for a non-null box that 010 would refuse. JSON null counts as no box, as it does for a label. */
export const boxNotStoredForm = (expr) => `(NULLIF(${expr}, 'null'::jsonb) IS NOT NULL AND NOT (${boxStoredForm(`NULLIF(${expr}, 'null'::jsonb)`)}))`;

/** Ids of the labels in a frozen snapshot or manifest (a jsonb column) whose box 010 would refuse. */
export const frozenBoxViolations = (column) => `ARRAY(SELECT e ->> 'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column} -> 'annotations') = 'array' THEN ${column} -> 'annotations' ELSE '[]'::jsonb END) e
  WHERE jsonb_typeof(e) = 'object' AND ${boxNotStoredForm("e -> 'box'")})`;
