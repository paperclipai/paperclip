-- ZERA-579 / ZERA-580: canonical agent run-state taxonomy.
--
-- 1. Add `pause_origin` to discriminate operator pauses (taxonomy `paused`)
--    from platform safety-control halts (taxonomy `suspended`).
-- 2. Rename the `running` status value to `working` (one-release alias kept
--    in the AGENT_STATUSES enum; this rewrites stored rows).
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pause_origin" text;--> statement-breakpoint
UPDATE "agents"
SET "pause_origin" = CASE
	WHEN "pause_reason" = 'manual' THEN 'operator'
	WHEN "pause_reason" IS NULL THEN 'operator'
	ELSE 'platform'
END
WHERE "status" = 'paused' AND "pause_origin" IS NULL;--> statement-breakpoint
UPDATE "agents" SET "status" = 'working' WHERE "status" = 'running';
