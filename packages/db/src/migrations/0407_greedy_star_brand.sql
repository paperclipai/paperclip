CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_instruction_copies_cleanup_idx" ON "agent_instruction_working_copies" USING btree ("run_id","company_id") WHERE "agent_instruction_working_copies"."state" IN ('saved', 'unchanged', 'resolved', 'unavailable')
      AND "agent_instruction_working_copies"."process_stopped_at" IS NOT NULL
      AND "agent_instruction_working_copies"."receipt"->>'schema' = 'paperclip.agent-files.v1'
      AND coalesce("agent_instruction_working_copies"."receipt"->>'retainedByRunId', '') = ''
      AND "agent_instruction_working_copies"."receipt"->>'cleanupPending' IS DISTINCT FROM 'false'
      AND ("agent_instruction_working_copies"."receipt" ? 'baseline' OR "agent_instruction_working_copies"."receipt"->>'cleanupPending' = 'true');