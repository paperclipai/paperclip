CREATE TABLE IF NOT EXISTS "anthropic_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text NOT NULL,
	"mode" text NOT NULL,
	"credential_dir" text,
	"api_key_secret_id" uuid,
	"last_quota_check_at" timestamp with time zone,
	"last_utilization_five_hour" numeric,
	"last_utilization_seven_day" numeric,
	"last_quota_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anthropic_accounts_mode_check" CHECK ("anthropic_accounts"."mode" IN ('oauth', 'api_key', 'bedrock'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "anthropic_active_account" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"set_by_agent_id" uuid,
	"set_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "anthropic_account_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text,
	"from_account_id" uuid,
	"to_account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"switched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anthropic_accounts" ADD CONSTRAINT "anthropic_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anthropic_accounts" ADD CONSTRAINT "anthropic_accounts_api_key_secret_id_company_secrets_id_fk" FOREIGN KEY ("api_key_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anthropic_active_account" ADD CONSTRAINT "anthropic_active_account_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anthropic_active_account" ADD CONSTRAINT "anthropic_active_account_account_id_anthropic_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."anthropic_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anthropic_active_account" ADD CONSTRAINT "anthropic_active_account_set_by_agent_id_agents_id_fk" FOREIGN KEY ("set_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anthropic_account_switches" ADD CONSTRAINT "anthropic_account_switches_from_account_id_anthropic_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."anthropic_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anthropic_account_switches" ADD CONSTRAINT "anthropic_account_switches_to_account_id_anthropic_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."anthropic_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "anthropic_accounts_company_idx" ON "anthropic_accounts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "anthropic_account_switches_to_account_idx" ON "anthropic_account_switches" USING btree ("to_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "anthropic_account_switches_switched_at_idx" ON "anthropic_account_switches" USING btree ("switched_at");
