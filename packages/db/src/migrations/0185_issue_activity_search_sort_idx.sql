-- paperclip:migration-safety-ignore large-create-index-not-concurrently: embedded migrations run transactionally, so CONCURRENTLY is not usable here and the partial predicate limits the index to issue activity rows needed for issue search ordering.
CREATE INDEX "activity_log_issue_entity_sort_idx" ON "activity_log" USING btree ("entity_id","company_id","created_at" DESC)
WHERE "entity_type" = 'issue'
  AND "action" NOT IN ('issue.read_marked', 'issue.read_unmarked', 'issue.inbox_archived', 'issue.inbox_unarchived');
