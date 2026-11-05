-- Validators that restore. Three SQL-language validators call other validators by unqualified name: 013's
-- capital_cost_item_valid and capital_draft_valid, and 015's eval_acceptance_valid. A SQL-language body is parsed with
-- the caller's search_path each time it runs, and pg_restore sets search_path to '' before it copies rows, so a normal
-- restore of a backup holding any row of capital_cases, eval_sets or eval_comparisons stopped at the first such COPY
-- ("function capital_cost_item_valid(jsonb) does not exist") and rolled back; empty tables never exercised the path.
-- Each nested call is now schema-qualified. CREATE OR REPLACE keeps each function's identity, so every CHECK that names
-- it is unchanged; the bodies are otherwise those of 013 and 015, so every NULL, type, range and count rule is the same,
-- no row is read or rewritten, and the previous web build is unaffected. capital_cents_valid, eval_unit_interval and
-- eval_source_refs_valid use only built-ins and operators, which pg_catalog always resolves, and stay as created.

CREATE OR REPLACE FUNCTION public.capital_cost_item_valid(item jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    jsonb_typeof(item) = 'object'
    AND public.capital_cents_valid(item -> 'amountCents', 0)
    AND coalesce(item ->> 'category' IN ('compute', 'deployment', 'storage', 'equipment'), false)
    AND coalesce(item ->> 'period' IN ('one_time', 'monthly', 'annual'), false)
    AND coalesce(item ->> 'basis' IN ('quoted', 'estimated', 'incurred'), false)
    AND (item ->> 'basis' <> 'incurred' OR coalesce(jsonb_typeof(item -> 'evidenceId') = 'string', false)),
  false)
$$;

CREATE OR REPLACE FUNCTION public.capital_draft_valid(draft jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    jsonb_typeof(draft) = 'object'
    AND coalesce(jsonb_typeof(draft -> 'costItems') = 'array', false)
    AND coalesce(jsonb_array_length(draft -> 'costItems') <= 40, false)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(draft -> 'costItems') AS item WHERE NOT public.capital_cost_item_valid(item))
    AND (NOT (draft ? 'requestedAmountCents')
      OR jsonb_typeof(draft -> 'requestedAmountCents') = 'null'
      OR public.capital_cents_valid(draft -> 'requestedAmountCents', 1)),
  false)
$$;

CREATE OR REPLACE FUNCTION public.eval_acceptance_valid(rule jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    jsonb_typeof(rule) = 'object'
    AND jsonb_typeof(rule -> 'version') = 'number' AND (rule ->> 'version') = '1'
    AND coalesce(rule ->> 'scoreBasis' IN ('human_else_auto', 'human_only', 'auto_exact'), false)
    AND public.eval_unit_interval(rule -> 'minPassRate')
    AND public.eval_unit_interval(rule -> 'minCoverage')
    AND jsonb_typeof(rule -> 'criticalMustPass') = 'boolean'
    AND jsonb_typeof(rule -> 'requireHumanOnCritical') = 'boolean'
    AND jsonb_typeof(rule -> 'requireHumanOnDisagreement') = 'boolean'
    AND jsonb_typeof(rule -> 'requireHumanWhenNoExpectedAnswer') = 'boolean',
  false)
$$;
