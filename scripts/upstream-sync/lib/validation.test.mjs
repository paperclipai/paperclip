import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSkippedValidationSummary, runValidationSuite, writeValidationArtifact } from './validation.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function createSandbox(name) {
  const sandboxRoot = path.join(repoRoot, 'scripts', 'upstream-sync', '.test-artifacts', name);
  fs.mkdirSync(sandboxRoot, { recursive: true });
  return sandboxRoot;
}

function createValidationRunner(responses) {
  const calls = [];
  const runCommand = async (command) => {
    calls.push(command);
    const key = JSON.stringify(command);
    const response = responses[key];
    if (response instanceof Error) {
      throw response;
    }

    return response ?? { stdout: '', stderr: '', exitCode: 0 };
  };

  return { calls, runCommand };
}

test('runValidationSuite passes when all approved checks succeed', async () => {
  const sandboxRoot = createSandbox(`validation-pass-${Date.now()}`);
  const artifactPath = path.join(sandboxRoot, 'reports', 'validation-log.json');
  const { calls, runCommand } = createValidationRunner({
    '{"command":"pnpm","args":["--filter","@paperclipai/ui","typecheck"]}': { stdout: 'ui ok\n', stderr: '', exitCode: 0 },
    '{"command":"pnpm","args":["--filter","@paperclipai/server","typecheck"]}': { stdout: 'server ok\n', stderr: '', exitCode: 0 },
    '{"command":"pnpm","args":["check:i18n"]}': { stdout: 'i18n ok\n', stderr: '', exitCode: 0 },
  });

  try {
    const result = await runValidationSuite({ runCommand, artifactPath });

    assert.equal(result.status, 'passed');
    assert.equal(result.uiTypecheck.status, 'passed');
    assert.equal(result.serverTypecheck.status, 'passed');
    assert.equal(result.checkI18n.status, 'passed');
    assert.equal(result.logPath, artifactPath);
    assert.equal(fs.existsSync(artifactPath), true);
    assert.deepEqual(calls, [
      { command: 'pnpm', args: ['--filter', '@paperclipai/ui', 'typecheck'] },
      { command: 'pnpm', args: ['--filter', '@paperclipai/server', 'typecheck'] },
      { command: 'pnpm', args: ['check:i18n'] },
    ]);

    const log = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.equal(log.status, 'passed');
    assert.equal(log.checks.length, 3);
    assert.equal(log.checks[0].stdout, 'ui ok\n');
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runValidationSuite records failures without dropping later checks', async () => {
  const sandboxRoot = createSandbox(`validation-fail-${Date.now()}`);
  const artifactPath = path.join(sandboxRoot, 'reports', 'validation-log.json');
  const failure = Object.assign(new Error('server typecheck failed'), {
    stdout: 'server started\n',
    stderr: 'Type error\n',
    code: 1,
  });
  const { calls, runCommand } = createValidationRunner({
    '{"command":"pnpm","args":["--filter","@paperclipai/ui","typecheck"]}': { stdout: 'ui ok\n', stderr: '', exitCode: 0 },
    '{"command":"pnpm","args":["--filter","@paperclipai/server","typecheck"]}': failure,
    '{"command":"pnpm","args":["check:i18n"]}': { stdout: 'i18n ok\n', stderr: '', exitCode: 0 },
  });

  try {
    const result = await runValidationSuite({ runCommand, artifactPath });

    assert.equal(result.status, 'failed');
    assert.equal(result.uiTypecheck.status, 'passed');
    assert.equal(result.serverTypecheck.status, 'failed');
    assert.equal(result.serverTypecheck.exitCode, 1);
    assert.equal(result.checkI18n.status, 'passed');
    assert.equal(fs.existsSync(artifactPath), true);
    assert.deepEqual(calls, [
      { command: 'pnpm', args: ['--filter', '@paperclipai/ui', 'typecheck'] },
      { command: 'pnpm', args: ['--filter', '@paperclipai/server', 'typecheck'] },
      { command: 'pnpm', args: ['check:i18n'] },
    ]);

    const log = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.equal(log.status, 'failed');
    assert.equal(log.checks[1].status, 'failed');
    assert.equal(log.checks[2].status, 'passed');
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runValidationSuite records unexpected runner errors explicitly and continues', async () => {
  const sandboxRoot = createSandbox(`validation-error-${Date.now()}`);
  const artifactPath = path.join(sandboxRoot, 'reports', 'validation-log.json');
  const failure = new Error('pnpm not available');
  const { calls, runCommand } = createValidationRunner({
    '{"command":"pnpm","args":["--filter","@paperclipai/ui","typecheck"]}': { stdout: 'ui ok\n', stderr: '', exitCode: 0 },
    '{"command":"pnpm","args":["--filter","@paperclipai/server","typecheck"]}': failure,
    '{"command":"pnpm","args":["check:i18n"]}': { stdout: 'i18n ok\n', stderr: '', exitCode: 0 },
  });

  try {
    const result = await runValidationSuite({ runCommand, artifactPath });

    assert.equal(result.status, 'error');
    assert.equal(result.uiTypecheck.status, 'passed');
    assert.equal(result.serverTypecheck.status, 'error');
    assert.equal(result.serverTypecheck.exitCode, null);
    assert.match(result.serverTypecheck.summary, /unexpected error/i);
    assert.equal(result.checkI18n.status, 'passed');
    assert.equal(fs.existsSync(artifactPath), true);
    assert.deepEqual(calls, [
      { command: 'pnpm', args: ['--filter', '@paperclipai/ui', 'typecheck'] },
      { command: 'pnpm', args: ['--filter', '@paperclipai/server', 'typecheck'] },
      { command: 'pnpm', args: ['check:i18n'] },
    ]);

    const log = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.equal(log.status, 'error');
    assert.equal(log.checks[1].status, 'error');
    assert.equal(log.checks[2].status, 'passed');
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('writeValidationArtifact persists skipped summaries with a stable log path', async () => {
  const sandboxRoot = createSandbox(`validation-skipped-${Date.now()}`);
  const artifactPath = path.join(sandboxRoot, 'reports', 'validation-log.json');

  try {
    const summary = createSkippedValidationSummary('replay-conflict', artifactPath);
    await writeValidationArtifact(artifactPath, summary);

    assert.equal(summary.status, 'not-run');
    assert.equal(summary.reason, 'replay-conflict');
    assert.equal(summary.logPath, artifactPath);
    assert.equal(fs.existsSync(artifactPath), true);

    const log = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.equal(log.status, 'not-run');
    assert.equal(log.reason, 'replay-conflict');
    assert.equal(log.logPath, artifactPath);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
