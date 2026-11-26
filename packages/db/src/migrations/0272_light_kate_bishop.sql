-- Safe to replay after an interrupted or previously applied development migration.
CREATE TABLE IF NOT EXISTS "email_endpoints" (
	"endpoint_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"receive_mode" text NOT NULL,
	"webhook_id" text,
	"owned_api_key_id" text,
	"activation_at" timestamp with time zone,
	"sync_checkpoint" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	CONSTRAINT "email_endpoints_receive_mode_check" CHECK ("email_endpoints"."receive_mode" in ('websocket', 'webhook'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"text" text NOT NULL,
	"full_text" text DEFAULT '' NOT NULL,
	"direction" text NOT NULL,
	"automatic" boolean DEFAULT false NOT NULL,
	"attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	CONSTRAINT "email_messages_direction_check" CHECK ("email_messages"."direction" in ('inbound', 'outbound'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_sends" (
	"publication_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"digest" text NOT NULL,
	"outcome" text DEFAULT 'queued' NOT NULL,
	"first_attempt_at" timestamp with time zone,
	CONSTRAINT "email_sends_outcome_check" CHECK ("email_sends"."outcome" in ('queued', 'sent', 'delivered', 'failed', 'uncertain'))
);
--> statement-breakpoint
ALTER TABLE "chat_endpoints" DROP CONSTRAINT IF EXISTS "chat_endpoints_provider_check";--> statement-breakpoint
ALTER TABLE "chat_external_principals" DROP CONSTRAINT IF EXISTS "chat_external_principals_provider_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_channel_transport_check";--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD COLUMN IF NOT EXISTS "publication_mode" text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD COLUMN IF NOT EXISTS "external_execution_policy" text DEFAULT 'restricted' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_endpoints" ADD CONSTRAINT "email_endpoints_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_company_id_conversation_id_chat_conversations_company_id_id_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_company_id_endpoint_id_chat_endpoints_company_id_id_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_company_id_publication_id_chat_publications_company_id_id_fk" FOREIGN KEY ("company_id","publication_id") REFERENCES "public"."chat_publications"("company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_messages_provider_uq" ON "email_messages" USING btree ("endpoint_id","provider_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_messages_conversation_idx" ON "email_messages" USING btree ("company_id","conversation_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_sends_pending_idx" ON "email_sends" USING btree ("endpoint_id","outcome") WHERE "email_sends"."outcome" in ('queued', 'uncertain');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_endpoints_agentmail_inbox_uq" ON "chat_endpoints" USING btree ("bot_external_id") WHERE "chat_endpoints"."provider" = 'agentmail' and "chat_endpoints"."status" != 'archived' and "chat_endpoints"."bot_external_id" is not null;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_publication_mode_check" CHECK ("chat_endpoints"."publication_mode" in ('automatic', 'explicit'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_execution_policy_check" CHECK ("chat_endpoints"."external_execution_policy" in ('restricted', 'agent'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_email_policy_check" CHECK ("chat_endpoints"."provider" <> 'agentmail' or ("chat_endpoints"."publication_mode" = 'explicit' and "chat_endpoints"."external_execution_policy" = 'agent'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" <> 'chat_sdk')
      or
      ("tool_connections"."connection_purpose" = 'channel' and ("tool_connections"."transport" = 'chat_sdk' or ("tool_connections"."transport" = 'rest_api' and "tool_connections"."config"->>'provider' = 'agentmail')))
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
