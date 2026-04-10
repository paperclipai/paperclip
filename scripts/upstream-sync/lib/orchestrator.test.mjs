import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { runUpstreamSync } from './orchestrator.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function createSandbox(name) {
  const sandboxRoot = path.join(repoRoot, 'scripts', 'upstream-sync', '.test-artifacts', name);
  const sandbox = sandboxRoot;
  fs.mkdirSync(sandbox, { recursive: true });
  return { sandboxRoot, sandbox };
}

function createRunMock(responses) {
  const calls = [];
  const run = async (command) => {
    calls.push(command);
    const key = JSON.stringify(command);
    const response = responses[key];
    if (response instanceof Error) {
      throw response;
    }

    return response ?? '';
  };

  return { calls, run };
}

test('runUpstreamSync dry-run prepares a bot branch name without replaying commits', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`dry-run-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  let validationCallCount = 0;
  const { calls, run } = createRunMock({
    '{"command":"git","args":["merge-base","origin/master","HEAD"]}': 'base-sha\n',
    '{"command":"git","args":["rev-list","--reverse","base-sha..HEAD"]}': 'c3\nc2\nc1\n',
    '{"command":"git","args":["rev-parse","--short=12","origin/master"]}': { stdout: 'abc123def456\n' },
  });

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'origin/master',
        maintenanceRef: 'HEAD',
        branchPrefix: 'bot-upgrade',
        dryRun: true,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
      run,
      runValidation: async () => {
        validationCallCount += 1;
        return {
          status: 'passed',
          uiTypecheck: { status: 'passed', summary: 'UI typecheck passed.' },
          serverTypecheck: { status: 'passed', summary: 'Server typecheck passed.' },
          checkI18n: { status: 'passed', summary: 'check:i18n passed.' },
          checks: [],
          logPath: 'reports/upstream-sync-validation-log.json',
        };
      },
    });

    assert.equal(result.status, 'dry-run');
    assert.equal(result.branchName, 'bot-upgrade/abc123def456');
    assert.equal(result.validationStatus, 'not-run');
    assert.equal(result.readyForPr, false);
    assert.equal(result.validationLogPath, 'reports/upstream-sync-validation-log.json');
    assert.deepEqual(result.commits, ['c3', 'c2', 'c1']);
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(result.reportPath, 'reports/upstream-sync-report.json');
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.validationLogPath)), true);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'));
    assert.equal(report.branchName, 'bot-upgrade/abc123def456');
    assert.equal(report.validationSummary.status, 'not-run');
    assert.equal(report.validationSummary.reason, 'dry-run');
    assert.equal(report.readyForPr, false);
    assert.equal(report.validationLogPath, 'reports/upstream-sync-validation-log.json');
    assert.match(fs.readFileSync(path.join(sandbox, result.prBodyPath), 'utf8'), /overall: `not-run`/);
    assert.equal(validationCallCount, 0);
    assert.deepEqual(calls, [
      { command: 'git', args: ['merge-base', 'origin/master', 'HEAD'] },
      { command: 'git', args: ['rev-list', '--reverse', 'base-sha..HEAD'] },
      { command: 'git', args: ['rev-parse', '--short=12', 'origin/master'] },
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runUpstreamSync replays commits when not in dry-run mode', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`replay-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  let validationCallCount = 0;
  const { calls, run } = createRunMock({
    '{"command":"git","args":["merge-base","origin/master","HEAD"]}': 'base-sha\n',
    '{"command":"git","args":["rev-list","--reverse","base-sha..HEAD"]}': 'c1\nc2\n',
    '{"command":"git","args":["rev-parse","--short=12","origin/master"]}': 'abc123def456\n',
    '{"command":"git","args":["checkout","-B","bot-upgrade/abc123def456","origin/master"]}': '',
    '{"command":"git","args":["cherry-pick","c1"]}': '',
    '{"command":"git","args":["cherry-pick","c2"]}': '',
  });

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'origin/master',
        maintenanceRef: 'HEAD',
        branchPrefix: 'bot-upgrade',
        dryRun: false,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
      run,
      runValidation: async () => {
        validationCallCount += 1;
        return {
          status: 'passed',
          uiTypecheck: { status: 'passed', summary: 'UI typecheck passed.' },
          serverTypecheck: { status: 'passed', summary: 'Server typecheck passed.' },
          checkI18n: { status: 'passed', summary: 'check:i18n passed.' },
          checks: [],
          logPath: 'reports/upstream-sync-validation-log.json',
        };
      },
    });

    assert.equal(result.status, 'replayed');
    assert.equal(result.validationStatus, 'passed');
    assert.equal(result.readyForPr, true);
    assert.equal(result.validationLogPath, 'reports/upstream-sync-validation-log.json');
    assert.deepEqual(result.commits, ['c1', 'c2']);
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(result.reportPath, 'reports/upstream-sync-report.json');
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'));
    assert.equal(report.validationSummary.status, 'passed');
    assert.equal(report.readyForPr, true);
    assert.match(fs.readFileSync(path.join(sandbox, result.prBodyPath), 'utf8'), /server typecheck: `passed`/);
    assert.equal(validationCallCount, 1);
    assert.deepEqual(calls, [
      { command: 'git', args: ['merge-base', 'origin/master', 'HEAD'] },
      { command: 'git', args: ['rev-list', '--reverse', 'base-sha..HEAD'] },
      { command: 'git', args: ['rev-parse', '--short=12', 'origin/master'] },
      { command: 'git', args: ['checkout', '-B', 'bot-upgrade/abc123def456', 'origin/master'] },
      { command: 'git', args: ['cherry-pick', 'c1'] },
      { command: 'git', args: ['cherry-pick', 'c2'] },
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runUpstreamSync returns no-op when there are no maintenance commits to replay', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`no-op-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  let validationCallCount = 0;
  const { calls, run } = createRunMock({
    '{"command":"git","args":["merge-base","origin/master","HEAD"]}': 'base-sha\n',
    '{"command":"git","args":["rev-list","--reverse","base-sha..HEAD"]}': '',
    '{"command":"git","args":["rev-parse","--short=12","origin/master"]}': 'abc123def456\n',
  });

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'origin/master',
        maintenanceRef: 'HEAD',
        branchPrefix: 'bot-upgrade',
        dryRun: false,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
      run,
      runValidation: async () => {
        validationCallCount += 1;
        return {
          status: 'passed',
          uiTypecheck: { status: 'passed', summary: 'UI typecheck passed.' },
          serverTypecheck: { status: 'passed', summary: 'Server typecheck passed.' },
          checkI18n: { status: 'passed', summary: 'check:i18n passed.' },
          checks: [],
          logPath: 'reports/upstream-sync-validation-log.json',
        };
      },
    });

    assert.equal(result.status, 'no-op');
    assert.equal(result.readyForPr, false);
    assert.equal(result.validationStatus, 'not-run');
    assert.equal(result.validationLogPath, 'reports/upstream-sync-validation-log.json');
    assert.equal(validationCallCount, 0);
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.validationLogPath)), true);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'));
    assert.equal(report.status, 'no-op');
    assert.equal(report.validationSummary.reason, 'no-commits');
    assert.deepEqual(calls, [
      { command: 'git', args: ['merge-base', 'origin/master', 'HEAD'] },
      { command: 'git', args: ['rev-list', '--reverse', 'base-sha..HEAD'] },
      { command: 'git', args: ['rev-parse', '--short=12', 'origin/master'] },
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runUpstreamSync captures cherry-pick conflicts and reports diagnostics', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`conflict-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  let validationCallCount = 0;
  const { calls, run } = createRunMock({
    '{"command":"git","args":["merge-base","origin/master","HEAD"]}': 'base-sha\n',
    '{"command":"git","args":["rev-list","--reverse","base-sha..HEAD"]}': 'c1\nc2\n',
    '{"command":"git","args":["rev-parse","--short=12","origin/master"]}': 'abc123def456\n',
    '{"command":"git","args":["checkout","-B","bot-upgrade/abc123def456","origin/master"]}': '',
    '{"command":"git","args":["cherry-pick","c1"]}': '',
    '{"command":"git","args":["cherry-pick","c2"]}': new Error('cherry-pick failed'),
    '{"command":"git","args":["diff","--name-only","--diff-filter=U"]}': 'scripts/upstream-sync/lib/orchestrator.mjs\n',
    '{"command":"git","args":["status","--short"]}': 'UU scripts/upstream-sync/lib/orchestrator.mjs\n',
    '{"command":"git","args":["show","--stat","--oneline","-1","c2"]}': 'c2 conflict commit summary\n',
  });

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'origin/master',
        maintenanceRef: 'HEAD',
        branchPrefix: 'bot-upgrade',
        dryRun: false,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
      run,
      runValidation: async () => {
        validationCallCount += 1;
        return {
          status: 'passed',
          uiTypecheck: { status: 'passed', summary: 'UI typecheck passed.' },
          serverTypecheck: { status: 'passed', summary: 'Server typecheck passed.' },
          checkI18n: { status: 'passed', summary: 'check:i18n passed.' },
          checks: [],
          logPath: 'reports/upstream-sync-validation-log.json',
        };
      },
    });

    assert.equal(result.status, 'conflict');
    assert.deepEqual(result.diagnostics, {
      failingCommit: 'c2',
      status: 'UU scripts/upstream-sync/lib/orchestrator.mjs\n',
      conflicts: ['scripts/upstream-sync/lib/orchestrator.mjs'],
      failingCommitSummary: 'c2 conflict commit summary\n',
    });
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'));
    assert.equal(report.status, 'conflict');
    assert.equal(report.validationSummary.status, 'not-run');
    assert.equal(report.validationSummary.reason, 'replay-conflict');
    assert.equal(result.validationLogPath, 'reports/upstream-sync-validation-log.json');
    assert.equal(fs.existsSync(path.join(sandbox, result.validationLogPath)), true);
    assert.equal(report.readyForPr, false);
    assert.deepEqual(report.conflictDiagnostics, {
      failingCommit: 'c2',
      status: 'UU scripts/upstream-sync/lib/orchestrator.mjs\n',
      conflicts: ['scripts/upstream-sync/lib/orchestrator.mjs'],
      failingCommitSummary: 'c2 conflict commit summary\n',
    });
    assert.equal(validationCallCount, 0);
    assert.deepEqual(calls, [
      { command: 'git', args: ['merge-base', 'origin/master', 'HEAD'] },
      { command: 'git', args: ['rev-list', '--reverse', 'base-sha..HEAD'] },
      { command: 'git', args: ['rev-parse', '--short=12', 'origin/master'] },
      { command: 'git', args: ['checkout', '-B', 'bot-upgrade/abc123def456', 'origin/master'] },
      { command: 'git', args: ['cherry-pick', 'c1'] },
      { command: 'git', args: ['cherry-pick', 'c2'] },
      { command: 'git', args: ['diff', '--name-only', '--diff-filter=U'] },
      { command: 'git', args: ['status', '--short'] },
      { command: 'git', args: ['show', '--stat', '--oneline', '-1', 'c2'] },
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runUpstreamSync records non-conflict replay failures without losing artifacts', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`non-conflict-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  const { calls, run } = createRunMock({
    '{"command":"git","args":["merge-base","origin/master","HEAD"]}': 'base-sha\n',
    '{"command":"git","args":["rev-list","--reverse","base-sha..HEAD"]}': 'c1\nc2\n',
    '{"command":"git","args":["rev-parse","--short=12","origin/master"]}': 'abc123def456\n',
    '{"command":"git","args":["checkout","-B","bot-upgrade/abc123def456","origin/master"]}': '',
    '{"command":"git","args":["cherry-pick","c1"]}': '',
    '{"command":"git","args":["cherry-pick","c2"]}': new Error('replay failed'),
    '{"command":"git","args":["diff","--name-only","--diff-filter=U"]}': '',
  });

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'origin/master',
        maintenanceRef: 'HEAD',
        branchPrefix: 'bot-upgrade',
        dryRun: false,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
      run,
    });

    assert.equal(result.status, 'error');
    assert.equal(result.readyForPr, false);
    assert.equal(result.validationStatus, 'not-run');
    assert.equal(result.validationLogPath, 'reports/upstream-sync-validation-log.json');
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.validationLogPath)), true);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'));
    assert.equal(report.failure.stage, 'detect-conflicts');
    assert.equal(report.failure.message, 'replay failed');
    assert.deepEqual(calls, [
      { command: 'git', args: ['merge-base', 'origin/master', 'HEAD'] },
      { command: 'git', args: ['rev-list', '--reverse', 'base-sha..HEAD'] },
      { command: 'git', args: ['rev-parse', '--short=12', 'origin/master'] },
      { command: 'git', args: ['checkout', '-B', 'bot-upgrade/abc123def456', 'origin/master'] },
      { command: 'git', args: ['cherry-pick', 'c1'] },
      { command: 'git', args: ['cherry-pick', 'c2'] },
      { command: 'git', args: ['diff', '--name-only', '--diff-filter=U'] },
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runUpstreamSync writes validation failures to report artifacts without throwing', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`validation-report-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  const { run } = createRunMock({
    '{"command":"git","args":["merge-base","origin/master","HEAD"]}': 'base-sha\n',
    '{"command":"git","args":["rev-list","--reverse","base-sha..HEAD"]}': 'c1\n',
    '{"command":"git","args":["rev-parse","--short=12","origin/master"]}': 'abc123def456\n',
    '{"command":"git","args":["checkout","-B","bot-upgrade/abc123def456","origin/master"]}': '',
    '{"command":"git","args":["cherry-pick","c1"]}': '',
  });

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'origin/master',
        maintenanceRef: 'HEAD',
        branchPrefix: 'bot-upgrade',
        dryRun: false,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
      run,
      runValidation: async () => ({
        status: 'failed',
        uiTypecheck: { status: 'passed', summary: 'UI typecheck passed.' },
        serverTypecheck: { status: 'failed', summary: 'Server typecheck failed with exit code 1.', exitCode: 1 },
        checkI18n: { status: 'passed', summary: 'check:i18n passed.' },
        checks: [],
        logPath: 'reports/upstream-sync-validation-log.json',
      }),
    });

    assert.equal(result.status, 'replayed');
    assert.equal(result.validationStatus, 'failed');
    assert.equal(result.readyForPr, false);
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'));
    assert.equal(report.validationSummary.status, 'failed');
    assert.equal(report.readyForPr, false);
    const prBody = fs.readFileSync(path.join(sandbox, result.prBodyPath), 'utf8');
    assert.match(prBody, /overall: `failed`/);
    assert.match(prBody, /server typecheck: `failed`/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runUpstreamSync records unexpected validation runner errors without losing artifacts', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`validation-error-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  const { run } = createRunMock({
    '{"command":"git","args":["merge-base","origin/master","HEAD"]}': 'base-sha\n',
    '{"command":"git","args":["rev-list","--reverse","base-sha..HEAD"]}': 'c1\n',
    '{"command":"git","args":["rev-parse","--short=12","origin/master"]}': 'abc123def456\n',
    '{"command":"git","args":["checkout","-B","bot-upgrade/abc123def456","origin/master"]}': '',
    '{"command":"git","args":["cherry-pick","c1"]}': '',
  });

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'origin/master',
        maintenanceRef: 'HEAD',
        branchPrefix: 'bot-upgrade',
        dryRun: false,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
      run,
      runValidation: async () => {
        throw new Error('validation log write failed');
      },
    });

    assert.equal(result.status, 'replayed');
    assert.equal(result.validationStatus, 'error');
    assert.equal(result.readyForPr, false);
    assert.equal(result.validationLogPath, 'reports/upstream-sync-validation-log.json');
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.validationLogPath)), true);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'));
    assert.equal(report.validationSummary.status, 'error');
    assert.equal(report.validationSummary.reason, 'validation-runner-error');
    assert.equal(report.validationSummary.errorMessage, 'validation log write failed');
    const prBody = fs.readFileSync(path.join(sandbox, result.prBodyPath), 'utf8');
    assert.match(prBody, /overall: `error`/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runUpstreamSync records localization scan failures without losing artifacts', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`localization-error-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  const { run } = createRunMock({
    '{"command":"git","args":["merge-base","origin/master","HEAD"]}': 'base-sha\n',
    '{"command":"git","args":["rev-list","--reverse","base-sha..HEAD"]}': 'c1\n',
    '{"command":"git","args":["rev-parse","--short=12","origin/master"]}': 'abc123def456\n',
    '{"command":"git","args":["checkout","-B","bot-upgrade/abc123def456","origin/master"]}': '',
    '{"command":"git","args":["cherry-pick","c1"]}': '',
  });

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'origin/master',
        maintenanceRef: 'HEAD',
        branchPrefix: 'bot-upgrade',
        dryRun: false,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
      run,
      scanLocalization: async () => {
        throw new Error('localization scan failed');
      },
    });

    assert.equal(result.status, 'error');
    assert.equal(result.validationStatus, 'not-run');
    assert.equal(result.readyForPr, false);
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.validationLogPath)), true);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'));
    assert.equal(report.failure.stage, 'scan-localization');
    assert.equal(report.failure.message, 'localization scan failed');
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runUpstreamSync falls back to a minimal PR body when custom rendering fails', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`render-error-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  const { run } = createRunMock({
    '{"command":"git","args":["merge-base","origin/master","HEAD"]}': 'base-sha\n',
    '{"command":"git","args":["rev-list","--reverse","base-sha..HEAD"]}': 'c1\n',
    '{"command":"git","args":["rev-parse","--short=12","origin/master"]}': 'abc123def456\n',
    '{"command":"git","args":["checkout","-B","bot-upgrade/abc123def456","origin/master"]}': '',
    '{"command":"git","args":["cherry-pick","c1"]}': '',
  });

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'origin/master',
        maintenanceRef: 'HEAD',
        branchPrefix: 'bot-upgrade',
        dryRun: false,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
      run,
      runValidation: async () => ({
        status: 'passed',
        uiTypecheck: { status: 'passed', summary: 'UI typecheck passed.' },
        serverTypecheck: { status: 'passed', summary: 'Server typecheck passed.' },
        checkI18n: { status: 'passed', summary: 'check:i18n passed.' },
        checks: [],
        logPath: 'reports/upstream-sync-validation-log.json',
      }),
      renderPrBodyContent: () => {
        throw new Error('render body failed');
      },
    });

    assert.equal(result.status, 'error');
    assert.equal(result.readyForPr, false);
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
    const report = JSON.parse(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'));
    assert.equal(report.failure.stage, 'render-pr-body');
    assert.equal(report.failure.message, 'render body failed');
    const prBody = fs.readFileSync(path.join(sandbox, result.prBodyPath), 'utf8');
    assert.match(prBody, /# Upstream sync/);
    assert.match(prBody, /## Failure/);
    assert.match(prBody, /render body failed/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
