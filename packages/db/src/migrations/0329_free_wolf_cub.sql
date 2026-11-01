ALTER TABLE "chat_voice_inbound_calls" DROP CONSTRAINT IF EXISTS "chat_voice_inbound_state_check";--> statement-breakpoint
ALTER TABLE "chat_voice_inbound_calls" ADD COLUMN IF NOT EXISTS "intake_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_voice_phone_lines" ADD COLUMN IF NOT EXISTS "guest_intake" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_inbound_intake_fk' AND conrelid = 'chat_voice_inbound_calls'::regclass) THEN
    ALTER TABLE "chat_voice_inbound_calls" ADD CONSTRAINT "chat_voice_inbound_intake_fk" FOREIGN KEY ("company_id","intake_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_inbound_requested_issue_fk' AND conrelid = 'chat_voice_inbound_calls'::regclass) THEN
    ALTER TABLE "chat_voice_inbound_calls" ADD CONSTRAINT "chat_voice_inbound_requested_issue_fk" FOREIGN KEY ("company_id","requested_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_inbound_state_check' AND conrelid = 'chat_voice_inbound_calls'::regclass) THEN
    ALTER TABLE "chat_voice_inbound_calls" ADD CONSTRAINT "chat_voice_inbound_state_check" CHECK ("chat_voice_inbound_calls"."state" in ('guest_intake', 'awaiting_approval', 'approving', 'approved', 'denied', 'expired', 'ended'));
  END IF;
END $$;