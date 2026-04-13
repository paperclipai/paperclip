---
name: acceptance-migrations
description: Use when authoring acceptance specs for SQL migration deliverables. One JSON spec per issue at tests/<DLD-XXXX>.migration.spec.json, consumed by the verification worker's migration-runner. Backend QA Agent owns this skill for every migration deliverable_type issue.
---

# Migration Acceptance Specs

## When to use

You're the Backend QA Agent assigned an issue whose `deliverable_type` is `migration`. Your job is to write a JSON spec at `skills/acceptance-migrations/tests/<DLD-XXXX>.migration.spec.json` **before the engineer starts**. The verification worker applies the migration to a throwaway Postgres schema, asserts the post-conditions, and optionally verifies rollback reverses everything cleanly.

## How it works

The runner:

1. Creates a new throwaway schema on the production Postgres instance (name `verif_<issue-id-fragment>_<timestamp>`)
2. Substitutes the literal token `SCHEMA` in your `migrationSql` with the throwaway schema name
3. Runs the expanded SQL
4. Checks each declared `expectSchema` post-condition
5. If `rollbackSql` is provided, runs it and re-checks post-conditions are gone
6. Drops the throwaway schema
7. Returns passed / failed / unavailable

Because the runner uses a throwaway schema (not the real one), this catches:

- Syntax errors
- Reference errors (missing FK targets, missing tables)
- Post-condition failures (the column didn't actually get added, the index name differs)
- Incomplete rollback (the DROP didn't remove everything)

It does NOT catch:

- Migrations that depend on production data (e.g. "backfill column X from column Y") — the throwaway schema is empty
- Migrations that depend on the real schema shape (e.g. "add FK to existing `public.users`") — you must either inline the dependency into your `migrationSql` or declare the dependency in a follow-up spec type (not yet supported — open a board issue if blocked)

## Spec format

```json
{
  "migrationSql": "CREATE TABLE SCHEMA.example_table (id uuid PRIMARY KEY, name text NOT NULL); CREATE INDEX example_table_name_idx ON SCHEMA.example_table(name);",
  "rollbackSql": "DROP INDEX IF EXISTS SCHEMA.example_table_name_idx; DROP TABLE IF EXISTS SCHEMA.example_table;",
  "expectSchema": [
    { "type": "table_exists", "table": "example_table" },
    { "type": "column_exists", "table": "example_table", "column": "id" },
    { "type": "column_exists", "table": "example_table", "column": "name" },
    { "type": "index_exists", "name": "example_table_name_idx" }
  ]
}
```

### Fields

| Field | Type | Required? | Purpose |
|---|---|---|---|
| `migrationSql` | string | yes | The migration SQL. MUST reference table/index identifiers with the `SCHEMA.` prefix literal — the runner substitutes this with the throwaway schema name. |
| `rollbackSql` | string | no (but recommended) | SQL that reverses the migration. If provided, the runner runs it after post-conditions pass and re-checks that the conditions are gone. |
| `expectSchema` | array | yes, ≥1 | Post-conditions to assert after `migrationSql` runs. Supported types: `table_exists`, `column_exists`, `index_exists`. |

## Quality rules

1. **At least 3 expectations.** One table check, one column check, one index check is a reasonable minimum. One-assertion specs get rejected in cross-review.
2. **Every `migrationSql` must reference `SCHEMA`.** Otherwise the runner refuses to run it (defense against specs that would touch the real schema).
3. **If the migration creates anything, `rollbackSql` is REQUIRED.** Forward-only migrations are fine, but they need an explicit `rollbackSql: null` override marker (not yet implemented — for now, always provide one).
4. **No DROP SCHEMA, DROP DATABASE, unqualified TRUNCATE, or unqualified DELETE.** The runner denylists these patterns.

## What to watch for in cross-review

When Frontend QA (cross-reviewer) reviews a migration spec, they should ask:

- Does the post-condition set actually cover the intent? If the issue says "add column X with a NOT NULL constraint", does the spec check that the column exists AND that the constraint is there? (Today the runner only checks `column_exists` — constraint checks are on the Phase 3 roadmap. Flag it in the comment.)
- Is the rollback complete? If the migration adds a column AND an index, the rollback must drop both.
- Is the schema prefix used consistently? A spec that references SCHEMA in some places and a hardcoded schema name in others will fail in surprising ways.
- Could this migration succeed on the throwaway schema but fail on production (where real data exists)? If yes, the spec doesn't adequately verify the deliverable — escalate.

## Reference example (Phase 1 migration 0054)

This is what the phase-1 verification_runs table migration would look like as a spec:

```json
{
  "migrationSql": "CREATE TABLE SCHEMA.verification_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), issue_id uuid NOT NULL, spec_path text NOT NULL, status text NOT NULL); CREATE INDEX verification_runs_issue_idx ON SCHEMA.verification_runs(issue_id);",
  "rollbackSql": "DROP INDEX IF EXISTS SCHEMA.verification_runs_issue_idx; DROP TABLE IF EXISTS SCHEMA.verification_runs;",
  "expectSchema": [
    { "type": "table_exists", "table": "verification_runs" },
    { "type": "column_exists", "table": "verification_runs", "column": "id" },
    { "type": "column_exists", "table": "verification_runs", "column": "status" },
    { "type": "index_exists", "name": "verification_runs_issue_idx" }
  ]
}
```

(Note: this is a simplified example for documentation — the real 0054 migration also adds issues columns which reference the `public` schema and can't be expressed in this spec format yet.)
