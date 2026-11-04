CREATE TABLE IF NOT EXISTS "chat_voice_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"cursor" integer NOT NULL,
	"delivered_at" timestamp with time zone,
	"spoken_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_replies_cursor_check" CHECK ("chat_voice_replies"."cursor" > 0),
	CONSTRAINT "chat_voice_replies_spoken_check" CHECK ("chat_voice_replies"."spoken_at" is null or "chat_voice_replies"."delivered_at" is not null)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_voice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"assigned_agent_id" uuid NOT NULL,
	"caller_id" text NOT NULL,
	"caller_authority" text NOT NULL,
	"approved_by_user_id" text,
	"mode" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"generation" integer NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"provider_session_id" text,
	"tool_token_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"reply_cursor" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_sessions_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "chat_voice_sessions_state_check" CHECK ("chat_voice_sessions"."state" in ('reserved', 'creating', 'creation_unknown', 'connecting', 'active', 'awaiting_approval', 'ending', 'ended', 'failed', 'expired')),
	CONSTRAINT "chat_voice_sessions_mode_check" CHECK ("chat_voice_sessions"."mode" in ('browser', 'inbound_phone', 'outbound_phone')),
	CONSTRAINT "chat_voice_sessions_authority_check" CHECK ("chat_voice_sessions"."caller_authority" in ('member', 'instance_admin', 'local_board', 'guest_intake', 'pending_approval')),
	CONSTRAINT "chat_voice_sessions_counters_check" CHECK ("chat_voice_sessions"."generation" >= 1 and "chat_voice_sessions"."reply_cursor" >= 0),
	CONSTRAINT "chat_voice_sessions_token_check" CHECK ("chat_voice_sessions"."tool_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chat_voice_sessions_expiry_check" CHECK ("chat_voice_sessions"."expires_at" > "chat_voice_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_voice_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"provider_tool_call_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"tool" text NOT NULL,
	"delivery_id" uuid,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_tool_calls_tool_check" CHECK ("chat_voice_tool_calls"."tool" in ('submit_request', 'get_updates'))
);
--> statement-breakpoint
ALTER TABLE "chat_endpoints" DROP CONSTRAINT IF EXISTS "chat_endpoints_provider_check";--> statement-breakpoint
ALTER TABLE "chat_external_principals" DROP CONSTRAINT IF EXISTS "chat_external_principals_provider_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_transport_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_channel_transport_check";--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_replies_company_id_companies_id_fk' AND conrelid = 'chat_voice_replies'::regclass) THEN
    ALTER TABLE "chat_voice_replies" ADD CONSTRAINT "chat_voice_replies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_replies_session_fk' AND conrelid = 'chat_voice_replies'::regclass) THEN
    ALTER TABLE "chat_voice_replies" ADD CONSTRAINT "chat_voice_replies_session_fk" FOREIGN KEY ("company_id","session_id") REFERENCES "public"."chat_voice_sessions"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_replies_publication_fk' AND conrelid = 'chat_voice_replies'::regclass) THEN
    ALTER TABLE "chat_voice_replies" ADD CONSTRAINT "chat_voice_replies_publication_fk" FOREIGN KEY ("company_id","publication_id") REFERENCES "public"."chat_publications"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_sessions_company_id_companies_id_fk' AND conrelid = 'chat_voice_sessions'::regclass) THEN
    ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_sessions_endpoint_fk' AND conrelid = 'chat_voice_sessions'::regclass) THEN
    ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_sessions_conversation_fk' AND conrelid = 'chat_voice_sessions'::regclass) THEN
    ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."chat_conversations"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_sessions_issue_fk' AND conrelid = 'chat_voice_sessions'::regclass) THEN
    ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_sessions_agent_fk' AND conrelid = 'chat_voice_sessions'::regclass) THEN
    ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_agent_fk" FOREIGN KEY ("company_id","assigned_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_tool_calls_company_id_companies_id_fk' AND conrelid = 'chat_voice_tool_calls'::regclass) THEN
    ALTER TABLE "chat_voice_tool_calls" ADD CONSTRAINT "chat_voice_tool_calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_tool_calls_session_fk' AND conrelid = 'chat_voice_tool_calls'::regclass) THEN
    ALTER TABLE "chat_voice_tool_calls" ADD CONSTRAINT "chat_voice_tool_calls_session_fk" FOREIGN KEY ("company_id","session_id") REFERENCES "public"."chat_voice_sessions"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_tool_calls_delivery_fk' AND conrelid = 'chat_voice_tool_calls'::regclass) THEN
    ALTER TABLE "chat_voice_tool_calls" ADD CONSTRAINT "chat_voice_tool_calls_delivery_fk" FOREIGN KEY ("company_id","delivery_id") REFERENCES "public"."chat_deliveries"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_voice_replies_publication_uq" ON "chat_voice_replies" USING btree ("session_id","publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_voice_replies_cursor_uq" ON "chat_voice_replies" USING btree ("session_id","cursor");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_voice_sessions_provider_uq" ON "chat_voice_sessions" USING btree ("provider_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_voice_sessions_request_uq" ON "chat_voice_sessions" USING btree ("company_id","caller_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_voice_sessions_live_caller_task_uq" ON "chat_voice_sessions" USING btree ("company_id","caller_id","issue_id") WHERE "chat_voice_sessions"."state" not in ('ended', 'failed', 'expired');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_voice_sessions_expiry_idx" ON "chat_voice_sessions" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_voice_tool_calls_tool_uq" ON "chat_voice_tool_calls" USING btree ("session_id","provider_tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_voice_tool_calls_webhook_uq" ON "chat_voice_tool_calls" USING btree ("company_id","webhook_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_endpoints_provider_check' AND conrelid = 'chat_endpoints'::regclass) THEN
    ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_external_principals_provider_check' AND conrelid = 'chat_external_principals'::regclass) THEN
    ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_transport_check' AND conrelid = 'tool_connections'::regclass) THEN
    ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'rest_api', 'local_stdio', 'chat_sdk', 'voice', 'runtime_auth'));
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_channel_transport_check' AND conrelid = 'tool_connections'::regclass) THEN
    ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" not in ('chat_sdk', 'voice', 'runtime_auth'))
      or
      ("tool_connections"."connection_purpose" = 'channel' and ("tool_connections"."transport" in ('chat_sdk', 'voice') or ("tool_connections"."transport" = 'rest_api' and "tool_connections"."config"->>'provider' = 'agentmail')))
      or
      ("tool_connections"."connection_purpose" = 'ai' and "tool_connections"."transport" = 'runtime_auth')
    ));
  END IF;
END $$;