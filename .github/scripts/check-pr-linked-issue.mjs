#!/usr/bin/env node
/**
 * check-pr-linked-issue.mjs
 * Checks that a PR body references a GitHub issue. Respects conventional commit
 * prefixes — skips check for docs/chore/build/ci/style/test prefixed PRs.
 * Export: checkLinkedIssue(prBody: string, prTitle: string) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

const ISSUE_PATTERNS = [
  /(?:fixes|closes|resolves)\s+#\d+/i,
  /(?:^|[\s(])https:\/\/github\.com\/paperclipai\/paperclip\/issues\/\d+(?=$|[\s),:;!?]|[.](?![\w-]))/i,
  /(?<!\w)#\d+/,
];

// Prefixes where a linked issue is NOT required
const SKIP_ISSUE_PREFIXES = ['docs', 'chore', 'build', 'ci', 'style', 'test', 'revert'];

function parsePrefix(title) {
  if (!title) return null;
  const match = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  return match ? match[1].toLowerCase() : null;
}

export function checkLinkedIssue(body, prTitle = '') {
  const prefix = parsePrefix(prTitle);

  if (prefix && SKIP_ISSUE_PREFIXES.includes(prefix)) {
    return { passed: true, failures: [] };
  }

  if (!body || !body.trim()) {
    return { passed: false, failures: ['PR body is empty — please fill out the PR template'] };
  }

  const found = ISSUE_PATTERNS.some(p => p.test(body));
  return {
    passed: found,
    failures: found ? [] : [
      'No linked issue found — please add `Fixes #NNN` to your PR description. ' +
      'If no issue exists yet, please file one first: ' +
      'https://github.com/paperclipai/paperclip/issues/new',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = process.env.PR_BODY ?? '';
  const title = process.env.PR_TITLE ?? '';
  const result = checkLinkedIssue(body, title);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
