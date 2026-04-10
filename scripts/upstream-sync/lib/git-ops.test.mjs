import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureConflictDiagnostics,
  listMaintenanceCommits,
  prepareBotBranch,
  replayCommitStack,
} from './git-ops.mjs';

function createRunMock(responses = []) {
  const calls = [];
  const run = async (command) => {
    calls.push(command);
    const response = responses.shift();
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
