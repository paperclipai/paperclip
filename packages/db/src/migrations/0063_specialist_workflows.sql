ALTER TABLE "issues" ADD COLUMN "workflow_template_key" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "workflow_lane_role" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "workflow_required_artifacts" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_workflow_parent_lane_uq" ON "issues" USING btree ("company_id","parent_id","workflow_lane_role") WHERE "issues"."parent_id" is not null
          and "issues"."workflow_lane_role" is not null;
