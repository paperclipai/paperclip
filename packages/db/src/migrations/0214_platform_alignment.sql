ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "goal_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "goal_id" uuid NOT NULL REFERENCES "goals"("id") ON DELETE CASCADE,
  "parent_id" uuid REFERENCES "goal_targets"("id") ON DELETE CASCADE,
  "text" text NOT NULL,
  "checked" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "goal_targets_company_goal_idx" ON "goal_targets" ("company_id", "goal_id");

CREATE TABLE IF NOT EXISTS "goal_relations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "type" text NOT NULL,
  "from_goal_id" uuid NOT NULL REFERENCES "goals"("id") ON DELETE CASCADE,
  "to_goal_id" uuid REFERENCES "goals"("id") ON DELETE CASCADE,
  "to_target_id" uuid REFERENCES "goal_targets"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "goal_relations_company_from_idx" ON "goal_relations" ("company_id", "from_goal_id");
CREATE INDEX IF NOT EXISTS "goal_relations_company_to_goal_idx" ON "goal_relations" ("company_id", "to_goal_id");
CREATE INDEX IF NOT EXISTS "goal_relations_company_to_target_idx" ON "goal_relations" ("company_id", "to_target_id");

CREATE TABLE IF NOT EXISTS "roadmap_blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "title" text NOT NULL,
  "detail" text,
  "status" text NOT NULL DEFAULT 'planned',
  "x" integer NOT NULL DEFAULT 0,
  "y" integer NOT NULL DEFAULT 0,
  "linked_goal_id" uuid REFERENCES "goals"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "roadmap_blocks_company_idx" ON "roadmap_blocks" ("company_id");

CREATE TABLE IF NOT EXISTS "roadmap_block_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "from_block_id" uuid NOT NULL REFERENCES "roadmap_blocks"("id") ON DELETE CASCADE,
  "to_block_id" uuid NOT NULL REFERENCES "roadmap_blocks"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "roadmap_block_edges_company_idx" ON "roadmap_block_edges" ("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "roadmap_block_edges_company_edge_uq" ON "roadmap_block_edges" ("company_id", "from_block_id", "to_block_id");
