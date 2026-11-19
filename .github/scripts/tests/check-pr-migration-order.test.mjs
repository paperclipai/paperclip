import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMigrationCompatibility, checkMigrationOrder } from '../check-pr-migration-order.mjs';

const migration = (name) => `packages/db/src/migrations/${name}.sql`;

test('passes when a PR has no new migrations', () => {
  const result = checkMigrationOrder([migration('0230_on_master')], []);

  assert.equal(result.passed, true);
});

test('passes when every PR migration follows the target branch', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0231_first_in_pr'), migration('0232_second_in_pr')],
  );

  assert.equal(result.passed, true);
});

test('fails with renumbering guidance when a PR reuses the target branch number', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0230_from_stale_branch')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /already contains migrations through .*0230_on_master\.sql/);
  assert.match(result.message, /renumber this PR's migrations starting at 0231/);
  assert.match(result.message, /meta\/_journal\.json/);
});

test('fails when a PR inserts a migration before the target branch tip', () => {
  const result = checkMigrationOrder(
    [migration('0230_on_master')],
    [migration('0229_from_stale_branch'), migration('0231_valid_but_after_stale')],
  );

  assert.equal(result.passed, false);
  assert.match(result.message, /0229_from_stale_branch\.sql/);
  assert.doesNotMatch(result.message, /- packages\/db\/src\/migrations\/0231_valid_but_after_stale\.sql/);
});

test('fails a new migration the classifier cannot prove safe under the running release', async () => {
  const result = await checkMigrationCompatibility([
    { fileName: migration('0231_additive'), sql: 'ALTER TABLE "issues" ADD COLUMN "note" text;' },
    { fileName: migration('0232_plain_index'), sql: 'CREATE INDEX "issues_note_idx" ON "issues" ("note");' },
  ]);

  assert.equal(result.passed, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /0232_plain_index\.sql/);
  assert.match(result.errors[0], /lock_hazard_create_index/);
  assert.match(result.errors[0], /-- paperclip:migration-compat online_compatible: </);
  assert.match(result.errors[0], /expand migration now and a contract migration in a later release/);
});

test('passes an unknown migration with a justified in-file override', async () => {
  const result = await checkMigrationCompatibility([{
    fileName: migration('0232_plain_index'),
    sql: '-- paperclip:migration-compat online_compatible: issues stays under 10k rows on every stack\nCREATE INDEX "issues_note_idx" ON "issues" ("note");',
  }]);

  assert.equal(result.passed, true);
  assert.match(result.notices[0], /online_compatible by override/);
});

test('fails an override that has no justification', async () => {
  const result = await checkMigrationCompatibility([{
    fileName: migration('0232_plain_index'),
    sql: '-- paperclip:migration-compat online_compatible:\nCREATE INDEX "issues_note_idx" ON "issues" ("note");',
  }]);

  assert.equal(result.passed, false);
  assert.match(result.errors[0], /needs a justification/);
});

test('reports requires_staging as a notice without failing', async () => {
  const result = await checkMigrationCompatibility([
    { fileName: migration('0233_drop'), sql: 'ALTER TABLE "issues" DROP COLUMN "note";' },
  ]);

  assert.equal(result.passed, true);
  assert.deepEqual(result.errors, []);
  assert.match(result.notices[0], /0233_drop\.sql: requires_staging/);
});

test('passes when a PR adds no migrations', async () => {
  assert.deepEqual(await checkMigrationCompatibility([]), { passed: true, errors: [], notices: [] });
});

const executorSource = 'const MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS = new Set([\n  "0232_listed.sql",\n]);';
const concurrentIndex = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "issues_note_idx" ON "issues" ("note");';

test('fails a CONCURRENTLY migration that the migrator would run in a transaction', async () => {
  const result = await checkMigrationCompatibility(
    [{ fileName: migration('0232_unlisted'), sql: concurrentIndex }, { fileName: migration('0232_listed'), sql: concurrentIndex }],
    { executorSource },
  );

  assert.equal(result.passed, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /0232_unlisted\.sql: uses CONCURRENTLY/);
  assert.match(result.errors[0], /Add "0232_unlisted\.sql" to MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS in packages\/db\/src\/client\.ts/);
});

test('fails closed when the migrator source no longer names its non-transactional migrations', async () => {
  const result = await checkMigrationCompatibility([], { executorSource: 'export const nothing = 1;' });

  assert.equal(result.passed, false);
  assert.match(result.errors[0], /MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS was not found/);
});

test('treats CREATE TABLE IF NOT EXISTS as new only when the target branch never created the table', async () => {
  const sql = 'CREATE TABLE IF NOT EXISTS "widgets" ("id" uuid);\nALTER TABLE "widgets" DROP COLUMN "title";';
  const fresh = await checkMigrationCompatibility([{ fileName: migration('0231_widgets'), sql }], { priorMigrationSql: [] });
  const existing = await checkMigrationCompatibility([{ fileName: migration('0231_widgets'), sql }], {
    priorMigrationSql: ['CREATE TABLE "widgets" ("id" uuid, "title" text);'],
  });

  assert.deepEqual(fresh.notices, []);
  assert.match(existing.notices[0], /0231_widgets\.sql: requires_staging/);
});
