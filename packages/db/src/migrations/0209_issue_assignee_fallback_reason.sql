-- RBR-767 / RBR-796: fail visible, never fail closed.
--
-- When the assignee fallback ladder cannot find an invokable owner we still create the
-- issue (assigning the company root even if it is currently paused) and record why here.
-- This column is the first-class sweep input: `scripts/rbr767-sweep.ts` selects on it to
-- re-route degraded-roster work once agents come back, so a degraded roster produces a
-- worklist rather than a company-wide write outage.
--
-- Additive and nullable: NULL means the healthy path, no backfill required.
--
-- RBR-871: this shipped as `0207_issue_assignee_fallback_reason.sql` before the rebase
-- onto master, which collided with master's own 0207. `IF NOT EXISTS` is deliberate --
-- any environment that already applied the old 0207 must not fail here on the renumber.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "assignee_fallback_reason" text;--> statement-breakpoint
-- Partial index: the healthy path leaves the column NULL, so this stays small.
CREATE INDEX IF NOT EXISTS "issues_company_assignee_fallback_reason_idx" ON "issues" USING btree ("company_id","assignee_fallback_reason") WHERE "issues"."assignee_fallback_reason" is not null;
