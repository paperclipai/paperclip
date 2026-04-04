# Rule: Contract Sync

Maintain strict synchronization between the Database, Shared, Server, and UI layers. Any changes to one layer must be reflected across all related contracts.

- **Activation**: `Model Decision` (whenever contracts or schemas are modified)

## Guidelines

- **Type Integrity**: Run `pnpm -r typecheck` after any schema or contract change to identify broken dependencies across the workspace.
- **Validator Alignment**: Ensure that Zod validators in `packages/shared` match the Drizzle schema in `packages/db`.
- **API Consistency**: Keep `API_PATHS` in `packages/shared` and the server's Express routes in sync to avoid dead links or invalid routing.
- **UI Prop Safety**: When modifying domain types, immediately update the corresponding React props/components in the `ui` package to prevent runtime errors.
