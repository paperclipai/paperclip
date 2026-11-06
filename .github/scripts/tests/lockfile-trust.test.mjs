import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyPullRequest,
  findDependabotLockCommit,
  findMergedDependabotPull,
  isDependabotCommit,
  isGitHubSignedCommit,
} from '../lockfile-trust.mjs';

const repo = 'paperclipai/paperclip';
const base = { author: 'someuser', headRepo: repo, baseRepo: repo, headRef: 'fix/bug', dependabotLockCommit: null };

test('allows a pull request that does not change lock content', () => {
  assert.deepEqual(
    { ...classifyPullRequest({ ...base, changedPaths: ['server/src/index.ts'] }), reason: undefined },
    { allowed: true, writer: 'none', reason: undefined },
  );
});

test('blocks a contributor lockfile change', () => {
  const result = classifyPullRequest({ ...base, changedPaths: ['pnpm-lock.yaml'] });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /pnpm-lock\.yaml/);
});

test('blocks a contributor change to the reporting-lock proof', () => {
  const result = classifyPullRequest({ ...base, changedPaths: ['tests/runner-e2e/report-lock.patch'] });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /report-lock\.patch/);
});

test('blocks a contributor branch named like the refresh branch', () => {
  for (const headRepo of [repo, 'someone/paperclip']) {
    const result = classifyPullRequest({ ...base, headRepo, headRef: 'chore/refresh-lockfile', changedPaths: ['pnpm-lock.yaml'] });
    assert.equal(result.allowed, false, headRepo);
  }
});

test('blocks the refresh author and branch from a fork', () => {
  const result = classifyPullRequest({ ...base, author: 'github-actions[bot]', headRepo: 'someone/paperclip',
    headRef: 'chore/refresh-lockfile', changedPaths: ['pnpm-lock.yaml'] });
  assert.equal(result.allowed, false);
});

test('allows the refresh workflow to change the lockfile and its proof', () => {
  const result = classifyPullRequest({ ...base, author: 'github-actions[bot]', headRef: 'chore/refresh-lockfile',
    changedPaths: ['pnpm-lock.yaml', 'tests/runner-e2e/report-lock.json', 'tests/runner-e2e/report-lock.patch'] });
  assert.equal(result.allowed, true);
  assert.equal(result.writer, 'refresh-bot');
});

test('allows a Dependabot lockfile that matches a verified Dependabot commit', () => {
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]', headRef: 'dependabot/npm_and_yarn/zod-4.6.6',
    changedPaths: ['package.json', 'pnpm-lock.yaml'], dependabotLockCommit: 'abc123' });
  assert.equal(result.allowed, true);
  assert.equal(result.writer, 'dependabot');
});

test('blocks a Dependabot lockfile that no verified Dependabot commit produced', () => {
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]', changedPaths: ['pnpm-lock.yaml'] });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /@dependabot recreate/);
});

test('blocks a Dependabot pull request that changes the reporting-lock proof', () => {
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]', dependabotLockCommit: 'abc123',
    changedPaths: ['pnpm-lock.yaml', 'tests/runner-e2e/report-lock.json'] });
  assert.equal(result.allowed, false);
});

test('blocks a Dependabot author from a fork', () => {
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]', headRepo: 'someone/paperclip',
    dependabotLockCommit: 'abc123', changedPaths: ['pnpm-lock.yaml'] });
  assert.equal(result.allowed, false);
});

test('finds only verified Dependabot commits that hold the exact lockfile', () => {
  const blobs = { a: 'lock-1', b: 'lock-2', c: 'lock-2', d: 'lock-2' };
  const lockBlobAt = (sha) => blobs[sha] ?? null;
  const commits = [
    { sha: 'a', login: 'dependabot[bot]', committer: 'web-flow', verified: true },
    { sha: 'b', login: 'dependabot[bot]', committer: 'web-flow', verified: false },
    { sha: 'c', login: 'someuser', committer: 'web-flow', verified: true },
  ];
  assert.equal(findDependabotLockCommit({ lockBlob: 'lock-2', commits, lockBlobAt }), null);
  assert.equal(findDependabotLockCommit({ lockBlob: 'lock-1', commits, lockBlobAt }), 'a');
  assert.equal(findDependabotLockCommit({ lockBlob: 'lock-2', lockBlobAt,
    commits: [...commits, { sha: 'd', login: 'dependabot[bot]', committer: 'web-flow', verified: true }] }), 'd');
  assert.equal(findDependabotLockCommit({ lockBlob: null, commits, lockBlobAt }), null);
});

test('requires a Dependabot author with GitHub as the verified committer', () => {
  assert.equal(isDependabotCommit({ login: 'dependabot[bot]', committer: 'web-flow', verified: true }), true);
  // A collaborator can sign with their own key and set Dependabot as the author.
  assert.equal(isDependabotCommit({ login: 'dependabot[bot]', committer: 'someuser', verified: true }), false);
  assert.equal(isDependabotCommit({ login: 'dependabot[bot]', committer: null, verified: true }), false);
  assert.equal(isDependabotCommit({ login: 'dependabot[bot]', committer: 'web-flow', verified: false }), false);
  assert.equal(isDependabotCommit({ login: 'someuser', committer: 'web-flow', verified: true }), false);
});

test('ignores a lockfile commit with a spoofed Dependabot author', () => {
  const lockBlobAt = () => 'lock-1';
  const spoofed = [{ sha: 'x', login: 'dependabot[bot]', committer: 'someuser', verified: true }];
  assert.equal(findDependabotLockCommit({ lockBlob: 'lock-1', commits: spoofed, lockBlobAt }), null);
});

test('finds the merged Dependabot pull request for a master commit', () => {
  const pull = (overrides) => ({ number: 1, user: { login: 'dependabot[bot]' }, merged_at: '2026-11-05T00:00:00Z',
    merge_commit_sha: 'm', base: { ref: 'master' }, ...overrides });
  assert.equal(findMergedDependabotPull([pull({})], 'm', 'master')?.number, 1);
  assert.equal(findMergedDependabotPull([pull({ merged_at: null })], 'm', 'master'), null);
  assert.equal(findMergedDependabotPull([pull({ user: { login: 'someuser' } })], 'm', 'master'), null);
  assert.equal(findMergedDependabotPull([pull({ merge_commit_sha: 'other' })], 'm', 'master'), null);
  assert.equal(findMergedDependabotPull([pull({ base: { ref: 'release' } })], 'm', 'master'), null);
});

test('trusts only merge commits that GitHub created and signed', () => {
  assert.equal(isGitHubSignedCommit({ committer: { login: 'web-flow' }, commit: { verification: { committer: 'web-flow', verified: true } } }), true);
  assert.equal(isGitHubSignedCommit({ committer: { login: 'web-flow' }, commit: { verification: { committer: 'web-flow', verified: false } } }), false);
  assert.equal(isGitHubSignedCommit({ committer: { login: 'someuser' }, commit: { verification: { committer: 'web-flow', verified: true } } }), false);
  assert.equal(isGitHubSignedCommit(null), false);
});

// Run the `pr` command against a real git history, with a stub `gh` that lists the PR commits.
function runPrCheck(build) {
  const root = mkdtempSync(path.join(tmpdir(), 'lockfile-trust-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const commit = (author, files) => {
      for (const [file, contents] of Object.entries(files)) writeFileSync(path.join(root, file), contents);
      git('add', '.');
      git('-c', `user.name=${author}`, '-c', `user.email=${author}@example.invalid`, 'commit', '-qm', author);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q');
    const baseSha = commit('base', { 'pnpm-lock.yaml': 'lock: base\n', 'package.json': '{}\n' });
    const { author, commits } = build(commit);
    const bin = path.join(root, '.bin');
    execFileSync('mkdir', [bin]);
    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$GH_STUB_OUTPUT"\n');
    chmodSync(path.join(bin, 'gh'), 0o755);
    const output = path.join(root, '.output');
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [path.resolve('.github/scripts/lockfile-trust.mjs'), 'pr'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: repo,
        PR_NUMBER: '7', BASE_SHA: baseSha, HEAD_SHA: git('rev-parse', 'HEAD'), PR_AUTHOR: author, HEAD_REPO: repo,
        HEAD_REF: 'dependabot/npm_and_yarn/zod', GH_STUB_OUTPUT: commits.map((entry) => JSON.stringify(entry)).join('\n') },
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('pr command admits a Dependabot lockfile after a later non-lockfile commit', () => {
  const result = runPrCheck((commit) => {
    const sha = commit('dependabot', { 'pnpm-lock.yaml': 'lock: dependabot\n', 'package.json': '{"zod":"4.6.6"}\n' });
    commit('maintainer', { 'notes.md': 'fix\n' });
    return { author: 'dependabot[bot]', commits: [{ sha, login: 'dependabot[bot]', committer: 'web-flow', verified: true }] };
  });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.output, /^writer=dependabot$/m);
});

test('pr command blocks a lockfile edited after the Dependabot commit', () => {
  const result = runPrCheck((commit) => {
    const sha = commit('dependabot', { 'pnpm-lock.yaml': 'lock: dependabot\n' });
    const edit = commit('maintainer', { 'pnpm-lock.yaml': 'lock: edited\n' });
    return { author: 'dependabot[bot]', commits: [
      { sha, login: 'dependabot[bot]', committer: 'web-flow', verified: true },
      { sha: edit, login: 'maintainer', committer: 'web-flow', verified: true },
    ] };
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Untrusted lockfile change/);
});

test('pr command blocks a lockfile commit whose Dependabot author another committer signed', () => {
  const result = runPrCheck((commit) => {
    const sha = commit('maintainer', { 'pnpm-lock.yaml': 'lock: spoofed\n' });
    return { author: 'dependabot[bot]', commits: [{ sha, login: 'dependabot[bot]', committer: 'maintainer', verified: true }] };
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Untrusted lockfile change/);
});

test('pr command blocks a contributor lockfile change', () => {
  const result = runPrCheck((commit) => {
    commit('someuser', { 'pnpm-lock.yaml': 'lock: contributor\n' });
    return { author: 'someuser', commits: [] };
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /^writer=none$/m);
});

test('workflows run the trust policy from trusted code and pass the verified hash to the proof refresh', () => {
  const pr = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
  assert.match(pr, /git show "\$BASE_SHA:\.github\/scripts\/lockfile-trust\.mjs" > "\$policy"/);
  assert.match(pr, /node "\$policy" pr/);
  assert.match(pr, /PAPERCLIP_CI_PR_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.doesNotMatch(pr, /github\.head_ref != 'chore\/refresh-lockfile'/);

  const refresh = readFileSync('.github/workflows/refresh-lockfile.yml', 'utf8');
  assert.match(refresh, /node \.github\/scripts\/lockfile-trust\.mjs merged/);
  assert.match(refresh, /--refresh --trusted-lock-sha256 "\$TRUSTED_LOCK_SHA256"/);
  assert.ok(refresh.indexOf('lockfile-trust.mjs merged') < refresh.indexOf('--trusted-lock-sha256'));
});
