CREATE TABLE sessions (
  sid text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry_lookup ON sessions (expires_at);
