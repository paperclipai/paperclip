-- paperclip:migration-compat online_compatible: a one-time UPDATE of GitHub request comments whose acknowledgement retries ran out before the settle fixes shipped; it touches only failed, non-final github_response_comment rows that already hold a posted comment, and the previous release treats a processed row the same way it treats any acknowledged request. The same release stops acknowledgement retries from giving up, so this backfill is needed once.
UPDATE "chat_actions"
SET "status" = 'processed',
  "result" = ("result" - 'terminalWaitKey' - 'retryAt') || jsonb_build_object('attempts', 0, 'retryable', false, 'code', 'recovered_after_exhausted_retries'),
  "updated_at" = now()
WHERE "kind" = 'github_response_comment'
  AND "status" = 'failed'
  AND "delivery_id" IS NOT NULL
  AND coalesce("result"->>'final', 'false') <> 'true'
  AND coalesce("result"->>'retryable', 'false') <> 'true'
  AND "result"->>'id' ~ '^[1-9][0-9]*$';
