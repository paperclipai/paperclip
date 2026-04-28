CREATE TABLE IF NOT EXISTS "rt2_personal_pnl" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "actor_id" text NOT NULL,
  "actor_type" text NOT NULL,
  "period" text NOT NULL,
  "income" integer DEFAULT 0 NOT NULL,
  "expenses" integer DEFAULT 0 NOT NULL,
  "net_pnl" integer DEFAULT 0 NOT NULL,
  "budget_allocated" integer DEFAULT 0 NOT NULL,
  "budget_used" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_pnl_company_actor_period_idx" ON "rt2_personal_pnl" ("company_id","actor_id","period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_pnl_company_period_idx" ON "rt2_personal_pnl" ("company_id","period");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_coin_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "from_actor_id" text NOT NULL,
  "from_actor_type" text NOT NULL,
  "to_actor_id" text NOT NULL,
  "to_actor_type" text NOT NULL,
  "amount" integer NOT NULL,
  "balance_after" integer NOT NULL,
  "transaction_type" text NOT NULL,
  "description" text,
  "reference_id" text,
  "reference_type" text,
  "period" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coin_ledger_company_from_actor_idx" ON "rt2_coin_ledger" ("company_id","from_actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coin_ledger_company_to_actor_idx" ON "rt2_coin_ledger" ("company_id","to_actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coin_ledger_company_period_idx" ON "rt2_coin_ledger" ("company_id","period");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_collaboration_rewards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "actor_id" text NOT NULL,
  "actor_type" text NOT NULL,
  "reputation_index" integer DEFAULT 500 NOT NULL,
  "multiplier" real DEFAULT 1.0 NOT NULL,
  "ai_contribution_score" integer DEFAULT 0 NOT NULL,
  "total_collaborations" integer DEFAULT 0 NOT NULL,
  "successful_collaborations" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collab_rewards_company_actor_idx" ON "rt2_collaboration_rewards" ("company_id","actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collab_rewards_company_reputation_idx" ON "rt2_collaboration_rewards" ("company_id","reputation_index");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_collaboration_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "actor_id" text NOT NULL,
  "actor_type" text NOT NULL,
  "work_product_id" uuid,
  "collaboration_type" text NOT NULL,
  "successful" text DEFAULT 'pending' NOT NULL,
  "points_earned" integer DEFAULT 0 NOT NULL,
  "reputation_change" integer DEFAULT 0 NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collab_events_company_actor_idx" ON "rt2_collaboration_events" ("company_id","actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collab_events_company_work_product_idx" ON "rt2_collaboration_events" ("company_id","work_product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_agent_marketplace" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "creator_company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" text NOT NULL,
  "description" text,
  "category" text NOT NULL,
  "tags" text[],
  "pricing_type" text DEFAULT 'per_task' NOT NULL,
  "price_per_task_cents" integer,
  "monthly_subscription_cents" integer,
  "capabilities" text DEFAULT '{}' NOT NULL,
  "adapter_type" text DEFAULT 'process' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "total_subscriptions" integer DEFAULT 0 NOT NULL,
  "rating_average" integer DEFAULT 0 NOT NULL,
  "rating_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_marketplace_creator_idx" ON "rt2_agent_marketplace" ("creator_company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_marketplace_category_idx" ON "rt2_agent_marketplace" ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_marketplace_active_idx" ON "rt2_agent_marketplace" ("is_active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_byoa_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" text NOT NULL,
  "adapter_type" text DEFAULT 'process' NOT NULL,
  "connection_config" text DEFAULT '{}' NOT NULL,
  "capabilities_description" text,
  "is_connected" boolean DEFAULT false NOT NULL,
  "last_connected_at" timestamp with time zone,
  "monthly_budget_cents" integer DEFAULT 0 NOT NULL,
  "spent_cents" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "byoa_agents_company_idx" ON "rt2_byoa_agents" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "byoa_agents_connected_idx" ON "rt2_byoa_agents" ("is_connected");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rt2_agent_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "marketplace_listing_id" uuid NOT NULL REFERENCES "rt2_agent_marketplace"("id"),
  "subscription_type" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "monthly_rate_cents" integer,
  "tasks_included" integer,
  "tasks_used" integer DEFAULT 0 NOT NULL,
  "trial_ends_at" timestamp with time zone,
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_subscriptions_company_idx" ON "rt2_agent_subscriptions" ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_subscriptions_listing_idx" ON "rt2_agent_subscriptions" ("marketplace_listing_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_subscriptions_status_idx" ON "rt2_agent_subscriptions" ("status");
