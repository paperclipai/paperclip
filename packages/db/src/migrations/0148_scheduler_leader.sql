CREATE TABLE IF NOT EXISTS "scheduler_leader" (
  "name" text PRIMARY KEY DEFAULT 'default',
  "leader_id" text NOT NULL,
  "hostname" text NOT NULL,
  "elected_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL
);
