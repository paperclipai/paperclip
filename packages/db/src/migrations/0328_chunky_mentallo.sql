CREATE TABLE IF NOT EXISTS "chat_voice_inbound_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"provider_session_id" text NOT NULL,
	"state" text DEFAULT 'awaiting_approval' NOT NULL,
	"approval_code" text NOT NULL,
	"generation" integer NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"tool_token_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"approved_by_user_id" text,
	"caller_authority" text,
	"requested_issue_id" uuid,
	"session_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_inbound_provider_uq" UNIQUE("provider_session_id"),
	CONSTRAINT "chat_voice_inbound_state_check" CHECK ("chat_voice_inbound_calls"."state" in ('awaiting_approval', 'approving', 'approved', 'denied', 'expired', 'ended')),
	CONSTRAINT "chat_voice_inbound_token_check" CHECK ("chat_voice_inbound_calls"."tool_token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chat_voice_inbound_code_check" CHECK ("chat_voice_inbound_calls"."approval_code" ~ '^[0-9]{6}$'),
	CONSTRAINT "chat_voice_inbound_generation_check" CHECK ("chat_voice_inbound_calls"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_voice_phone_lines" (
	"endpoint_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_number_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_phone_lines_number_uq" UNIQUE("provider_number_id"),
	CONSTRAINT "chat_voice_phone_lines_number_check" CHECK ("chat_voice_phone_lines"."phone_number" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_inbound_endpoint_fk' AND conrelid = 'chat_voice_inbound_calls'::regclass) THEN
    ALTER TABLE "chat_voice_inbound_calls" ADD CONSTRAINT "chat_voice_inbound_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_inbound_session_fk' AND conrelid = 'chat_voice_inbound_calls'::regclass) THEN
    ALTER TABLE "chat_voice_inbound_calls" ADD CONSTRAINT "chat_voice_inbound_session_fk" FOREIGN KEY ("company_id","session_id") REFERENCES "public"."chat_voice_sessions"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_phone_lines_endpoint_fk' AND conrelid = 'chat_voice_phone_lines'::regclass) THEN
    ALTER TABLE "chat_voice_phone_lines" ADD CONSTRAINT "chat_voice_phone_lines_endpoint_fk" FOREIGN KEY ("company_id","endpoint_id") REFERENCES "public"."chat_endpoints"("company_id","id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_voice_inbound_expiry_idx" ON "chat_voice_inbound_calls" USING btree ("state","expires_at");