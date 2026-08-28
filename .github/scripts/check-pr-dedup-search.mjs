#!/usr/bin/env node
/**
 * check-pr-dedup-search.mjs
 * Checks that the PR body affirms the author searched for similar PRs before
 * opening this one. Looks for a checked checklist line matching the dedup
 * affirmation in the PR template. Respects the same skip prefixes as the
 * linked-issue gate.
 *
 * Export: checkDedupSearch(prBody, prTitle) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

const SKIP_PREFIXES = ['docs', 'chore', 'build', 'ci', 'style', 'test', 'revert'];

// Match a markdown checkbox line whose label mentions searching for similar
// PRs. Examples that should match (checked):
//   - [x] I searched for similar open/closed PRs and confirmed this is not a duplicate
//   - [X] I searched the GitHub PR list (open + recently closed) for similar PRs ...
//   * [x] Searched for similar PRs — not a duplicate
const DEDUP_CHECKBOX_RE =
  /^\s*[-*]\s*\[\s*([ xX])\s*\][^\n]*search(?:ed)?[^\n]*(?:similar|duplicate|prior)[^\n]*\bprs?\b/im;

function parsePrefix(title) {
  if (!title) return null;
  const match = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  return match ? match[1].toLowerCase() : null;
}

export function checkDedupSearch(body, prTitle = '') {
  const prefix = parsePrefix(prTitle);
  if (prefix && SKIP_PREFIXES.includes(prefix)) {
    return { passed: true, failures: [] };
  }

  if (!body || !body.trim()) {
    return {
      passed: false,
      failures: ['PR body is empty — please fill out the PR template'],
    };
  }

  const match = body.match(DEDUP_CHECKBOX_RE);
  if (!match) {
    return {
      passed: false,
      failures: [
        'Add the dedup-search checkbox to your PR description and check it once ' +
        'you have searched the GitHub PR list for similar PRs. See the PR template ' +
        'at .github/PULL_REQUEST_TEMPLATE.md and CONTRIBUTING.md → "Before You Start: Search First".',
      ],
    };
  }

  const checked = match[1] === 'x' || match[1] === 'X';
  return {
    passed: checked,
    failures: checked ? [] : [
      'Please confirm you searched the GitHub PR list for similar PRs by ' +
      'checking the dedup-search checkbox in your PR description ' +
      '(`- [x] I searched ...`). See CONTRIBUTING.md → "Before You Start: Search First".',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = process.env.PR_BODY ?? '';
  const title = process.env.PR_TITLE ?? '';
  const result = checkDedupSearch(body, title);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
