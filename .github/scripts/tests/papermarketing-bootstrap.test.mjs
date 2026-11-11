import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { classifyPullRequest, PAPERMARKETING_BOOTSTRAP_LOCKS, PROVIDER_LOCKFILES } from '../lockfile-trust.mjs';

const reviewed = {
  author: 'arthurbonora', headRepo: 'arthurbonora/papermarketing', baseRepo: 'arthurbonora/papermarketing',
  headRef: 'feat/agent-graph-dashboard-consolidated', pullNumber: '1',
  changedPaths: Object.keys(PAPERMARKETING_BOOTSTRAP_LOCKS),
  lockedContentSha256: { ...PAPERMARKETING_BOOTSTRAP_LOCKS },
};
test('admits only the exact three dependency artifacts reviewed for the bootstrap PR', () => {
  const result = classifyPullRequest(reviewed);
  assert.equal(result.allowed, true);
  assert.equal(result.writer, 'reviewed-fork-bootstrap');
});
test('rejects every missing or changed artifact even if only one appears in the PR diff', () => {
  for (const file of reviewed.changedPaths) for (const digest of [undefined, 'f'.repeat(64)]) {
    const hashes = { ...reviewed.lockedContentSha256, [file]: digest };
    assert.equal(classifyPullRequest({ ...reviewed, lockedContentSha256: hashes }).allowed, false, file);
    assert.equal(classifyPullRequest({ ...reviewed, changedPaths: ['pnpm-lock.yaml'], lockedContentSha256: hashes }).allowed, false, file);
  }
});
test('does not extend bootstrap authority to other repositories, branches, PRs or provider locks', () => {
  for (const delta of [
    { headRepo: 'someone/papermarketing' }, { baseRepo: 'paperclipai/paperclip', headRepo: 'paperclipai/paperclip' },
    { headRef: 'other' }, { pullNumber: '2' }, { pullNumber: '' }, { lockedContentSha256: {} },
    ...PROVIDER_LOCKFILES.map(file => ({ changedPaths: [...reviewed.changedPaths, file] })),
  ]) assert.equal(classifyPullRequest({ ...reviewed, ...delta }).allowed, false, JSON.stringify(delta));
});
test('keeps image publication and the upstream auto-merge bot gated off in forks', () => {
  for (const [name, job] of [['docker.yml', 'build-and-push'], ['agent-runtime-images.yml', 'build-and-sign'], ['refresh-lockfile.yml', 'refresh']]) {
    const workflow = readFileSync(new URL(`../../workflows/${name}`, import.meta.url), 'utf8');
    const block = workflow.split(`  ${job}:`)[1]?.split(/\n  [a-z][a-z_-]+:/)[0];
    assert.ok(block, job);
    assert.match(block, /\n    if: (?:\$\{\{ )?github\.repository == 'paperclipai\/paperclip'/, name);
  }
});
