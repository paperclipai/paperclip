ALTER TABLE "chat_voice_phone_lines" ADD COLUMN IF NOT EXISTS "low_trust_environment_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_phone_lines_low_trust_environment_id_environments_id_fk' AND conrelid = 'chat_voice_phone_lines'::regclass) THEN
    ALTER TABLE "chat_voice_phone_lines" ADD CONSTRAINT "chat_voice_phone_lines_low_trust_environment_id_environments_id_fk" FOREIGN KEY ("low_trust_environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
