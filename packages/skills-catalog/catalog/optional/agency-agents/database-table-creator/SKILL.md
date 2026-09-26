---
name: "database-table-creator"
description: "Creates database table with full Kotlin synchronization (SQL migration → Table → Entity → Repository → Tests). Use when adding new database tables or entities."
allowed_tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/database-table-creator"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "database"
  - "table"
  - "creator"
defaultInstall: false
---
# Database Table Creator Skill

Creates complete database table implementation with SQL migration, Kotlin code, and comprehensive tests.

## What This Skill Does

Generates:
1. **SQL Migration** - PostgreSQL table with soft deletes, indexes, triggers
2. **Kotlin Table Object** - Exposed ORM table definition (extends UUIDTable)
3. **Entity Data Class** - Kotlin entity implementing Entity<Instant>
4. **Repository Interface + Implementation** - CRUD operations with soft delete
5. **Repository Tests** - Comprehensive test coverage (7+ tests)
6. **Factory Bean** - Dependency injection registration

## Critical Rules

### Database Design (rules/database/SCHEMA.md)

**SQL Requirements**:
- ❌ NO foreign key constraints (NEVER use REFERENCES or FOREIGN KEY)
- ✅ Use TEXT for strings (NOT VARCHAR)
- ✅ Include: id (UUID), created_at, updated_at, deleted_at
- ✅ ALL indexes MUST have `WHERE deleted_at IS NULL`
- ✅ Add soft delete index: `WHERE deleted_at IS NOT NULL`
- ✅ Add update trigger for updated_at

**Kotlin Requirements**:
- ✅ Table MUST extend `UUIDTable` (NOT `Table`)
- ✅ Entity MUST implement `Entity<Instant>`
- ✅ ALL queries MUST filter `deletedAt.isNull()`
- ❌ NO `!!` operators (forbidden by pre-commit hooks)
- ✅ Soft delete only (set deletedAt, never hard delete)

## Workflow

### Step 1: Create SQL Migration

Location: `database-migration/sql/{number}-{description}.sql`

```sql
-- ============================================================================
-- Description: [Describe what this migration does]
-- Table: {table_name}
-- ============================================================================

CREATE TABLE {table_name} (
    -- Primary key (REQUIRED)
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Business columns
    name TEXT NOT NULL,
    email TEXT,
    status TEXT DEFAULT 'active',
    user_id UUID,
    count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB,

    -- Standard timestamps (REQUIRED)
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP,
    deleted_at TIMESTAMP
);

-- Unique index (allows duplicate soft-deleted records)
CREATE UNIQUE INDEX idx_{table_name}_email_unique
    ON {table_name}(email) WHERE deleted_at IS NULL;

-- Foreign key index (NO FK constraint, just index)
CREATE INDEX idx_{table_name}_user_id
    ON {table_name}(user_id) WHERE deleted_at IS NULL;

-- Soft delete index (REQUIRED)
CREATE INDEX idx_{table_name}_deleted_at
    ON {table_name}(deleted_at) WHERE deleted_at IS NOT NULL;

-- Update trigger (REQUIRED)
CREATE TRIGGER update_{table_name}_updated_at
BEFORE UPDATE ON {table_name}
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();
```

**Critical**:
- Use TEXT not VARCHAR
- NO REFERENCES or FOREIGN KEY
- ALL indexes have WHERE clause
- Soft delete index required
- Update trigger required

### Step 2: Run Migration

```bash
./gradlew :app:module-repository:flywayMigrate
```

Verify success before proceeding.

### Steps 3-10: Kotlin Implementation

> See `kotlin-templates.md` for all Kotlin code templates (Table, Entity, Repository, Factory Bean, Tests).

Follow this order:
1. **Step 3** — Table object (extends `UUIDTable`, use `text()` not `varchar()`)
2. **Step 4** — Entity data class (implements `Entity<Instant>`)
3. **Step 5** — Constants/Enums (if needed)
4. **Step 6** — Repository interface
5. **Step 7** — Repository implementation (`db.primary` for writes, `db.replica` for reads, ALWAYS filter `deletedAt.isNull()`)
6. **Step 8** — Factory bean registration
7. **Step 9** — Repository tests (minimum 7 tests, must include soft delete verification)
8. **Step 10** — Run tests: `./gradlew test`

## Common Mistakes to Avoid

> See `examples.md` for common mistakes and anti-patterns.

## Success Criteria

✅ SQL migration runs successfully
✅ Uses TEXT (not VARCHAR)
✅ NO foreign key constraints
✅ All indexes have WHERE clause
✅ Kotlin Table extends UUIDTable
✅ Entity implements Entity<Instant>
✅ All queries filter deletedAt.isNull()
✅ No !! operators
✅ Soft delete only (no hard delete)
✅ Factory bean registered
✅ All 7+ tests pass
