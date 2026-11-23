#!/usr/bin/env node
// External/observed-routines PRs must not change the database schema: they
// write rows into existing tables only. Fail closed if a PR touches
// migrations or the drizzle schema sources.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARDED_DIRECTORIES = [
  'packages/db/src/migrations/',
  'packages/db/src/schema/',
];

function escapeWorkflowCommand(message) {
  return message
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

export function checkNoSchemaChanges(changedFiles) {
  const violations = changedFiles.filter((file) =>
    GUARDED_DIRECTORIES.some((directory) => file.startsWith(directory)),
  );

  if (violations.length === 0) {
    return { passed: true, message: 'No schema or migration changes in this PR.', violations: [] };
  }

  return {
    passed: false,
    message: [
      'This PR must not change the database schema (zero-migration constraint):',
      ...violations.map((file) => `- ${file}`),
      '',
      'Revert schema/migration edits and model new data through existing tables.',
    ].join('\n'),
    violations,
  };
}

function gitPaths(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function main() {
  const [baseSha, headSha] = process.argv.slice(2);
  const shaPattern = /^[0-9a-f]{40}$/i;
  if (!shaPattern.test(baseSha ?? '') || !shaPattern.test(headSha ?? '')) {
    console.error('Usage: check-pr-no-schema-changes.mjs <40-character base SHA> <40-character head SHA>');
    process.exit(2);
  }

  const changedFiles = gitPaths([
    'diff', '--name-only', '--diff-filter=ACMR', '-z', `${baseSha}...${headSha}`, '--',
    ...GUARDED_DIRECTORIES,
  ]);
  const result = checkNoSchemaChanges(changedFiles);

  if (result.passed) {
    console.log(result.message);
    return;
  }

  console.error(
    `::error title=Schema changes are not allowed in this PR::${escapeWorkflowCommand(result.message)}`,
  );
  console.error(result.message);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
