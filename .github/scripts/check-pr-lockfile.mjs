#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

// refresh-lockfile.yml opens its heal PR as the commitperclip app, because PRs
// created with GITHUB_TOKEN never trigger the checks the auto-merge waits on.
// github-actions[bot] stays accepted so the gate keeps working if that workflow
// ever falls back to github.token.
export const REFRESH_BOT_AUTHORS = ['github-actions[bot]', 'commitperclip[bot]'];
export const REFRESH_BOT_BRANCH = 'chore/refresh-lockfile';

export function checkLockfile(files, prAuthor, prBranch) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const isRefreshBot =
    REFRESH_BOT_AUTHORS.includes(prAuthor) && prBranch === REFRESH_BOT_BRANCH;

  return {
    passed: isRefreshBot,
    failures: isRefreshBot ? [] : [
      'You have changes to `pnpm-lock.yaml` — `pr.yml` will hard-fail this PR with a confusing message about lockfile edits. ' +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      'The lockfile is regenerated automatically by the refresh bot on a schedule.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
