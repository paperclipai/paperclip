-- Cache *write* tokens are billed at a premium (Anthropic: 1.25x input) and were
-- never persisted: no adapter wrote them and the drizzle schema did not map them.
--
-- The column already exists on some deployments, added out-of-band without a
-- migration -- production carries it with no matching entry here or in any
-- snapshot. IF NOT EXISTS makes this converge either way, whether or not the
-- column is already present.
--
-- No meta/0132_snapshot.json accompanies this migration, matching every
-- migration since 0099: this repo stopped emitting drizzle snapshots 33
-- migrations ago and hand-writes SQL instead. Do not add a lone snapshot here --
-- it would capture a schema state stale by those 33 migrations and make the next
-- drizzle generate propose dropping everything added since. Re-adopting generate
-- means rebuilding the snapshot chain, not patching one file.
ALTER TABLE "cost_events"
  ADD COLUMN IF NOT EXISTS "cache_creation_input_tokens" integer DEFAULT 0 NOT NULL;
