CREATE TABLE "account_pool_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"active_account_id" uuid,
	"prev_account_id" uuid,
	"reason" text DEFAULT 'initial' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotation_stopped" boolean DEFAULT false NOT NULL,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_pool_state" ADD CONSTRAINT "account_pool_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_pool_state" ADD CONSTRAINT "account_pool_state_active_account_id_company_secrets_id_fk" FOREIGN KEY ("active_account_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_pool_state" ADD CONSTRAINT "account_pool_state_prev_account_id_company_secrets_id_fk" FOREIGN KEY ("prev_account_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_pool_state_company_uq" ON "account_pool_state" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "account_pool_state_active_account_idx" ON "account_pool_state" USING btree ("active_account_id");
