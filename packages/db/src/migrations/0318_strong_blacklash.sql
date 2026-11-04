CREATE TABLE IF NOT EXISTS "chat_slack_registrations" (
	"endpoint_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"status" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"callback_uri" text NOT NULL,
	"app_id" text,
	"client_id" text,
	"secret_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workspace_id" text,
	"bot_user_id" text,
	"error_code" text,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_slack_registration_status_check" CHECK ("chat_slack_registrations"."status" in ('creating', 'uncertain', 'failed', 'install', 'credentials_saved', 'configured', 'removed'))
);
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "chat_slack_registrations" ADD CONSTRAINT "chat_slack_registrations_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
