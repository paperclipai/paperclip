#!/usr/bin/env node
/**
 * check-pr-linked-issue.mjs
 * Checks that a PR body references a GitHub issue.
 * Export: checkLinkedIssue(prBody: string) → { passed: boolean, failures: string[] }
 */
import { fileURLToPath } from 'node:url';

const ISSUE_PATTERNS = [
  /(?:fixes|closes|resolves)\s+#\d+/i,
  /\bhttps:\/\/github\.com\/paperclipai\/paperclip\/issues\/\d+/i,
  /(?<!\w)#\d+/,
];

export function checkLinkedIssue(body) {
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
  const result = checkLinkedIssue(body);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
