-- CAR-214: Fix-SHA closure-gate routine per-company toggle.
-- Adds a per-company config flag that controls whether agent-issued
-- "done" transitions are gated on a verified Fix-SHA in the closure
-- comment. Values: 'off' (no enforcement, default), 'advisory'
-- (log-only canary mode), 'enforce' (reject PATCH /api/issues/:id
-- when the SHA is missing or unreachable on the target branch).
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "closure_gate_fix_sha" text NOT NULL DEFAULT 'off';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'companies_closure_gate_fix_sha_check'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE "companies"
      ADD CONSTRAINT "companies_closure_gate_fix_sha_check"
      CHECK ("closure_gate_fix_sha" IN ('off', 'advisory', 'enforce'));
  END IF;
END
$$;
