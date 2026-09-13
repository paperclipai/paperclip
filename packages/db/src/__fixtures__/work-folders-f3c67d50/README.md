# Published work-folder preview migration history

This fixture represents `@paperclipai/db@0.0.0-preview.gf3c67d50dad32563c7eb5cef1ebae8e83584d4cf`.
The package integrity and complete migration-manifest digest are recorded in
`history.json`. All 248 SQL files and original journal entries were verified
against the published package; its four removed preview SQL files are copied
verbatim here. The remaining 244 files are unchanged current migrations, reused
only after checking every historical SHA-256.

The regression creates a separate empty PostgreSQL database, applies this exact
historical journal through Drizzle, seeds old task/session/file state, and runs
the current application migration loader. It never constructs the old schema by
dropping columns from a current database. A separate freshly migrated database
provides the full six-table column/constraint/index comparison.
