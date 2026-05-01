-- Migration: add_agent_executor
-- Spec: projects/jarvis-os-redesign/docs/2026-04-30-system-redesign-design.md, Phase 0.5 Step 1.
-- Phase: 0.5 draft. Validate in sandbox before any production apply.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "executor" text DEFAULT 'mc-dispatch' NOT NULL;
--> statement-breakpoint
UPDATE "agents" SET "executor" = 'mc-dispatch' WHERE "executor" IS NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "executor" SET DEFAULT 'mc-dispatch';
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "executor" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agents_executor_check'
      AND conrelid = 'public.agents'::regclass
  ) THEN
    ALTER TABLE "agents"
      ADD CONSTRAINT "agents_executor_check"
      CHECK ("executor" IN ('hermes', 'mc-dispatch'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_executor_idx" ON "agents" USING btree ("executor");
