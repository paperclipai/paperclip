UPDATE "issue_thread_interactions" AS interaction
SET
  "status" = 'cancelled',
  "result" = CASE interaction."kind"
    WHEN 'ask_user_questions' THEN jsonb_build_object(
      'version', 1,
      'answers', jsonb_build_array(),
      'cancelled', true,
      'cancellationReason', 'Issue already terminal',
      'summaryMarkdown', NULL
    )
    WHEN 'suggest_tasks' THEN jsonb_build_object(
      'version', 1,
      'cancelled', true,
      'cancellationReason', 'Issue already terminal'
    )
    WHEN 'request_confirmation' THEN jsonb_build_object(
      'version', 1,
      'outcome', 'cancelled',
      'reason', 'Issue already terminal'
    )
    ELSE interaction."result"
  END,
  "resolved_at" = COALESCE(interaction."resolved_at", NOW()),
  "updated_at" = NOW()
FROM "issues" AS issue
WHERE interaction."issue_id" = issue."id"
  AND interaction."company_id" = issue."company_id"
  AND interaction."status" = 'pending'
  AND issue."status" IN ('done', 'cancelled')
  AND interaction."kind" IN ('ask_user_questions', 'suggest_tasks', 'request_confirmation');
