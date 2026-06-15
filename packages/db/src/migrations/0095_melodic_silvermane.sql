DROP INDEX IF EXISTS "budget_policies_company_scope_metric_unique_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cost_class" text DEFAULT 'metered' NOT NULL;--> statement-breakpoint
UPDATE "agents" SET "cost_class" = 'free' WHERE "adapter_type" = 'process' AND "spent_monthly_cents" = 0 AND "cost_class" = 'metered';--> statement-breakpoint
UPDATE "agents" SET "cost_class" = 'critical' WHERE "role" IN ('ceo', 'cto');--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN IF NOT EXISTS "adapter_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_policies_adapter_metric_unique_idx" ON "budget_policies" USING btree ("company_id","adapter_name","metric","window_kind") WHERE "budget_policies"."scope_type" = 'adapter';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_policies_company_scope_metric_unique_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","metric","window_kind") WHERE "budget_policies"."adapter_name" IS NULL;