-- JAC-4747: Schema migration for hierarchical agent folder structure.
--
-- This migration adds:
--   - agent_folders table: a company-scoped hierarchical folder structure for
--     organizing agents (agent instructions hierarchy), with self-referencing
--     parentId for nested folders.
--   - agents.folder_id column: FK referencing agent_folders.id (nullable),
--     enabling agents to be filed under a folder.
--
-- The agent_folders table is distinct from the existing `folders` table, which
-- is used for routine/skill items. agent_folders is specifically for the
-- agent instructions hierarchy.

--> statement-breakpoint

-- Create the agent_folders table.
CREATE TABLE IF NOT EXISTS "agent_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies" ("id") ON DELETE CASCADE,
  "parent_id" uuid REFERENCES "agent_folders" ("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "metadata" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE "agent_folders" IS 'Hierarchical folders for organizing agents — agent instructions hierarchy (JAC-4747).';

--> statement-breakpoint

-- Unique constraint: (company_id, parent_id, slug) — root or under a parent, slug is unique.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_folders_company_parent_slug_uq"
  ON "agent_folders" USING btree ("company_id", "parent_id", "slug")
  WHERE "parent_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_folders_company_parent_slug_child_uq"
  ON "agent_folders" USING btree ("company_id", "parent_id", "slug")
  WHERE "parent_id" IS NOT NULL;

-- Unique constraint: (company_id, parent_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS "agent_folders_company_parent_name_root_uq"
  ON "agent_folders" USING btree ("company_id", "parent_id", "name")
  WHERE "parent_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_folders_company_parent_name_child_uq"
  ON "agent_folders" USING btree ("company_id", "parent_id", "name")
  WHERE "parent_id" IS NOT NULL;

--> statement-breakpoint

-- Index for folder tree traversal and ordering.
CREATE INDEX IF NOT EXISTS "agent_folders_company_parent_sort_idx"
  ON "agent_folders" USING btree ("company_id", "parent_id", "sort_order", "name");

--> statement-breakpoint

-- Add folder_id to agents table.
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "folder_id" uuid REFERENCES "agent_folders" ("id") ON DELETE SET NULL;

COMMENT ON COLUMN "agents"."folder_id" IS 'FK to agent_folders for organizing agents into a hierarchical folder structure (JAC-4747).';

CREATE INDEX IF NOT EXISTS "agents_company_folder_idx"
  ON "agents" USING btree ("company_id", "folder_id");
