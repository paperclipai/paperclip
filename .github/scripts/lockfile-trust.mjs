#!/usr/bin/env node
/**
 * lockfile-trust.mjs
 *
 * Decides who may change the dependency lock. Only trusted environments write it:
 * - the lockfile refresh workflow (`chore/refresh-lockfile`, opened by github-actions[bot]),
 * - Dependabot, when the exact lockfile bytes come from a verified Dependabot commit.
 *
 * The reporting-lock proof (`tests/runner-e2e/report-lock.json` and `.patch`) can rewrite the
 * lock that paid evaluation jobs install, so it counts as lock content too. Only the refresh
 * workflow writes it. After a verified Dependabot lockfile merges, the refresh workflow renews
 * the proof for it.
 *
 * Keep this file free of imports outside node:*. The PR policy job runs the copy from the current
 * base-branch tip, so a pull request cannot rewrite the check that judges it.
 *
 * Usage:
 *   node .github/scripts/lockfile-trust.mjs pr      # PR policy job
 *   node .github/scripts/lockfile-trust.mjs merged  # refresh workflow on master
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCKFILE = 'pnpm-lock.yaml';
export const REPORT_LOCK_FILES = ['tests/runner-e2e/report-lock.json', 'tests/runner-e2e/report-lock.patch'];
export const DEPENDABOT_LOGIN = 'dependabot[bot]';
export const REFRESH_BRANCH = 'chore/refresh-lockfile';
export const REFRESH_PR_AUTHOR = 'github-actions[bot]';
// GitHub commits and signs Dependabot commits as web-flow. A verified signature proves only who
// committed, and anyone can set the author field, so require GitHub as the committer as well.
export const GITHUB_COMMITTER_LOGIN = 'web-flow';

const RECREATE_HINT = 'Comment `@dependabot recreate` so Dependabot rebuilds the lockfile, instead of merging or editing it by hand.';

/**
 * True for a commit that Dependabot authored and GitHub committed and signed.
 * @param {{ login: string | null, committer: string | null, verified: boolean }} commit
 */
export function isDependabotCommit(commit) {
  return commit.login === DEPENDABOT_LOGIN && commit.committer === GITHUB_COMMITTER_LOGIN && commit.verified === true;
}

/**
 * Find a Dependabot commit (see isDependabotCommit) in the pull request that holds exactly the
 * lockfile under review.
 * @param {{ lockBlob: string | null,
 *   commits: Array<{ sha: string, login: string | null, committer: string | null, verified: boolean }>,
 *   lockBlobAt: (sha: string) => string | null }} input
 */
export function findDependabotLockCommit({ lockBlob, commits, lockBlobAt }) {
  if (!lockBlob) return null;
  for (const commit of [...commits].reverse()) {
    if (!isDependabotCommit(commit)) continue;
    if (lockBlobAt(commit.sha) === lockBlob) return commit.sha;
  }
  return null;
}

/**
 * Classify the lock-content change in a pull request.
 * @returns {{ allowed: boolean, writer: 'none' | 'dependabot' | 'refresh-bot', reason: string }}
 */
export function classifyPullRequest({ changedPaths, author, headRepo, baseRepo, headRef, dependabotLockCommit }) {
  const lockfileChanged = changedPaths.includes(LOCKFILE);
  const proofChanged = changedPaths.some((file) => REPORT_LOCK_FILES.includes(file));
  if (!lockfileChanged && !proofChanged) {
    return { allowed: true, writer: 'none', reason: 'The pull request does not change lock content.' };
  }

  const sameRepo = Boolean(headRepo) && headRepo === baseRepo;
  if (sameRepo && author === REFRESH_PR_AUTHOR && headRef === REFRESH_BRANCH) {
    return { allowed: true, writer: 'refresh-bot', reason: 'The lockfile refresh workflow opened this pull request.' };
  }

  if (sameRepo && author === DEPENDABOT_LOGIN) {
    if (proofChanged) {
      return { allowed: false, writer: 'dependabot',
        reason: `Dependabot pull requests must not change ${REPORT_LOCK_FILES.join(' or ')}. The lockfile refresh renews the reporting-lock proof after merge.` };
    }
    if (!dependabotLockCommit) {
      return { allowed: false, writer: 'dependabot',
        reason: `${LOCKFILE} does not match any verified Dependabot commit in this pull request. ${RECREATE_HINT}` };
    }
    return { allowed: true, writer: 'dependabot', reason: `${LOCKFILE} matches verified Dependabot commit ${dependabotLockCommit}.` };
  }

  const files = [lockfileChanged && LOCKFILE, ...REPORT_LOCK_FILES.filter((file) => changedPaths.includes(file))].filter(Boolean);
  return { allowed: false, writer: 'none',
    reason: `Do not commit ${files.join(', ')} in pull requests. CI owns lockfile updates.` };
}

/**
 * True when GitHub created and signed the commit, as it does when it merges a pull request.
 * @param {any} commit Response of GET /repos/{repo}/commits/{sha}.
 */
export function isGitHubSignedCommit(commit) {
  return commit?.committer?.login === GITHUB_COMMITTER_LOGIN && commit?.commit?.verification?.verified === true;
}

/**
 * Pick the merged Dependabot pull request whose squash or merge commit is `commitSha`.
 * @param {Array<any>} pulls Response of GET /repos/{repo}/commits/{sha}/pulls.
 */
export function findMergedDependabotPull(pulls, commitSha, defaultBranch) {
  return pulls.find((pull) => pull?.user?.login === DEPENDABOT_LOGIN && Boolean(pull.merged_at) &&
    pull.merge_commit_sha === commitSha && pull?.base?.ref === defaultBranch) ?? null;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function tryRun(command, args) {
  try { return run(command, args); } catch { return null; }
}

function ghJsonLines(endpoint, jq) {
  const output = run('gh', ['api', '--paginate', endpoint, '--jq', jq]);
  return output ? output.split('\n').map((line) => JSON.parse(line)) : [];
}

function pullCommits(repository, number) {
  return ghJsonLines(`repos/${repository}/pulls/${number}/commits?per_page=100`,
    '.[] | {sha, login: .author.login, committer: .committer.login, verified: .commit.verification.verified}');
}

function writeOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function checkPullRequest() {
  const repository = required('GITHUB_REPOSITORY');
  const baseSha = required('BASE_SHA');
  const headSha = required('HEAD_SHA');
  const author = required('PR_AUTHOR');
  // Diff against the merge base so recent base-branch commits are not counted as PR changes.
  const changedPaths = run('git', ['diff', '--name-only', `${baseSha}...${headSha}`]).split('\n').filter(Boolean);

  let dependabotLockCommit = null;
  if (author === DEPENDABOT_LOGIN && changedPaths.includes(LOCKFILE)) {
    dependabotLockCommit = findDependabotLockCommit({
      lockBlob: tryRun('git', ['rev-parse', `${headSha}:${LOCKFILE}`]),
      commits: pullCommits(repository, required('PR_NUMBER')),
      lockBlobAt: (sha) => tryRun('git', ['rev-parse', `${sha}:${LOCKFILE}`]),
    });
  }

  const result = classifyPullRequest({
    changedPaths, author, headRepo: process.env.HEAD_REPO ?? '', baseRepo: repository,
    headRef: process.env.HEAD_REF ?? '', dependabotLockCommit,
  });
  console.log(result.reason);
  writeOutputs({ writer: result.writer });
  if (!result.allowed) {
    console.log(`::error title=Untrusted lockfile change::${result.reason}`);
    process.exitCode = 1;
  }
}

/**
 * On master: report the committed lockfile's SHA-256 when its last change is a GitHub-signed merge
 * of a Dependabot pull request whose head lockfile bytes come from a verified Dependabot commit.
 * When master's lockfile moved after Dependabot's commit, GitHub's merge combines the two trusted
 * lockfiles, so the merged bytes can differ from Dependabot's. The refresh then records the
 * resolution of that merged lock as the reviewed correction. Otherwise report nothing.
 */
function checkMerged() {
  const repository = required('GITHUB_REPOSITORY');
  const head = required('GITHUB_SHA');
  const defaultBranch = process.env.DEFAULT_BRANCH || 'master';
  const lockCommit = run('gh', ['api', `repos/${repository}/commits?sha=${head}&path=${LOCKFILE}&per_page=1`, '--jq', '.[0].sha // empty']);
  const pull = lockCommit
    ? findMergedDependabotPull(JSON.parse(run('gh', ['api', `repos/${repository}/commits/${lockCommit}/pulls`])), lockCommit, defaultBranch)
    : null;
  if (pull && !isGitHubSignedCommit(JSON.parse(run('gh', ['api', `repos/${repository}/commits/${lockCommit}`])))) {
    console.log(`::warning title=Unverified Dependabot merge::${lockCommit} is not a GitHub-signed merge of #${pull.number}. The reporting-lock proof is not renewed.`);
    writeOutputs({ trusted_lock_sha256: '', dependabot_pr: String(pull.number) });
    return;
  }
  if (!pull) {
    console.log(`The last ${LOCKFILE} change on ${defaultBranch} is not a merged Dependabot pull request.`);
    writeOutputs({ trusted_lock_sha256: '', dependabot_pr: '' });
    return;
  }

  // The checkout is shallow, so read each candidate's lockfile blob hash from the API.
  const lockBlobAt = (sha) => tryRun('gh', ['api', `repos/${repository}/git/trees/${sha}`,
    '--jq', `.tree[] | select(.path == "${LOCKFILE}") | .sha`]) || null;
  const verified = findDependabotLockCommit({
    lockBlob: lockBlobAt(pull.head.sha),
    commits: pullCommits(repository, pull.number),
    lockBlobAt,
  });
  if (!verified) {
    console.log(`::warning title=Unverified Dependabot lockfile::The ${LOCKFILE} at the head of #${pull.number} matches no verified Dependabot commit. The reporting-lock proof is not renewed.`);
    writeOutputs({ trusted_lock_sha256: '', dependabot_pr: String(pull.number) });
    return;
  }
  const lockSha256 = createHash('sha256').update(execFileSync('git', ['show', `HEAD:${LOCKFILE}`])).digest('hex');
  console.log(`${LOCKFILE} on ${defaultBranch} is GitHub's merge of verified Dependabot commit ${verified} from #${pull.number}.`);
  writeOutputs({ trusted_lock_sha256: lockSha256, dependabot_pr: String(pull.number) });
}

// Compare real paths: the runner's temporary directory can sit behind a symlink.
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const mode = process.argv[2];
  if (mode === 'pr') checkPullRequest();
  else if (mode === 'merged') checkMerged();
  else throw new Error('Usage: lockfile-trust.mjs pr|merged');
}
