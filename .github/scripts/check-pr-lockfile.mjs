#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Advisory check that lock content was not edited by hand. `pr-trusted.yml` enforces the
 * same rule with `lockfile-trust.mjs`, which also verifies Dependabot commit signatures.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';
import { DEPENDABOT_LOGIN, LOCKFILES, REFRESH_BRANCH, REFRESH_PR_AUTHOR, REPORT_LOCK_FILES } from './lockfile-trust.mjs';

export function checkLockfile(files, prAuthor, prBranch) {
  const changed = files.map(f => f.filename);
  const lockfilesChanged = changed.filter(f => LOCKFILES.includes(f));
  const proofChanged = changed.filter(f => REPORT_LOCK_FILES.includes(f));
  if (lockfilesChanged.length === 0 && proofChanged.length === 0) return { passed: true, failures: [] };

  if (prAuthor === REFRESH_PR_AUTHOR && prBranch === REFRESH_BRANCH) return { passed: true, failures: [] };
  if (prAuthor === DEPENDABOT_LOGIN && proofChanged.length === 0) return { passed: true, failures: [] };

  const edited = [...lockfilesChanged, ...proofChanged].map(f => `\`${f}\``).join(', ');
  return {
    passed: false,
    failures: [
      `You have changes to ${edited} — \`pr.yml\` will hard-fail this PR because only the lockfile refresh workflow and Dependabot may change lock content. ` +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      'The refresh bot regenerates every managed lockfile after your PR merges.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
