-- Phase 1 / Task 1.3 of the Linear ↔ Paperclip ID Unification plan.
-- See onprem-k8s commit 9979d0d / .planning/linear-id-unification.md.
--
-- Stash a row's pre-rename identifier so a backfill can be reverted
-- without re-deriving from row order. Used by Phase 3 (BLO→PCL re-prefix
-- for paperclip-only issues): each renamed row sets legacy_identifier to
-- its old "BLO-N" before identifier flips to "PCL-N". The partial index
-- keeps the column cheap on greenfield rows where it stays NULL.
ALTER TABLE "issues"
  ADD COLUMN "legacy_identifier" text;
--> statement-breakpoint
CREATE INDEX "issues_legacy_identifier_idx" ON "issues" ("legacy_identifier")
  WHERE "legacy_identifier" IS NOT NULL;
