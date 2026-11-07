CREATE TABLE IF NOT EXISTS "chat_voice_reports" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_micro_usd" text,
	"duration_seconds" integer,
	"provider_updated_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_reports_status_check" CHECK ("chat_voice_reports"."status" in ('pending', 'available', 'unavailable')),
	CONSTRAINT "chat_voice_reports_cost_check" CHECK ("chat_voice_reports"."cost_micro_usd" is null or "chat_voice_reports"."cost_micro_usd" ~ '^[0-9]{1,30}$'),
	CONSTRAINT "chat_voice_reports_duration_check" CHECK ("chat_voice_reports"."duration_seconds" is null or "chat_voice_reports"."duration_seconds" >= 0),
	CONSTRAINT "chat_voice_reports_attempts_check" CHECK ("chat_voice_reports"."attempts" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_reports_session_fk' AND conrelid = 'chat_voice_reports'::regclass) THEN
    ALTER TABLE "chat_voice_reports" ADD CONSTRAINT "chat_voice_reports_session_fk" FOREIGN KEY ("company_id","session_id") REFERENCES "public"."chat_voice_sessions"("company_id","id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_voice_reports_pending_idx" ON "chat_voice_reports" USING btree ("status","next_check_at");