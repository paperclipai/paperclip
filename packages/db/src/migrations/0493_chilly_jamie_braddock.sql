-- paperclip:migration-compat online_compatible: responsibilities and responsibility_links are created by 0469 on the same unreleased branch and are only used behind the enableResponsibilities experimental flag, so no running release reads or writes them; the tables are empty or tiny, so the index builds, validated checks and foreign keys hold their locks only briefly.
CREATE TABLE "responsibility_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"proposed_by_agent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responsibility_areas_status_check" CHECK ("responsibility_areas"."status" in ('proposed', 'active', 'archived')),
	CONSTRAINT "responsibility_areas_source_check" CHECK ("responsibility_areas"."source" in ('manual', 'onboarding'))
);
--> statement-breakpoint
ALTER TABLE "responsibilities" DROP CONSTRAINT "responsibilities_health_override_check";--> statement-breakpoint
DROP INDEX "responsibility_links_project_uq";--> statement-breakpoint
DROP INDEX "responsibility_links_issue_uq";--> statement-breakpoint
DROP INDEX "responsibility_links_routine_uq";--> statement-breakpoint
ALTER TABLE "responsibilities" ADD COLUMN "area_id" uuid;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD COLUMN "metric_name" text;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD COLUMN "metric_unit" text;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD COLUMN "metric_target" numeric;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD COLUMN "metric_current" numeric;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD COLUMN "metric_direction" text DEFAULT 'at_least';--> statement-breakpoint
ALTER TABLE "responsibilities" ADD COLUMN "metric_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD COLUMN "run_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "responsibility_areas" ADD CONSTRAINT "responsibility_areas_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_areas" ADD CONSTRAINT "responsibility_areas_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responsibility_areas_company_status_idx" ON "responsibility_areas" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_areas_company_title_uq" ON "responsibility_areas" USING btree ("company_id",lower("title")) WHERE "responsibility_areas"."status" <> 'archived';--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_area_id_responsibility_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."responsibility_areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_run_by_agent_id_agents_id_fk" FOREIGN KEY ("run_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responsibilities_area_idx" ON "responsibilities" USING btree ("area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_links_responsibility_project_uq" ON "responsibility_links" USING btree ("responsibility_id","project_id") WHERE "responsibility_links"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_links_responsibility_issue_uq" ON "responsibility_links" USING btree ("responsibility_id","issue_id") WHERE "responsibility_links"."issue_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_links_responsibility_routine_uq" ON "responsibility_links" USING btree ("responsibility_id","routine_id") WHERE "responsibility_links"."routine_id" is not null;--> statement-breakpoint
CREATE INDEX "responsibility_links_project_idx" ON "responsibility_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "responsibility_links_issue_idx" ON "responsibility_links" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "responsibility_links_routine_idx" ON "responsibility_links" USING btree ("routine_id");--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_metric_direction_check" CHECK ("responsibilities"."metric_direction" is null or "responsibilities"."metric_direction" in ('at_least', 'at_most'));--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_health_override_check" CHECK ("responsibilities"."health_override" is null or "responsibilities"."health_override" in ('behind', 'at_risk', 'on_track'));