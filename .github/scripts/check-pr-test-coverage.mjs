#!/usr/bin/env node
/**
 * check-pr-test-coverage.mjs
 * Checks that a PR diff includes at least one test file. Respects conventional
 * commit prefixes — skips check for docs/chore/build/ci/style/refactor PRs.
 * Also detects mismatch: docs/chore PRs that contain real source code changes.
 * Export: checkTestCoverage(files, prTitle) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

const TEST_PATTERNS = [
  /\.test\.(ts|js|tsx|jsx|mjs)$/,
  /\.spec\.(ts|js|tsx|jsx|mjs)$/,
  /(?:^|\/)tests?\//,
  /\/__tests__\//,
];

const SOURCE_CODE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Prefixes where test coverage is NOT required
const SKIP_TEST_PREFIXES = ['docs', 'chore', 'build', 'ci', 'style', 'refactor', 'revert'];

// Prefixes where source code changes are NOT expected (mismatch detection)
// Note: 'style' is excluded — formatting PRs legitimately touch source files
const NO_SOURCE_CODE_PREFIXES = ['docs', 'chore', 'build', 'ci'];

function parsePrefix(title) {
  if (!title) return null;
  const match = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  return match ? match[1].toLowerCase() : null;
}

function isSourceFile(filename) {
  if (!SOURCE_CODE_PATTERN.test(filename)) return false;
  if (TEST_PATTERNS.some(p => p.test(filename))) return false;
  return true;
}

export function checkTestCoverage(files, prTitle = '') {
  const prefix = parsePrefix(prTitle);

  // Mismatch detection: docs/chore/etc PR with real source code changes
  if (prefix && NO_SOURCE_CODE_PREFIXES.includes(prefix)) {
    const sourceChanges = files.filter(f => f.status !== 'removed' && isSourceFile(f.filename));
    if (sourceChanges.length > 0) {
      return {
        passed: false,
        failures: [
          `PR is titled \`${prefix}:\` but includes source code changes ` +
          `(${sourceChanges.slice(0, 3).map(f => f.filename).join(', ')}` +
          `${sourceChanges.length > 3 ? ', ...' : ''}). ` +
          `Please retitle as \`fix:\`, \`feat:\`, or \`refactor:\` so the right gates run, ` +
          `or remove the source code changes if this is genuinely a \`${prefix}:\` PR.`,
        ],
      };
    }
  }

  // Skip test requirement for prefixes that don't change behavior
  if (prefix && SKIP_TEST_PREFIXES.includes(prefix)) {
    return { passed: true, failures: [] };
  }

  const hasTests = files.some(
    f => f.status !== 'removed' && TEST_PATTERNS.some(p => p.test(f.filename))
  );

  return {
    passed: hasTests,
    failures: hasTests ? [] : [
      'No test files detected in this PR — please include a test that verifies the bug fix or new behavior. ' +
      'If this PR genuinely doesn\'t need a test (e.g. a refactor), please retitle with `refactor:` prefix.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const title = process.env.PR_TITLE ?? '';
  const result = checkTestCoverage(files, title);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
