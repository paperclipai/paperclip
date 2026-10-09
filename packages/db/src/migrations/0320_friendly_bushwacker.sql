CREATE TABLE IF NOT EXISTS "chat_slack_manager_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"manager_app_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"access_secret_id" uuid,
	"refresh_secret_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_slack_manager_grants_status_check" CHECK ("chat_slack_manager_grants"."status" in ('active', 'revoked', 'reauthorize'))
);

--> statement-breakpoint

ALTER TABLE "chat_slack_registrations" ADD COLUMN IF NOT EXISTS "manager_grant_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "chat_slack_manager_grants" ADD CONSTRAINT "chat_slack_manager_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "chat_slack_manager_grants_company_id_idx" ON "chat_slack_manager_grants" USING btree ("company_id","id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "chat_slack_manager_grants_owner_idx" ON "chat_slack_manager_grants" USING btree ("company_id","user_id","manager_app_id","workspace_id");
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "chat_slack_registrations" ADD CONSTRAINT "chat_slack_registrations_company_id_manager_grant_id_chat_slack_manager_grants_company_id_id_fk" FOREIGN KEY ("company_id","manager_grant_id") REFERENCES "public"."chat_slack_manager_grants"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;