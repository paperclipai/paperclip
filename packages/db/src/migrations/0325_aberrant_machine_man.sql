ALTER TABLE "chat_voice_tool_calls" DROP CONSTRAINT IF EXISTS "chat_voice_tool_calls_tool_check";--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_voice_tool_calls_tool_check' AND conrelid = 'chat_voice_tool_calls'::regclass) THEN
    ALTER TABLE "chat_voice_tool_calls" ADD CONSTRAINT "chat_voice_tool_calls_tool_check" CHECK ("chat_voice_tool_calls"."tool" in ('submit_request', 'get_updates', 'answer_question'));
  END IF;
END $$;