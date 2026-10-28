ALTER TABLE "chat_voice_inbound_calls" ADD COLUMN IF NOT EXISTS "provider_account_id" text;--> statement-breakpoint
ALTER TABLE "chat_voice_inbound_calls" ADD COLUMN IF NOT EXISTS "cleanup_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_voice_inbound_calls" ADD COLUMN IF NOT EXISTS "cleanup_next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_voice_inbound_cleanup_idx" ON "chat_voice_inbound_calls" USING btree ("id") WHERE "chat_voice_inbound_calls"."cleanup_confirmed_at" is null;
--> statement-breakpoint
DO $$
DECLARE cursor_id uuid; batch_ids uuid[];
BEGIN
  LOOP
    IF cursor_id IS NULL THEN
      SELECT array_agg(id ORDER BY id) INTO batch_ids FROM (
        SELECT id FROM chat_voice_inbound_calls WHERE cleanup_confirmed_at IS NULL ORDER BY id LIMIT 1000
      ) batch;
    ELSE
      SELECT array_agg(id ORDER BY id) INTO batch_ids FROM (
        SELECT id FROM chat_voice_inbound_calls WHERE cleanup_confirmed_at IS NULL AND id > cursor_id ORDER BY id LIMIT 1000
      ) batch;
    END IF;
    EXIT WHEN batch_ids IS NULL;
    UPDATE chat_voice_inbound_calls c
    SET cleanup_confirmed_at = c.updated_at
    WHERE c.id = ANY(batch_ids) AND c.cleanup_confirmed_at IS NULL AND c.state = 'ended'
      AND (c.approved_by_user_id IS NULL OR EXISTS (
        SELECT 1 FROM activity_log a
        WHERE a.company_id = c.company_id AND a.entity_type = 'voice_inbound_call'
          AND a.entity_id = c.id::text AND a.action = 'voice.call.ended'
      ));
    cursor_id := batch_ids[array_length(batch_ids, 1)];
    COMMIT;
  END LOOP;
END $$;
