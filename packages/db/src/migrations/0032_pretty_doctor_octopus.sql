CREATE TABLE "budget_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"window_kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"threshold_type" text NOT NULL,
	"amount_limit" integer NOT NULL,
	"amount_observed" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"approval_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"metric" text DEFAULT 'billed_cents' NOT NULL,
	"window_kind" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"warn_percent" integer DEFAULT 80 NOT NULL,
	"hard_stop_enabled" boolean DEFAULT true NOT NULL,
	"notify_enabled" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
INSERT INTO "budget_policies" (
	"company_id",
	"scope_type",
	"scope_id",
	"metric",
	"window_kind",
	"amount",
	"warn_percent",
	"hard_stop_enabled",
	"notify_enabled",
	"is_active"
)
SELECT
	"id",
	'company',
	"id",
	'billed_cents',
	'calendar_month_utc',
	"budget_monthly_cents",
	80,
	true,
	true,
	true
FROM "companies"
WHERE "budget_monthly_cents" > 0;--> statement-breakpoint
INSERT INTO "budget_policies" (
	"company_id",
	"scope_type",
	"scope_id",
	"metric",
	"window_kind",
	"amount",
	"warn_percent",
	"hard_stop_enabled",
	"notify_enabled",
	"is_active"
)
SELECT
	"company_id",
	'agent',
	"id",
	'billed_cents',
	'calendar_month_utc',
	"budget_monthly_cents",
	80,
	true,
	true,
	true
FROM "agents"
WHERE "budget_monthly_cents" > 0;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_policy_id_budget_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_incidents_company_status_idx" ON "budget_incidents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "budget_incidents_company_scope_idx" ON "budget_incidents" USING btree ("company_id","scope_type","scope_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_incidents_policy_window_threshold_idx" ON "budget_incidents" USING btree ("policy_id","window_start","threshold_type");--> statement-breakpoint
CREATE INDEX "budget_policies_company_scope_active_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","is_active");--> statement-breakpoint
CREATE INDEX "budget_policies_company_window_idx" ON "budget_policies" USING btree ("company_id","window_kind","metric");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_company_scope_metric_unique_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","metric","window_kind");
