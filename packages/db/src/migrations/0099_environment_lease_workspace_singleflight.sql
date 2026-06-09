-- Single-flight guardrail for shared execution workspaces.
--
-- Before this migration, `environment_leases` could hold multiple ACTIVE
-- ephemeral leases pointing at the same (environment_id, execution_workspace_id),
-- which allowed two heartbeat runs — even ones arriving through different
-- issues — to concurrently mutate the same shared local/SSH checkout/branch
-- (the RTR-12 near-miss class of bug).
--
-- Step 1 backfills existing data so the unique index can be created safely:
-- where duplicate active ephemeral leases already exist for a workspace, keep
-- the most recently acquired one active and expire the rest.
WITH ranked AS (
	SELECT
		id,
		row_number() OVER (
			PARTITION BY environment_id, execution_workspace_id
			ORDER BY acquired_at DESC, created_at DESC
		) AS rn
	FROM environment_leases
	WHERE status = 'active'
		AND execution_workspace_id IS NOT NULL
		AND lease_policy = 'ephemeral'
)
UPDATE environment_leases AS el
SET
	status = 'expired',
	released_at = now(),
	last_used_at = now(),
	updated_at = now(),
	failure_reason = COALESCE(el.failure_reason, 'superseded: single-flight workspace lease backfill')
FROM ranked
WHERE el.id = ranked.id
	AND ranked.rn > 1;--> statement-breakpoint
-- Step 2 enforces the invariant durably going forward.
CREATE UNIQUE INDEX "environment_leases_active_workspace_singleflight_idx"
	ON "environment_leases" USING btree ("environment_id", "execution_workspace_id")
	WHERE "status" = 'active' AND "execution_workspace_id" IS NOT NULL AND "lease_policy" = 'ephemeral';
