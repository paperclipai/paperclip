-- RBR-791: retire board asks that are pending on already-closed issues.
--
-- `expirePendingInteractionsForTerminalIssue` (#10251) prevents new
-- accumulation from the moment an issue transitions to done/cancelled, but it
-- only fires on the transition. Interactions filed before that shipped, or
-- filed on issues that closed by a path that predates the hook, are still
-- `pending` on issues that can never answer them. They are unanswerable by
-- construction and inflate the board's decision queue.
--
-- This backfill applies the exact same terminal-issue outcome the runtime hook
-- writes (`status = 'expired'`, `result.outcome = 'issue_closed'`), so
-- backfilled rows are indistinguishable from ones the hook would have produced.
-- Resolution attribution is left NULL: no actor decided these, the system
-- voided them.
--
-- Deliberately NOT touched:
--   * pending interactions on open issues (a real board decision may be owed),
--   * anything already resolved (accepted/rejected/answered/cancelled/expired).
--
-- The result shapes match the per-kind result validators:
--   ask_user_questions   -> { outcome, reason, answers, summaryMarkdown }
--   suggest_tasks        -> { outcome, reason }
--   request_item_verdicts-> { outcome, reason, complete, items }
--   confirmation kinds   -> { outcome, reason }

UPDATE "issue_thread_interactions" AS iti
SET
  "status" = 'expired',
  "result" = CASE
    WHEN iti."kind" = 'ask_user_questions' THEN
      jsonb_build_object(
        'version', 1,
        'outcome', 'issue_closed',
        'reason', NULL,
        'answers', '[]'::jsonb,
        'summaryMarkdown', NULL
      )
    WHEN iti."kind" = 'request_item_verdicts' THEN
      jsonb_build_object(
        'version', 1,
        'outcome', 'issue_closed',
        'reason', NULL,
        'complete', false,
        'items', COALESCE(iti."result" -> 'items', '[]'::jsonb)
      )
    ELSE
      jsonb_build_object(
        'version', 1,
        'outcome', 'issue_closed',
        'reason', NULL
      )
  END,
  "resolved_at" = now(),
  "updated_at" = now()
FROM "issues" AS i
WHERE
  iti."issue_id" = i."id"
  AND iti."company_id" = i."company_id"
  AND iti."status" = 'pending'
  AND i."status" IN ('done', 'cancelled');

-- A parked tool call must not outlive the card that governs it: the runtime
-- hook expires linked tool_action_requests in the same transaction, so the
-- backfill does too. `executing`/`executed` rows are in flight and are left
-- alone — the gateway reflects their outcome back onto the (now expired) card.
UPDATE "tool_action_requests" AS tar
SET
  "status" = 'expired',
  "resolved_at" = now(),
  "updated_at" = now()
FROM "issue_thread_interactions" AS iti
JOIN "issues" AS i
  ON iti."issue_id" = i."id"
 AND iti."company_id" = i."company_id"
WHERE
  tar."interaction_id" = iti."id"
  AND tar."company_id" = iti."company_id"
  AND tar."status" IN ('pending', 'approved')
  AND iti."kind" = 'request_confirmation'
  AND iti."status" = 'expired'
  AND (iti."result" ->> 'outcome') = 'issue_closed'
  AND i."status" IN ('done', 'cancelled');
