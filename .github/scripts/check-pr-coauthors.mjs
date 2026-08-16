#!/usr/bin/env node
/**
 * check-pr-coauthors.mjs
 * Surfaces the `Co-Authored-By` trailers a squash merge needs to keep
 * contributors credited.
 * Export: checkCoauthors(commits, prAuthor) → { passed, informational }
 *
 * This repository squash-merges, so every commit on a branch collapses into
 * one commit authored by whoever presses the button. When a branch carries
 * someone else's work — a rebase of a stale contributor PR, a port of an
 * abandoned branch, a pairing session — their name survives only if the squash
 * message carries a `Co-Authored-By` trailer for them. Nothing prompts for it,
 * and the PR page keeps showing the original author either way, so the loss is
 * invisible at exactly the moment it happens.
 *
 * Informational rather than a failure, on purpose. The squash message does not
 * exist while the PR is open, so this cannot be verified here and cannot be
 * fixed here either. Failing the PR would block work on something its author
 * has no way to satisfy. What this can do is notice that the situation applies
 * and hand over the exact lines to paste.
 */
import { fileURLToPath } from 'node:url';

/**
 * Fetches every commit on a PR across GitHub pagination.
 *
 * Capped at the API's own ceiling: `/pulls/{n}/commits` returns at most 250
 * commits and silently stops. A branch that large is not the case this gate is
 * about, and a partial list still surfaces the contributors it did see.
 */
export async function fetchAllPullRequestCommits(ghFetchFn, repo, prNumber, token) {
  const commits = [];

  for (let page = 1; page <= 3; page += 1) {
    const batch = await ghFetchFn(
      `/repos/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`,
      token
    );
    commits.push(...batch);

    if (batch.length < 100) break;
  }

  return commits;
}

/** GitHub's own no-reply address for a login, which is what trailers should use. */
function noReplyEmail(login) {
  return `${login}@users.noreply.github.com`;
}

export function checkCoauthors(commits, prAuthor) {
  const contributors = new Map();

  for (const entry of commits ?? []) {
    const login = entry?.author?.login ?? null;
    const gitName = entry?.commit?.author?.name ?? null;
    const gitEmail = entry?.commit?.author?.email ?? null;

    // The PR author's own commits need no trailer — the squash is already
    // theirs. Compared case-insensitively because GitHub logins are.
    if (login && prAuthor && login.toLowerCase() === prAuthor.toLowerCase()) continue;

    // Bots author plenty of commits and crediting them is noise.
    if (login && /\[bot\]$/.test(login)) continue;
    if (!login && !gitName) continue;

    // Prefer the GitHub identity, so the trailer links to a profile. Fall back
    // to the raw git author for a commit GitHub could not match to an account.
    const name = login ?? gitName;
    const email = login ? noReplyEmail(login) : gitEmail;
    if (!email) continue;

    const trailer = `Co-Authored-By: ${gitName && login ? gitName : name} <${email}>`;
    if (!contributors.has(trailer)) contributors.set(trailer, name);
  }

  if (contributors.size === 0) return { passed: true, informational: [] };

  const trailers = [...contributors.keys()].sort();
  const names = [...new Set(contributors.values())].sort();
  const who = names.length === 1 ? names[0] : `${names.length} other contributors`;

  return {
    passed: true,
    informational: [
      `This branch carries commits by ${who}. Squash-merging drops that authorship unless ` +
      'the squash message carries their trailers, and nothing else will notice if it does not. ' +
      'Add to the squash body when merging:\n\n' +
      trailers.map(line => `      ${line}`).join('\n'),
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commits = JSON.parse(process.env.PR_COMMITS ?? '[]');
  const result = checkCoauthors(commits, process.env.PR_AUTHOR ?? '');
  console.log(JSON.stringify(result));
  process.exit(0);
}
