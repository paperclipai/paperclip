CREATE TABLE IF NOT EXISTS "roadmap_block_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "block_id" uuid NOT NULL REFERENCES "roadmap_blocks"("id") ON DELETE CASCADE,
  "goal_id" uuid NOT NULL REFERENCES "goals"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "roadmap_block_links_company_block_idx" ON "roadmap_block_links" ("company_id", "block_id");
CREATE UNIQUE INDEX IF NOT EXISTS "roadmap_block_links_block_goal_uq" ON "roadmap_block_links" ("block_id", "goal_id");

-- Backfill from the old single-link column, then drop it (guarded so the
-- migration stays re-runnable).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'roadmap_blocks' AND column_name = 'linked_goal_id'
  ) THEN
    INSERT INTO "roadmap_block_links" ("company_id", "block_id", "goal_id")
    SELECT "company_id", "id", "linked_goal_id" FROM "roadmap_blocks"
    WHERE "linked_goal_id" IS NOT NULL
    ON CONFLICT DO NOTHING;
    ALTER TABLE "roadmap_blocks" DROP COLUMN "linked_goal_id";
  END IF;
END $$;
