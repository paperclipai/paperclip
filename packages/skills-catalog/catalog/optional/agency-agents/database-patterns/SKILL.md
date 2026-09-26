---
name: "database-patterns"
description: "Database design patterns including schema design, migrations, soft deletes, and Exposed ORM. Use when creating tables, writing migrations, or implementing repositories."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/database-patterns"
recommendedForRoles:
  - "engineer"
  - "designer"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "database"
  - "patterns"
defaultInstall: false
---
# Database Patterns — Quick Reference

## Hard Rules

| Rule | Do | Don't |
|------|------|-------|
| Data types | TEXT | VARCHAR |
| Primary keys | UUID | SERIAL, BIGINT |
| Soft delete | deleted_at TIMESTAMP | DELETE FROM |
| Foreign keys | App-level validation | REFERENCES, ON DELETE CASCADE |
| Standard columns | id, created_at, updated_at, deleted_at | Skip any of these |

## Migration Template

SQL migration with table, trigger, and partial indexes for soft delete.

> See code-templates.md for the complete SQL template.

## Exposed Table Object

Extend `UUIDTable`, use `text()` not `varchar()`, add standard timestamp columns.

> See code-templates.md for the complete template.

## Entity Data Class

Implement `Entity<Instant>`, include all business fields + `createdAt`, `updatedAt`, `deletedAt`.

> See code-templates.md for the complete template.

## Repository Pattern

Interface + `Default*` implementation. Reads on `db.replica`, writes on `db.primary`. Soft delete via `deletedAt` update. `convert()` method maps `ResultRow` to entity.

> See code-templates.md for the full interface + implementation code.

## When Creating a New Table

Full checklist:
1. SQL migration file (next number in sequence)
2. Table object in `module-repository/table/`
3. Entity data class in `module-repository/entity/`
4. Enum/constants in `module-repository/constant/` (if needed)
5. Repository interface + implementation
6. Factory bean for repository
7. Repository tests

## Flyway Rules

- NEVER add a migration that fills a gap in deployed sequence
- NEVER rename an already-deployed migration file
- Migration numbers must be sequential from the latest
- Keep migrations simple and focused (one table per migration)

## Gotchas

- **Only `id` uses `.value` -- everything else is direct.** `row[Table.id].value` gives UUID, but `row[Table.projectId]` already returns UUID. Adding `.value` to non-id columns causes compile errors.
- **`gen_random_uuid()` vs `uuid_generate_v4()` -- pick one per project.** Mixing them works but confuses code review. Check existing migrations for which one the project uses.
- **Don't re-declare `createdAt`, `updatedAt`, `deletedAt` if extending SoftDeleteTable.** They're inherited. Declaring them again causes duplicate column errors.
- **Forgetting `WHERE deleted_at IS NULL` on indexes wastes space.** Every index on a soft-delete table should be partial. Full indexes include dead records nobody queries.
- **Text columns that hold JSON should still use `text()` in Exposed.** JSONB in Postgres, `text()` in Kotlin, serialize/deserialize in the entity layer.
