-- External demo reviewers (for example YC and Speedrun). Separate from customer users and from Valcairn staff.
CREATE TABLE reviewer_accounts (
  username text PRIMARY KEY CHECK (username = lower(username) AND username ~ '^[a-z0-9._@+-]{1,64}$'),
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'admin')),
  password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
