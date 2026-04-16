ALTER TABLE "cost_events" ADD COLUMN "cache_creation_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE "billing_reconciliation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"paperclip_cents" integer NOT NULL,
	"anthropic_cents" integer NOT NULL,
	"drift_pct" numeric(6, 2) NOT NULL,
	"raw_anthropic_row" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_reconciliation" ADD CONSTRAINT "billing_reconciliation_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation" ADD CONSTRAINT "billing_reconciliation_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_reconciliation_date_agent_uq" ON "billing_reconciliation" USING btree ("date","agent_id");--> statement-breakpoint
CREATE INDEX "billing_reconciliation_company_date_idx" ON "billing_reconciliation" USING btree ("company_id","date");
