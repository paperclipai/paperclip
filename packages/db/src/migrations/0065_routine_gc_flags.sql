ALTER TABLE "routines" ADD COLUMN "auto_gc_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Set scan-style (check-gate) routines to auto_gc_enabled=true per MHDS 2026-04-20 verdict (AKS-1244).
-- Review Orchestrator keeps the default false.
UPDATE "routines" SET "auto_gc_enabled" = true WHERE "id" IN (
  '0284ad5a-5eb6-4da4-90b0-c686baa3ef9b',
  '0612004f-160a-4570-a413-fdd7f6edb50f',
  '387d5914-f225-455f-a083-c0e588ac726d'
);
