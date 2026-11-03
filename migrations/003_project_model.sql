ALTER TABLE projects ADD COLUMN model jsonb CHECK (jsonb_typeof(model) = 'object');
