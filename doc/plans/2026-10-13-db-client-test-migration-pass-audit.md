# DB client test migration-pass audit

This test-only change removes 15 redundant initial `applyPendingMigrations(connectionString)` calls from `packages/db/src/client.test.ts`. Every test declaration and assertion stays unchanged. No production code, migration, import, or fixture helper changes.

## Why the calls are redundant

`createTempDatabase()` awaits `startEmbeddedPostgresTestDatabase()` before returning its connection string. The shared fixture awaits `ensurePostgresDatabase()` and `applyPendingMigrations()` before returning on both the fresh and template paths. Each removed call immediately followed `await createTempDatabase()`, with no intervening schema, migration-journal, or fixture-data mutation. It therefore inspected the same fully migrated database again.

For this fixture's hash-based migration journal, the repeated pass enters `inspectMigrations()`, opens a one-connection DB utility pool, and loads the applied hashes. `mapHashesToMigrationFiles()` reads and SHA-256 hashes every migration SQL file. The directory contains 334 SQL files at this revision. Removing 15 such passes avoids 15 × 334 = **5,010 migration SQL file reads and hashes**, plus **15 DB utility pool passes**. These are operation counts derived from the source and migration directory, not measured seconds or a CI speedup estimate. The fixture's required migration pass remains.

## Exact removal boundary

The removed calls were at original lines 204, 274, 327, 371, 401, 473, 567, 633, 699, 773, 877, 1010, 1406, 1983, and 2011. The import stays used by the replay tests.

All migration calls after journal or schema mutation remain, including the original calls at lines 191, 226, 295, 358, 433, 527, 598, 664, 735, 811, 971, 1045, 1297, 1384, 1510, 1604, 1930, 1998, and 2065. These preserve older-clone upgrades; renumbered recovery replay; inserted earlier migrations; 0044, 0046, 0047, 0048, 0050, and 0059 replay; built-in managed-resource history; 0134 inbox archives; all three 0135 repair/no-op passes; run-responsible-user repair; native persistence/status-versioning replay; provider-trace idempotence; and retired-model-profile cleanup. No replay call is removed from the board-key uniqueness test, which has no later mutation requiring migration.

The fixture-helper tests remain unchanged, including `publishes a complete template and starts suites from a copy of it` and `runs the fresh initdb path when PAPERCLIP_TEST_POSTGRES_TEMPLATE=0`. Both assert that the returned database reports `upToDate`.

## Verification

```sh
node_modules/.bin/vitest run --project @paperclipai/db packages/db/src/client.test.ts packages/db/src/test-embedded-postgres.test.ts
```

Complete owner replay: **2 files passed, 35 tests passed, 0 failed, 0 skipped; 26.77 seconds**. Real embedded PostgreSQL executed, including the fresh and template fixture-owner tests. The first sandboxed invocation encountered `listen EPERM` on localhost and was interrupted; the successful identical command ran with local socket access. No baseline timing comparison was run.

`git diff --check` passes. A byte-level reconstruction against HEAD confirms that the client test file retains every original line except the 15 specified call lines. It retains 19 `applyPendingMigrations(connectionString)` references and the corresponding import.

Risk: these tests now rely directly on the fixture's existing fully-migrated return contract. The fresh/template owner tests cover that contract. Mutation and idempotence coverage remains in the same client suite.
