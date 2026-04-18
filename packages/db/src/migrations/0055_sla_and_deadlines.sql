CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_policy_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"priority" text NOT NULL,
	"target_hours" integer NOT NULL,
	"warning_hours" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "due_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "sla_auto_set" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policy_rules" ADD CONSTRAINT "sla_policy_rules_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sla_policies_company_default_uq" ON "sla_policies" USING btree ("company_id") WHERE "sla_policies"."is_default" = true and "sla_policies"."status" = 'active';--> statement-breakpoint
CREATE INDEX "sla_policies_company_status_idx" ON "sla_policies" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_policy_rules_policy_priority_uq" ON "sla_policy_rules" USING btree ("policy_id","priority");--> statement-breakpoint
CREATE INDEX "issues_due_date_idx" ON "issues" USING btree ("due_date") WHERE "issues"."due_date" is not null;--> statement-breakpoint
CREATE INDEX "issues_overdue_idx" ON "issues" USING btree ("due_date","status") WHERE "issues"."due_date" is not null and "issues"."status" not in ('done', 'cancelled');
