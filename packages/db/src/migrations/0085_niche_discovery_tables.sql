-- Rollback:
--   DROP INDEX IF EXISTS "nda_discovery_state_company_key_idx";
--   DROP INDEX IF EXISTS "nda_activity_log_cycle_idx";
--   DROP INDEX IF EXISTS "nda_activity_log_run_idx";
--   DROP INDEX IF EXISTS "niche_opportunities_composite_score_idx";
--   DROP INDEX IF EXISTS "niche_opportunities_status_idx";
--   DROP TABLE IF EXISTS "nda_discovery_state";
--   DROP TABLE IF EXISTS "nda_activity_log";
--   DROP TABLE IF EXISTS "niche_opportunities";
--   DROP TYPE IF EXISTS "niche_opportunity_status";

CREATE TYPE "public"."niche_opportunity_status" AS ENUM('unreviewed', 'approved_for_analysis', 'deferred', 'rejected');
--> statement-breakpoint
CREATE TABLE "niche_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category_path" text NOT NULL,
	"category_id" text,
	"head_keyword" text NOT NULL,
	"composite_score" numeric(6, 2) NOT NULL,
	"component_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "niche_opportunity_status" DEFAULT 'unreviewed' NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nda_activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"cycle_id" text,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"category_path" text NOT NULL,
	"category_id" text,
	"head_keyword" text,
	"composite_score" numeric(6, 2),
	"component_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hard_guard_triggered" boolean DEFAULT false NOT NULL,
	"above_threshold" boolean DEFAULT false NOT NULL,
	"captcha_event" boolean DEFAULT false NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "nda_discovery_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"state_key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nda_discovery_state_company_key_uq" UNIQUE ("company_id", "state_key")
);
--> statement-breakpoint
CREATE INDEX "niche_opportunities_status_idx" ON "niche_opportunities" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "niche_opportunities_composite_score_idx" ON "niche_opportunities" USING btree ("composite_score" DESC);
--> statement-breakpoint
CREATE INDEX "nda_activity_log_run_idx" ON "nda_activity_log" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "nda_activity_log_cycle_idx" ON "nda_activity_log" USING btree ("cycle_id");
--> statement-breakpoint
CREATE INDEX "nda_discovery_state_company_key_idx" ON "nda_discovery_state" USING btree ("company_id", "state_key");
