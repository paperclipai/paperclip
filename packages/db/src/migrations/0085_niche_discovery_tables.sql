-- Rollback:
--   DROP INDEX IF EXISTS "nda_discovery_state_company_key_idx";
--   DROP INDEX IF EXISTS "nda_activity_log_cycle_idx";
--   DROP INDEX IF EXISTS "nda_activity_log_run_idx";
--   DROP INDEX IF EXISTS "niche_opp_discovered_at_idx";
--   DROP INDEX IF EXISTS "niche_opp_company_status_idx";
--   DROP TABLE IF EXISTS "nda_discovery_state";
--   DROP TABLE IF EXISTS "nda_activity_log";
--   DROP TABLE IF EXISTS "niche_opportunities";

CREATE TABLE "niche_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"head_keyword" text NOT NULL,
	"category_path" text NOT NULL,
	"tier" text NOT NULL DEFAULT 'B',
	"composite_score" real NOT NULL DEFAULT 0,
	"status" text NOT NULL DEFAULT 'unreviewed',
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"mia_issue_id" uuid,
	"metadata" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nda_activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"run_id" text NOT NULL,
	"cycle_id" text,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"category_path" text NOT NULL,
	"category_id" text,
	"head_keyword" text,
	"composite_score" real,
	"component_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hard_guard_triggered" boolean DEFAULT false NOT NULL,
	"above_threshold" boolean DEFAULT false NOT NULL,
	"captcha_event" boolean DEFAULT false NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "nda_discovery_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
	"state_key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nda_discovery_state_company_key_uq" UNIQUE ("company_id", "state_key")
);
--> statement-breakpoint
CREATE INDEX "niche_opp_company_status_idx" ON "niche_opportunities" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX "niche_opp_discovered_at_idx" ON "niche_opportunities" USING btree ("discovered_at");
--> statement-breakpoint
CREATE INDEX "nda_activity_log_run_idx" ON "nda_activity_log" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "nda_activity_log_cycle_idx" ON "nda_activity_log" USING btree ("cycle_id");
--> statement-breakpoint
CREATE INDEX "nda_discovery_state_company_key_idx" ON "nda_discovery_state" USING btree ("company_id", "state_key");
