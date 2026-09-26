-- ============================================================================
-- Description: [REPLACE: Describe what this migration does]
-- Table: [REPLACE: table_name]
-- Date: [REPLACE: YYYY-MM-DD]
-- ============================================================================

-- Create table
CREATE TABLE [REPLACE_table_name] (
    -- Primary key (REQUIRED for all tables)
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- [REPLACE: Add your business columns here]
    -- Examples:
    -- name TEXT NOT NULL,
    -- email TEXT,
    -- status TEXT DEFAULT 'active',
    -- user_id UUID,
    -- count INTEGER DEFAULT 0,
    -- is_active BOOLEAN DEFAULT true,
    -- metadata JSONB,

    -- Standard timestamp columns (REQUIRED for all tables)
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP,
    deleted_at TIMESTAMP
);

-- Indexes
-- CRITICAL: ALL indexes MUST include "WHERE deleted_at IS NULL"

-- Unique index example (prevents duplicate active records, allows duplicate soft-deleted)
-- CREATE UNIQUE INDEX idx_[REPLACE_table_name]_[REPLACE_column]_unique
--     ON [REPLACE_table_name]([REPLACE_column]) WHERE deleted_at IS NULL;

-- Foreign key index example (no FK constraint, just index for performance)
-- CREATE INDEX idx_[REPLACE_table_name]_[REPLACE_foreign_key]
--     ON [REPLACE_table_name]([REPLACE_foreign_key]) WHERE deleted_at IS NULL;

-- Soft delete index (REQUIRED for all tables with soft deletes)
CREATE INDEX idx_[REPLACE_table_name]_deleted_at
    ON [REPLACE_table_name](deleted_at) WHERE deleted_at IS NOT NULL;

-- Update trigger (REQUIRED for all tables except immutable audit tables)
CREATE TRIGGER update_[REPLACE_table_name]_updated_at
BEFORE UPDATE ON [REPLACE_table_name]
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- CRITICAL RULES (from rules/database/SCHEMA.md):
-- ============================================================================
-- ✅ Use TEXT for strings (NEVER VARCHAR)
-- ✅ Use UUID for primary keys and foreign keys
-- ✅ Use TIMESTAMP for dates/times
-- ✅ Include: id, created_at, updated_at, deleted_at
-- ✅ Add WHERE deleted_at IS NULL to ALL indexes
-- ✅ Add soft delete index on deleted_at
-- ✅ Add update trigger for updated_at
--
-- ❌ NO FOREIGN KEY constraints
-- ❌ NO REFERENCES clauses
-- ❌ NO ON DELETE CASCADE
-- ❌ NO VARCHAR (use TEXT instead)
-- ============================================================================

-- [OPTIONAL: Add comments explaining business logic]
-- COMMENT ON TABLE [REPLACE_table_name] IS 'Brief description of table purpose';
-- COMMENT ON COLUMN [REPLACE_table_name].[REPLACE_column] IS 'Brief description of column';
