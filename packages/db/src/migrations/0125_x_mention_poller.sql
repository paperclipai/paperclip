CREATE TABLE IF NOT EXISTS "x_mention_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "source_key" text NOT NULL,
  "account_user_id" text NOT NULL,
  "account_handle" text,
  "since_id" text,
  "monthly_budget_cents" integer DEFAULT 5000 NOT NULL,
  "per_run_budget_cents" integer DEFAULT 500 NOT NULL,
  "budget_paused_at" timestamp with time zone,
  "budget_pause_reason" text,
  "rate_limit_reset_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "x_mention_sources_company_source_uq"
  ON "x_mention_sources" ("company_id", "source_key");
CREATE INDEX IF NOT EXISTS "x_mention_sources_company_account_idx"
  ON "x_mention_sources" ("company_id", "account_user_id");
CREATE INDEX IF NOT EXISTS "x_mention_sources_budget_paused_idx"
  ON "x_mention_sources" ("company_id", "budget_paused_at");

CREATE TABLE IF NOT EXISTS "x_mention_author_allowlist" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "x_user_id" text NOT NULL,
  "handle" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "x_mention_allowlist_company_user_uq"
  ON "x_mention_author_allowlist" ("company_id", "x_user_id");
CREATE INDEX IF NOT EXISTS "x_mention_allowlist_company_active_idx"
  ON "x_mention_author_allowlist" ("company_id", "is_active");

CREATE TABLE IF NOT EXISTS "x_mentions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "source_id" uuid NOT NULL REFERENCES "x_mention_sources"("id") ON DELETE cascade,
  "tweet_id" text NOT NULL,
  "author_user_id" text NOT NULL,
  "author_handle" text,
  "text" text DEFAULT '' NOT NULL,
  "mentioned_at" timestamp with time zone,
  "raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "gate_status" text DEFAULT 'stored' NOT NULL,
  "hydration_status" text DEFAULT 'none' NOT NULL,
  "manual_approved_at" timestamp with time zone,
  "queued_at" timestamp with time zone,
  "hydrated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "x_mentions_company_tweet_uq"
  ON "x_mentions" ("company_id", "tweet_id");
CREATE INDEX IF NOT EXISTS "x_mentions_source_tweet_idx"
  ON "x_mentions" ("source_id", "tweet_id");
CREATE INDEX IF NOT EXISTS "x_mentions_company_gate_idx"
  ON "x_mentions" ("company_id", "gate_status");
CREATE INDEX IF NOT EXISTS "x_mentions_company_hydration_idx"
  ON "x_mentions" ("company_id", "hydration_status");
CREATE INDEX IF NOT EXISTS "x_mentions_company_author_idx"
  ON "x_mentions" ("company_id", "author_user_id");

CREATE TABLE IF NOT EXISTS "x_mention_budget_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "source_id" uuid NOT NULL REFERENCES "x_mention_sources"("id") ON DELETE cascade,
  "mention_id" uuid REFERENCES "x_mentions"("id") ON DELETE cascade,
  "operation" text NOT NULL,
  "estimated_cost_cents" integer NOT NULL,
  "actual_cost_cents" integer,
  "status" text DEFAULT 'recorded' NOT NULL,
  "failure_reason" text,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "x_mention_budget_company_occurred_idx"
  ON "x_mention_budget_ledger" ("company_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "x_mention_budget_source_occurred_idx"
  ON "x_mention_budget_ledger" ("source_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "x_mention_budget_operation_idx"
  ON "x_mention_budget_ledger" ("company_id", "operation");
