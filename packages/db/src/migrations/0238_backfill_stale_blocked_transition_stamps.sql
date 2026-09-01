-- One-time cleanup for rows left behind by a pre-fix bug in the sibling
-- code change in this same migration set: several write sites could take a
-- row out of `blocked` without clearing `blocked_transition_at` (only
-- `update()`'s own exit branch and `checkout()` did). Any row currently NOT
-- in `blocked` but still carrying a stamp is a leftover from one of those
-- paths.
--
-- These rows are not an active wake-suppression risk today: the dependency
-- backstop that reads `blocked_transition_at` as a wake cycle key
-- (`issue-dependency-wakeups.ts`) only queries rows where
-- `status = 'blocked'` (`recovery/service.ts`), so a stale stamp on a
-- non-blocked row is currently dormant. The risk was that a stale stamp
-- would survive a future re-entry into `blocked` uncleared; the code fix in
-- this same change set makes the entry branch unconditional again, so any
-- future transition into `blocked` always overwrites whatever stamp (stale
-- or absent) was there. This migration is hygiene, not a suppression-bug
-- fix, and does not gate the code fix landing.
--
-- The issues table is small enough (medium size bucket, well under the
-- large-table threshold) that a single unbounded UPDATE with a selective
-- predicate is fine here — no batching needed per doc/DATABASE.md's
-- migration checklist.
UPDATE "issues"
SET
  "unblock_descriptor" = NULL,
  "blocked_transition_at" = NULL,
  "blocked_owner_notified_at" = NULL
WHERE "status" <> 'blocked'
  AND "blocked_transition_at" IS NOT NULL;
