CREATE TABLE "auto_promotion_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"guild_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text DEFAULT 'auto-promotion-scanner' NOT NULL,
	"success_count_at_decision" integer NOT NULL,
	"fail_count_at_decision" integer NOT NULL,
	"total_uses_at_decision" integer NOT NULL,
	"distinct_runs_at_decision" integer NOT NULL,
	"success_ratio_at_decision" numeric(4, 3) NOT NULL,
	"skill_age_hours_at_decision" integer NOT NULL,
	"body_stable_hours_at_decision" integer NOT NULL,
	"min_uses_threshold" integer NOT NULL,
	"min_success_ratio_threshold" numeric(4, 3) NOT NULL,
	"min_age_hours_threshold" integer NOT NULL,
	"min_body_stable_hours_threshold" integer NOT NULL,
	"min_distinct_runs_threshold" integer NOT NULL,
	"scan_id" uuid NOT NULL,
	CONSTRAINT "auto_promotion_audit_skill_unique" UNIQUE("skill_id")
);
--> statement-breakpoint
CREATE TABLE "auto_promotion_config" (
	"guild_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"scan_hour_utc" integer DEFAULT 6 NOT NULL,
	"min_uses" integer DEFAULT 5 NOT NULL,
	"min_success_ratio" numeric(4, 3) DEFAULT '0.800' NOT NULL,
	"min_age_hours" integer DEFAULT 24 NOT NULL,
	"min_body_stable_hours" integer DEFAULT 24 NOT NULL,
	"min_distinct_runs" integer DEFAULT 3 NOT NULL,
	"max_promotions_per_tick" integer DEFAULT 3 NOT NULL,
	"last_successful_scan_at" timestamp with time zone,
	"last_scan_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_promotion_config_scan_hour_check" CHECK ("auto_promotion_config"."scan_hour_utc" BETWEEN 0 AND 23),
	CONSTRAINT "auto_promotion_config_min_uses_check" CHECK ("auto_promotion_config"."min_uses" >= 3),
	CONSTRAINT "auto_promotion_config_min_ratio_check" CHECK ("auto_promotion_config"."min_success_ratio" >= 0.600 AND "auto_promotion_config"."min_success_ratio" <= 1.000),
	CONSTRAINT "auto_promotion_config_min_age_check" CHECK ("auto_promotion_config"."min_age_hours" >= 6),
	CONSTRAINT "auto_promotion_config_min_body_stable_check" CHECK ("auto_promotion_config"."min_body_stable_hours" >= 6),
	CONSTRAINT "auto_promotion_config_min_distinct_check" CHECK ("auto_promotion_config"."min_distinct_runs" >= 2),
	CONSTRAINT "auto_promotion_config_max_per_tick_check" CHECK ("auto_promotion_config"."max_promotions_per_tick" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "auto_promotion_reverts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"reverted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_by" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "auto_promotion_reverts_audit_unique" UNIQUE("audit_id"),
	CONSTRAINT "auto_promotion_reverts_reason_len_check" CHECK (length("auto_promotion_reverts"."reason") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "auto_promotion_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"reviewer_id" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"context" text
);
--> statement-breakpoint
CREATE TABLE "skill_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"guild_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"success" boolean NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "body_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_promotion_audit" ADD CONSTRAINT "auto_promotion_audit_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_promotion_audit" ADD CONSTRAINT "auto_promotion_audit_guild_id_agents_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_promotion_audit" ADD CONSTRAINT "auto_promotion_audit_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_promotion_config" ADD CONSTRAINT "auto_promotion_config_guild_id_agents_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_promotion_config" ADD CONSTRAINT "auto_promotion_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_promotion_reverts" ADD CONSTRAINT "auto_promotion_reverts_audit_id_auto_promotion_audit_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."auto_promotion_audit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_promotion_reviews" ADD CONSTRAINT "auto_promotion_reviews_audit_id_auto_promotion_audit_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."auto_promotion_audit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_uses" ADD CONSTRAINT "skill_uses_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_uses" ADD CONSTRAINT "skill_uses_guild_id_agents_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_uses" ADD CONSTRAINT "skill_uses_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_promotion_audit_guild_decided_idx" ON "auto_promotion_audit" USING btree ("guild_id","decided_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auto_promotion_audit_scan_idx" ON "auto_promotion_audit" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "auto_promotion_reverts_reverted_at_idx" ON "auto_promotion_reverts" USING btree ("reverted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auto_promotion_reviews_audit_idx" ON "auto_promotion_reviews" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "auto_promotion_reviews_reviewed_at_idx" ON "auto_promotion_reviews" USING btree ("reviewed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "skill_uses_skill_idx" ON "skill_uses" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_uses_guild_recorded_idx" ON "skill_uses" USING btree ("guild_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE OR REPLACE FUNCTION raise_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only (operation: %)', TG_TABLE_NAME, TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER skill_uses_append_only
  BEFORE UPDATE OR DELETE ON "skill_uses"
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION raise_append_only();--> statement-breakpoint
CREATE TRIGGER auto_promotion_audit_append_only
  BEFORE UPDATE OR DELETE ON "auto_promotion_audit"
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION raise_append_only();--> statement-breakpoint
CREATE TRIGGER auto_promotion_reverts_append_only
  BEFORE UPDATE OR DELETE ON "auto_promotion_reverts"
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION raise_append_only();--> statement-breakpoint
CREATE TRIGGER auto_promotion_reviews_append_only
  BEFORE UPDATE OR DELETE ON "auto_promotion_reviews"
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION raise_append_only();--> statement-breakpoint
INSERT INTO "auto_promotion_config" (guild_id, company_id)
  SELECT id, company_id FROM "agents" WHERE kind = 'guild'
  ON CONFLICT (guild_id) DO NOTHING;