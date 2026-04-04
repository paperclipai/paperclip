---
trigger: model_decision
description: Whenever database schemas are being modified
---

# Rule: Database Change Workflow

Changes to the Paperclip data model must follow a standardized workflow to ensure consistency across the database, application code, and migrations.

- **Activation**: `Model Decision` (whenever database schemas are being modified)

## Workflow

1.  **Edit Schema**: Modify the source files in `packages/db/src/schema/*.ts`.
2.  **Export Schema**: Ensure any new tables or entities are properly exported from `packages/db/src/schema/index.ts`.
3.  **Generate Migration**: Run the migration tool to generate the necessary SQL changes:
    ```sh
    pnpm db:generate
    ```
4.  **Validate**: Run a typecheck across all workspace packages to ensure no breaking changes were introduced in consumers:
    ```sh
    pnpm -r typecheck
    ```
5.  **Clean State (Optional)**: If local data needs to be reset for testing, ensure the local PGlite instance is properly cleaned:
    ```sh
    rm -rf data/pglite && pnpm dev
    ```
