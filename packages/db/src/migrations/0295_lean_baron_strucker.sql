-- Preserve values while upgrading exact accounting. Additions are replay-safe.
CREATE TABLE IF NOT EXISTS "accounting_runtime_baselines" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"cost_cents" numeric(24, 7) NOT NULL,
	"input_tokens" numeric(30, 0) NOT NULL,
	"cached_input_tokens" numeric(30, 0) NOT NULL,
	"output_tokens" numeric(30, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" numeric(24, 7) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"cost_event_id" uuid,
	"run_id" uuid,
	"provider_request_id" text,
	"model" text,
	"pricing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "billing_invoice_lines_amount_check" CHECK ("billing_invoice_lines"."amount_cents" >= 0),
	CONSTRAINT "billing_invoice_lines_kind_check" CHECK ("billing_invoice_lines"."kind" in ('inference', 'fee', 'credit'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"biller" text NOT NULL,
	"external_id" text NOT NULL,
	"currency" text NOT NULL,
	"receipt_hash" text NOT NULL,
	"imported_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"project_id" uuid,
	"amount_cents" numeric(24, 7) NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"provider_started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_reservations_state_check" CHECK ("budget_reservations"."state" in ('held', 'settled', 'released')),
	CONSTRAINT "budget_reservations_amount_check" CHECK ("budget_reservations"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"cost_event_id" uuid NOT NULL,
	"invoice_line_id" uuid,
	"idempotency_key" text NOT NULL,
	"receipt_hash" text NOT NULL,
	"previous_cents" numeric(24, 7) NOT NULL,
	"corrected_cents" numeric(24, 7) NOT NULL,
	"previous_status" text NOT NULL,
	"previous_pricing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text NOT NULL,
	"pricing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_adjustments_amount_check" CHECK ("cost_adjustments"."previous_cents" >= 0 and "cost_adjustments"."corrected_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_billing_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"scope_id" text NOT NULL,
	"day" text NOT NULL,
	"amount_cents" numeric(24, 7) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_billing_snapshots_amount_check" CHECK ("provider_billing_snapshots"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_usage_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"receipt_hash" text NOT NULL,
	"receipt_json" jsonb NOT NULL,
	"complete" boolean NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_usage_receipts_positive_sequence" CHECK ("run_usage_receipts"."sequence" > 0)
);
--> statement-breakpoint
DROP INDEX IF EXISTS "budget_incidents_policy_window_threshold_idx";--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ALTER COLUMN "total_cost_cents" SET DATA TYPE numeric(24, 7);--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "spent_monthly_cents" SET DATA TYPE numeric(24, 7);--> statement-breakpoint
ALTER TABLE "budget_incidents" ALTER COLUMN "amount_observed" SET DATA TYPE numeric(24, 7);--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "spent_monthly_cents" SET DATA TYPE numeric(24, 7);--> statement-breakpoint
ALTER TABLE "cost_events" ALTER COLUMN "cost_cents" SET DATA TYPE numeric(24, 7);--> statement-breakpoint
ALTER TABLE "finance_events" ALTER COLUMN "amount_cents" SET DATA TYPE numeric(24, 7);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "spend_month_utc" text;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN IF NOT EXISTS "reservation_cents" numeric(24, 7) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN IF NOT EXISTS "unpriced_usage_policy" text DEFAULT 'block' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN IF NOT EXISTS "enforcement_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN IF NOT EXISTS "enforcement_delivered_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "spend_month_utc" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "receipt_hash" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "reported_cost_cents" numeric(24, 7);--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "pricing_provenance" jsonb;--> statement-breakpoint
ALTER TABLE "finance_events" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "finance_events" ADD COLUMN IF NOT EXISTS "receipt_hash" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "cost_accounting_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "cost_accounted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "accounting_projection_version" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "accounting_last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "accounting_last_error" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "accounting_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounting_runtime_baselines_agent_id_agents_id_fk' AND conrelid = 'public.accounting_runtime_baselines'::regclass) THEN
    ALTER TABLE "accounting_runtime_baselines" ADD CONSTRAINT "accounting_runtime_baselines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounting_runtime_baselines_company_id_companies_id_fk' AND conrelid = 'public.accounting_runtime_baselines'::regclass) THEN
    ALTER TABLE "accounting_runtime_baselines" ADD CONSTRAINT "accounting_runtime_baselines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_invoice_lines_company_id_companies_id_fk' AND conrelid = 'public.billing_invoice_lines'::regclass) THEN
    ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_invoice_lines_invoice_id_billing_invoices_id_fk' AND conrelid = 'public.billing_invoice_lines'::regclass) THEN
    ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_invoice_lines_cost_event_id_cost_events_id_fk' AND conrelid = 'public.billing_invoice_lines'::regclass) THEN
    ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_invoices_company_id_companies_id_fk' AND conrelid = 'public.billing_invoices'::regclass) THEN
    ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_reservations_company_id_companies_id_fk' AND conrelid = 'public.budget_reservations'::regclass) THEN
    ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_reservations_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.budget_reservations'::regclass) THEN
    ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_reservations_agent_id_agents_id_fk' AND conrelid = 'public.budget_reservations'::regclass) THEN
    ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_adjustments_company_id_companies_id_fk' AND conrelid = 'public.cost_adjustments'::regclass) THEN
    ALTER TABLE "cost_adjustments" ADD CONSTRAINT "cost_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_adjustments_cost_event_id_cost_events_id_fk' AND conrelid = 'public.cost_adjustments'::regclass) THEN
    ALTER TABLE "cost_adjustments" ADD CONSTRAINT "cost_adjustments_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_adjustments_invoice_line_id_billing_invoice_lines_id_fk' AND conrelid = 'public.cost_adjustments'::regclass) THEN
    ALTER TABLE "cost_adjustments" ADD CONSTRAINT "cost_adjustments_invoice_line_id_billing_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."billing_invoice_lines"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_billing_snapshots_company_id_companies_id_fk' AND conrelid = 'public.provider_billing_snapshots'::regclass) THEN
    ALTER TABLE "provider_billing_snapshots" ADD CONSTRAINT "provider_billing_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_usage_receipts_company_id_companies_id_fk' AND conrelid = 'public.run_usage_receipts'::regclass) THEN
    ALTER TABLE "run_usage_receipts" ADD CONSTRAINT "run_usage_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_usage_receipts_run_id_heartbeat_runs_id_fk' AND conrelid = 'public.run_usage_receipts'::regclass) THEN
    ALTER TABLE "run_usage_receipts" ADD CONSTRAINT "run_usage_receipts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounting_runtime_baselines_company_idx" ON "accounting_runtime_baselines" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_invoice_lines_identity_idx" ON "billing_invoice_lines" USING btree ("invoice_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_invoice_lines_company_idx" ON "billing_invoice_lines" USING btree ("company_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_invoices_identity_idx" ON "billing_invoices" USING btree ("company_id","biller","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_reservations_run_idx" ON "budget_reservations" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_reservations_active_idx" ON "budget_reservations" USING btree ("company_id","agent_id","project_id") WHERE "budget_reservations"."state" = 'held';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_adjustments_receipt_idx" ON "cost_adjustments" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_adjustments_event_idx" ON "cost_adjustments" USING btree ("company_id","cost_event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_adjustments_invoice_line_idx" ON "cost_adjustments" USING btree ("company_id","invoice_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_billing_snapshots_identity_idx" ON "provider_billing_snapshots" USING btree ("company_id","provider","account_id","scope_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "run_usage_receipts_source_sequence_idx" ON "run_usage_receipts" USING btree ("company_id","run_id","source_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_usage_receipts_run_latest_idx" ON "run_usage_receipts" USING btree ("company_id","run_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_events_company_receipt_idx" ON "cost_events" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_provider_request_idx" ON "cost_events" USING btree ("company_id","biller","provider_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_company_project_occurred_idx" ON "cost_events" USING btree ("company_id","project_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_unpriced_idx" ON "cost_events" USING btree ("company_id","occurred_at","id") WHERE "cost_events"."cost_status" = 'unpriced' and "cost_events"."billing_type" <> 'subscription_included';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "finance_events_company_receipt_idx" ON "finance_events" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_cost_accounting_pending_idx" ON "heartbeat_runs" USING btree ("updated_at","id") WHERE "heartbeat_runs"."cost_accounting_pending" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_incidents_policy_window_threshold_idx" ON "budget_incidents" USING btree ("policy_id","window_start","threshold_type") WHERE "budget_incidents"."status" = 'open';--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_policies_reservation_nonnegative' AND conrelid = 'public.budget_policies'::regclass) THEN
    ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_reservation_nonnegative" CHECK ("budget_policies"."reservation_cents" >= 0);
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_events_nonnegative_amounts' AND conrelid = 'public.cost_events'::regclass) THEN
    ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_nonnegative_amounts" CHECK ("cost_events"."cost_cents" >= 0 and "cost_events"."input_tokens" >= 0 and "cost_events"."cached_input_tokens" >= 0 and "cost_events"."output_tokens" >= 0);
  END IF;
END $$;