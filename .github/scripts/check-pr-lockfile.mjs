#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

export function checkLockfile(files, prAuthor, prBranch) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const isRefreshBot =
    prAuthor === 'github-actions[bot]' && prBranch === 'chore/refresh-lockfile';

  return {
    passed: isRefreshBot,
    failures: isRefreshBot ? [] : [
      'Please remove the `pnpm-lock.yaml` changes — this file is managed automatically. ' +
      'Run `pnpm install` locally and exclude the lockfile from your commit. ' +
      'The lockfile will be refreshed automatically by the refresh bot.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
