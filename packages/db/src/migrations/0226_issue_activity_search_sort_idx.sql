-- A copied worktree can retain this index after its migration journal entry is lost.
-- Replay only the exact expected index so migration history repair cannot hide schema drift.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: this block only compares pg_get_indexdef text; it does not create an index.
DO $$
DECLARE
  expected_definition constant text := 'CREATE INDEX activity_log_issue_entity_sort_idx ON public.activity_log USING btree (entity_id, company_id, created_at DESC) WHERE ((entity_type = ''issue''::text) AND (action <> ALL (ARRAY[''issue.read_marked''::text, ''issue.read_unmarked''::text, ''issue.inbox_archived''::text, ''issue.inbox_unarchived''::text])))';
  existing_definition text;
  existing_is_valid boolean;
BEGIN
  IF to_regclass('public.activity_log_issue_entity_sort_idx') IS NULL THEN
    RETURN;
  END IF;

  SELECT pg_get_indexdef(index_meta.indexrelid), index_meta.indisvalid AND index_meta.indisready
  INTO existing_definition, existing_is_valid
  FROM pg_index AS index_meta
  WHERE index_meta.indexrelid = to_regclass('public.activity_log_issue_entity_sort_idx');

  IF existing_definition IS NULL OR NOT COALESCE(existing_is_valid, false)
    OR existing_definition <> expected_definition THEN
    RAISE EXCEPTION
      'activity_log_issue_entity_sort_idx exists with an incompatible definition: %',
      COALESCE(existing_definition, '<not an index>');
  END IF;
END $$;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: embedded migrations run transactionally, so CONCURRENTLY is not usable here and the partial predicate limits the index to issue activity rows needed for issue search ordering.
CREATE INDEX IF NOT EXISTS "activity_log_issue_entity_sort_idx" ON "activity_log" USING btree ("entity_id","company_id","created_at" DESC)
WHERE "entity_type" = 'issue'
  AND "action" NOT IN ('issue.read_marked', 'issue.read_unmarked', 'issue.inbox_archived', 'issue.inbox_unarchived');
