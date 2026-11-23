import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNoSchemaChanges } from '../check-pr-no-schema-changes.mjs';

test('passes when a PR touches no guarded paths', () => {
  const result = checkNoSchemaChanges([
    'server/src/services/routines.ts',
    'ui/src/components/RoutineList.tsx',
  ]);

  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
});

test('passes with an empty diff', () => {
  const result = checkNoSchemaChanges([]);

  assert.equal(result.passed, true);
});

test('fails when a PR adds a migration', () => {
  const result = checkNoSchemaChanges([
    'server/src/routes/routines.ts',
    'packages/db/src/migrations/0451_external_routines.sql',
  ]);

  assert.equal(result.passed, false);
  assert.match(result.message, /must not change the database schema/);
  assert.deepEqual(result.violations, ['packages/db/src/migrations/0451_external_routines.sql']);
});

test('fails when a PR edits the drizzle schema', () => {
  const result = checkNoSchemaChanges([
    'packages/db/src/schema/routines.ts',
  ]);

  assert.equal(result.passed, false);
  assert.deepEqual(result.violations, ['packages/db/src/schema/routines.ts']);
});

test('fails for both guarded directories at once', () => {
  const result = checkNoSchemaChanges([
    'packages/db/src/migrations/0451_external_routines.sql',
    'packages/db/src/schema/routines.ts',
  ]);

  assert.equal(result.passed, false);
  assert.equal(result.violations.length, 2);
});
