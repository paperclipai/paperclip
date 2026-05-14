-- Phase 1 / Task 1.2 of the Linear ↔ Paperclip ID Unification plan.
-- See onprem-k8s commit 9979d0d / .planning/linear-id-unification.md.
--
-- Add a per-company switch for which system mints issue identifiers:
--   "paperclip" → existing path (issue_prefix + issue_counter, locally).
--   "linear"    → identifiers minted by Linear and mirrored at create-time
--                 via the paperclip-plugin-linear adapter.
--
-- Default is "paperclip" so this migration is a no-op for every existing
-- row. The BLO company will be flipped to "linear" only after Phase 3 of
-- the plan re-prefixes its 2377 paperclip-only BLO-N issues to PCL-N
-- (audit findings: onprem-k8s/.planning/linear-id-audit.sql, run 2026-05-03).
ALTER TABLE "companies"
  ADD COLUMN "identifier_provider" text DEFAULT 'paperclip' NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_identifier_provider_check"
  CHECK ("identifier_provider" IN ('paperclip', 'linear'));
