CREATE TABLE "autonomous_action_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_id" text NOT NULL,
	"task_id" text NOT NULL,
	"parent_execution_id" text,
	"worker_id" text,
	"attempt" integer NOT NULL,
	"kind" text NOT NULL,
	"effect_type" text NOT NULL,
	"effect_payload" jsonb NOT NULL,
	"action_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"effect_key" text NOT NULL,
	"effect_fingerprint" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autonomous_action_ledger_attempt_check" CHECK ("autonomous_action_ledger"."attempt" >= 1),
	CONSTRAINT "autonomous_action_ledger_status_check" CHECK ("autonomous_action_ledger"."status" IN ('accepted', 'claimed', 'dispatched', 'consumed'))
);
--> statement-breakpoint
ALTER TABLE "autonomous_action_ledger" ADD CONSTRAINT "autonomous_action_ledger_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autonomous_action_ledger_company_action_id_uq" ON "autonomous_action_ledger" USING btree ("company_id","action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "autonomous_action_ledger_company_idempotency_key_uq" ON "autonomous_action_ledger" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "autonomous_action_ledger_company_effect_key_uq" ON "autonomous_action_ledger" USING btree ("company_id","effect_key");--> statement-breakpoint
CREATE INDEX "autonomous_action_ledger_company_status_created_idx" ON "autonomous_action_ledger" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "autonomous_action_ledger_execution_idx" ON "autonomous_action_ledger" USING btree ("company_id","execution_id");