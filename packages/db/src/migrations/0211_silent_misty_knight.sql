DROP INDEX "budget_policies_company_scope_metric_unique_idx";--> statement-breakpoint
ALTER TABLE "budget_policies" ALTER COLUMN "warn_percent" SET DEFAULT 60;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "cost_class" text DEFAULT 'metered' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "adapter_name" text;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "warn_high_percent" integer DEFAULT 85 NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "warn_recovery_percent" integer DEFAULT 55 NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN "warn_high_recovery_percent" integer DEFAULT 75 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_adapter_metric_unique_idx" ON "budget_policies" USING btree ("company_id","adapter_name","metric","window_kind") WHERE "budget_policies"."scope_type" = 'adapter';--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_company_scope_metric_unique_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","metric","window_kind") WHERE "budget_policies"."adapter_name" IS NULL;