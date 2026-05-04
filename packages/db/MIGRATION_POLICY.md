# RT2 Database Migration Policy

This document defines the versioned migration structure and maintenance conventions for the RealTycoon2 database schema.

## Version Format

Migrations use sequential 4-digit version numbers:

```
NNNN_<description>.sql
```

Examples:
- `0113_rt2_v33_work_entities.sql`
- `0114_rt2_schema_validation.sql`

**Rule:** Never reuse a version number. Always increment.

## Migration Structure

The project uses Drizzle's journal-based migration system (`meta/_journal.json`).

```
src/migrations/
├── 0000_mature_masked_marvel.sql
├── 0001_fast_northstar.sql
├── ...
├── 0113_rt2_v33_work_entities.sql     ← latest
└── meta/
    └── _journal.json                  ← tracks applied migrations
```

Each migration is a single `.sql` file. The journal entry is added after the migration file is created.

### Creating a New Migration

1. Create the migration file: `NNNN_description.sql`
2. Add the journal entry in `meta/_journal.json`:
   ```json
   {
     "idx": NNN,
     "version": "7",
     "when": TIMESTAMP_MS,
     "tag": "NNNN_description",
     "breakpoints": true
   }
   ```
3. Run `pnpm run check:migrations` to verify

## Rollback Convention

**The project does not use automatic rollback migrations.** Rollback is manual.

For each migration, document the rollback SQL in this policy (see Rollback Reference below).

### Rollback Process

```bash
# Manual rollback (apply rollback SQL directly)
psql $DATABASE_URL < src/migrations/NNNN_rollback.sql

# Or use drizzle-kit rollback if configured
pnpm drizzle-kit rollback
```

### Rollback Rules

1. Drop in reverse order of creation:
   - Drop foreign keys before tables
   - Drop indexes before tables
   - Drop unique constraints before tables
   - Drop check constraints before tables

2. Production rollbacks require human approval.

## Up Migration Rules

1. **No ALTER TABLE after initial CREATE:**
   - Tables are created complete with all columns
   - Later changes use new migrations
   - No `ALTER TABLE ADD COLUMN` in later migrations

2. **Constraint naming convention:**
   - Check constraints: `{table}_{column}_check` or `{table}_{description}_check`
   - Unique indexes: `{table}_{columns}_uq`
   - Foreign keys: `{table}_{column}_fk`

3. **Index naming convention:**
   - B-tree indexes: `{table}_{columns}_idx`
   - Unique indexes: `{table}_{columns}_uq`
   - Partial indexes: `{table}_{columns}_idx` with WHERE clause

4. **Use `--> statement-breakpoint` for multi-statement files:**
   - DrizzleKit recognizes this as a statement separator
   - Each segment runs as a separate statement

## Migration Application

```bash
# Apply all pending migrations
pnpm db:migrate

# Check migration status
pnpm run check:migrations

# Generate a new migration (after schema changes)
pnpm db:generate
```

## Phase 84-87 Migration Summary

| Migration | Phase | Tables Created | Rollback SQL |
|-----------|-------|----------------|--------------|
| `0084_rt2_v33_execution_attempts` | 84 | `rt2_v33_execution_attempts` | Manual — see below |
| `0085_rt2_v33_domain_events` | 84 | `rt2_v33_domain_events`, `rt2_v33_projector_state`, `rt2_v33_projector_events` | Manual — see below |
| `0113_rt2_v33_work_entities` | 86 | `rt2_v33_work_entities`, `rt2_v33_work_entities_archive`, `rt2_v33_work_projector_state` | Manual — see below |
| `0114_rt2_schema_validation` | 87 | None (documentation and tests) | N/A |

**Note:** Migrations 0084 and 0085 were created before this policy was established. New migrations (0113+) follow this policy.

## What Requires a Migration

| Change | Migration Required? |
|--------|-------------------|
| New table | ✅ Yes |
| New column (add to new table) | ✅ Yes |
| New index | ✅ Yes |
| New constraint (check, FK, unique) | ✅ Yes |
| TypeScript type changes only | ❌ No |
| Documentation changes | ❌ No |
| Test file changes | ❌ No |

## Breaking Changes

Breaking changes (dropping columns, changing types, etc.) require:
1. A new migration that makes the change
2. A deprecation notice in the commit message
3. Update to CHANGELOG.md

**Rule:** Never drop a column in the same migration that deprecates it. Use two-phase: first mark deprecated, then drop in a later migration.

---

## Rollback Reference

### 0113_rt2_v33_work_entities

**Rollback SQL:**

```sql
DROP TABLE IF EXISTS "rt2_v33_work_projector_state";
DROP TABLE IF EXISTS "rt2_v33_work_entities_archive";
DROP TABLE IF EXISTS "rt2_v33_work_entities";
```

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-05-04 | GSD Agent | Initial policy — Phase 87 schema validation |
