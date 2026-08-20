-- Add sync_metadata column to routines and goals tables
-- Supports Beads/Linear/Ringer/ContextForge sync metadata for JAC-3490

ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "sync_metadata" jsonb DEFAULT '{}'::jsonb;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "sync_metadata" jsonb DEFAULT '{}'::jsonb;
