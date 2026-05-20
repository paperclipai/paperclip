#!/usr/bin/env node
/**
 * check-pr-test-coverage.mjs
 * Checks that a PR diff includes at least one test file change.
 * Export: checkTestCoverage(files: Array<{filename, status}>) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

const TEST_PATTERNS = [
  /\.test\.(ts|js|tsx|jsx)$/,
  /\.spec\.(ts|js|tsx|jsx)$/,
  /(?:^|\/)tests?\//,
  /\/__tests__\//,
];

export function checkTestCoverage(files) {
  const hasTests = files.some(
    f => f.status !== 'removed' && TEST_PATTERNS.some(p => p.test(f.filename))
  );

  return {
    passed: hasTests,
    failures: hasTests ? [] : [
      'No test files detected in this PR — please include a test that verifies the bug fix. ' +
      'The PR template checklist requires tests added/updated.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkTestCoverage(files);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
