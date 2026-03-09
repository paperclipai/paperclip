# @paperclipai/db

## Unreleased

### Minor Changes

- Added plugin system

## 0.2.9

### Patch Changes

- **Migration fix (0026_plugin_tables)**: Added the missing SQL migration file for all plugin tables. The schema files (`plugins.ts`, `plugin_config.ts`, `plugin_state.ts`, `plugin_entities.ts`, `plugin_jobs.ts`, `plugin_webhooks.ts`) were present but `drizzle-kit generate` had not been run, so the tables were never created in the database. The server would fail at startup with `relation "plugins" does not exist`. The migration creates all 7 plugin tables with correct foreign keys, indexes, and the `NULLS NOT DISTINCT` unique constraint on `plugin_state`. Updated `_journal.json` to include the new entry at index 26.

## 0.2.8

### Minor Changes

- **Plugin System Schema**: Added `plugin_entities`, `plugin_jobs`, `plugin_job_runs`, and `plugin_webhook_deliveries` tables to the Drizzle schema to support advanced plugin automation and entity mapping.

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.8

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.1
