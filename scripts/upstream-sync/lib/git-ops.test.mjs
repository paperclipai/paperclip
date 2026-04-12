import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyMaintenanceOverlay,
  captureConflictDiagnostics,
  commitMaintenanceOverlay,
  findLatestIntegratedUpstreamBase,
  listMaintenanceCommits,
  prepareBotBranch,
  replayCommitStack,
} from './git-ops.mjs';

function createRunMock(responses = []) {
  const calls = [];
  const run = async (command) => {
    calls.push(command);
    const response = responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response ?? '';
  };

  return { calls, run };
}

test('listMaintenanceCommits computes the maintenance stack from merge-base to maintenance ref', async () => {
  const { calls, run } = createRunMock(['merge-base-sha\n', 'c3\nc2\nc1\n']);

  const commits = await listMaintenanceCommits({
    run,
    upstreamRef: 'origin/master',
    maintenanceRef: 'HEAD',
  });

  assert.deepEqual(commits, ['c3', 'c2', 'c1']);
  assert.deepEqual(calls, [
    { command: 'git', args: ['merge-base', 'origin/master', 'HEAD'] },
    { command: 'git', args: ['rev-list', '--reverse', 'merge-base-sha..HEAD'] },
  ]);
});

test('prepareBotBranch checks out a named bot branch from the upstream base', async () => {
  const { calls, run } = createRunMock();

  await prepareBotBranch({
    run,
    baseRef: 'origin/master',
    branchName: 'bot-upgrade/abc123',
  });

  assert.deepEqual(calls, [
    { command: 'git', args: ['checkout', '-B', 'bot-upgrade/abc123', 'origin/master'] },
  ]);
});

test('findLatestIntegratedUpstreamBase finds the latest upstream merge on the first-parent maintenance path', async () => {
  const { calls, run } = createRunMock([
    'merge-two\nmerge-one\n',
    'merge-two head feature-parent\n',
    'base-sha\n',
    'merge-one head upstream-parent\n',
    'upstream-parent\n',
  ]);

  const result = await findLatestIntegratedUpstreamBase({
    run,
    upstreamRef: 'origin/master',
    maintenanceRef: 'HEAD',
  });

  assert.deepEqual(result, {
    mergeCommit: 'merge-one',
    firstParent: 'head',
    upstreamBase: 'upstream-parent',
  });
  assert.deepEqual(calls, [
    { command: 'git', args: ['rev-list', '--first-parent', '--merges', 'HEAD'] },
    { command: 'git', args: ['rev-list', '--parents', '-n', '1', 'merge-two'] },
    { command: 'git', args: ['merge-base', 'feature-parent', 'origin/master'] },
    { command: 'git', args: ['rev-list', '--parents', '-n', '1', 'merge-one'] },
    { command: 'git', args: ['merge-base', 'upstream-parent', 'origin/master'] },
  ]);
});

test('applyMaintenanceOverlay writes and applies a 3-way overlay patch', async () => {
  const { calls, run } = createRunMock([
    'diff --git a/file.txt b/file.txt\n',
    '',
  ]);

  const result = await applyMaintenanceOverlay({
    run,
    overlayBase: 'upstream-base',
    maintenanceRef: 'HEAD',
  });

  assert.deepEqual(result, { applied: true });
  assert.deepEqual(calls[0], {
    command: 'git',
    args: ['diff', '--binary', 'upstream-base', 'HEAD'],
  });
  assert.deepEqual(calls[1].args.slice(0, 3), ['apply', '--3way', '--index']);
  assert.match(calls[1].args[3], /maintenance-overlay\.patch$/);
});

test('applyMaintenanceOverlay tags apply failures as maintenance overlay conflicts', async () => {
  const { run } = createRunMock([
    'diff --git a/file.txt b/file.txt\n',
    new Error('apply failed'),
  ]);

  await assert.rejects(
    () => applyMaintenanceOverlay({
      run,
      overlayBase: 'upstream-base',
      maintenanceRef: 'HEAD',
    }),
    (error) => {
      assert.equal(error.message, 'apply failed');
      assert.equal(error.failingCommit, 'maintenance-overlay');
      assert.equal(error.failingCommitSummary, 'maintenance overlay upstream-base..HEAD\n');
      return true;
    },
  );
});

test('commitMaintenanceOverlay creates a synthetic overlay commit when staged changes exist', async () => {
  const { calls, run } = createRunMock([
    'server/src/startup-banner.ts\n',
    '',
  ]);

  const committed = await commitMaintenanceOverlay({
    run,
    overlayBase: 'upstream-base',
    maintenanceRef: 'origin/zh-enterprise',
  });

  assert.equal(committed, true);
  assert.deepEqual(calls, [
    { command: 'git', args: ['diff', '--cached', '--name-only'] },
    {
      command: 'git',
      args: [
        'commit',
        '-m',
        'chore(upstream): apply maintenance overlay',
        '-m',
        'Overlay base: upstream-base\nMaintenance ref: origin/zh-enterprise',
      ],
    },
  ]);
});

test('replayCommitStack cherry-picks commits in order', async () => {
  const { calls, run } = createRunMock();

  await replayCommitStack({
    run,
    commits: ['c1', 'c2', 'c3'],
  });

  assert.deepEqual(calls, [
    { command: 'git', args: ['cherry-pick', 'c1'] },
    { command: 'git', args: ['cherry-pick', 'c2'] },
    { command: 'git', args: ['cherry-pick', 'c3'] },
  ]);
});

test('captureConflictDiagnostics collects conflict context for the failing commit', async () => {
  const { calls, run } = createRunMock();

  await captureConflictDiagnostics({
    run,
    failingCommit: 'deadbeef',
  });

  assert.deepEqual(calls, [
    { command: 'git', args: ['status', '--short'] },
    { command: 'git', args: ['show', '--stat', '--oneline', '-1', 'deadbeef'] },
    { command: 'git', args: ['diff', '--name-only', '--diff-filter=U'] },
  ]);
});
