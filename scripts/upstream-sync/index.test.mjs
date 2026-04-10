import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main, resolveExitCode } from './index.mjs';

test('main prints workflow-consumable validation outputs', async () => {
  let output = '';

  const result = await main([], {}, {
    runUpstreamSync: async () => ({
      branchName: 'bot-upgrade/abc123def456',
      reportPath: 'reports/upstream-sync-report.json',
      prBodyPath: 'reports/upstream-sync-pr-body.md',
      status: 'replayed',
      validationStatus: 'passed',
      readyForPr: true,
      validationLogPath: 'reports/upstream-sync-validation-log.json',
    }),
    parseSyncConfig: () => ({ dryRun: false }),
    stdout: {
      write(chunk) {
        output += chunk;
      },
    },
  });

  assert.equal(result.readyForPr, true);
  assert.match(output, /^branch_name=bot-upgrade\/abc123def456$/m);
  assert.match(output, /^report_path=reports\/upstream-sync-report\.json$/m);
  assert.match(output, /^pr_body_path=reports\/upstream-sync-pr-body\.md$/m);
  assert.match(output, /^status=replayed$/m);
  assert.match(output, /^validation_status=passed$/m);
  assert.match(output, /^ready_for_pr=true$/m);
  assert.match(output, /^validation_log_path=reports\/upstream-sync-validation-log\.json$/m);
});

test('main prints workflow-consumable outputs for error results', async () => {
  let output = '';

  const result = await main([], {}, {
    runUpstreamSync: async () => ({
      branchName: '',
      reportPath: 'reports/upstream-sync-report.json',
      prBodyPath: 'reports/upstream-sync-pr-body.md',
      status: 'error',
      validationStatus: 'not-run',
      readyForPr: false,
      validationLogPath: 'reports/upstream-sync-validation-log.json',
      error: {
        stage: 'scan-localization',
        message: 'localization scan failed',
      },
    }),
    parseSyncConfig: () => ({ dryRun: false }),
    stdout: {
      write(chunk) {
        output += chunk;
      },
    },
  });

  assert.equal(result.status, 'error');
  assert.match(output, /^branch_name=$/m);
  assert.match(output, /^report_path=reports\/upstream-sync-report\.json$/m);
  assert.match(output, /^pr_body_path=reports\/upstream-sync-pr-body\.md$/m);
  assert.match(output, /^status=error$/m);
  assert.match(output, /^validation_status=not-run$/m);
  assert.match(output, /^ready_for_pr=false$/m);
  assert.match(output, /^validation_log_path=reports\/upstream-sync-validation-log\.json$/m);
});

test('main mirrors outputs into GITHUB_OUTPUT when configured', async () => {
  let output = '';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-sync-index-'));
  const githubOutputPath = path.join(tempDir, 'github-output.txt');

  try {
    await main([], { GITHUB_OUTPUT: githubOutputPath }, {
      runUpstreamSync: async () => ({
        branchName: 'bot-upgrade/abc123def456',
        reportPath: 'reports/upstream-sync-report.json',
        prBodyPath: 'reports/upstream-sync-pr-body.md',
        status: 'replayed',
        validationStatus: 'passed',
        readyForPr: true,
        validationLogPath: 'reports/upstream-sync-validation-log.json',
      }),
      parseSyncConfig: () => ({ dryRun: false }),
      stdout: {
        write(chunk) {
          output += chunk;
        },
      },
    });

    const githubOutput = fs.readFileSync(githubOutputPath, 'utf8');
    assert.equal(githubOutput, output);
    assert.match(githubOutput, /^branch_name=bot-upgrade\/abc123def456$/m);
    assert.match(githubOutput, /^ready_for_pr=true$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveExitCode returns non-zero for error results', () => {
  assert.equal(resolveExitCode({ status: 'error' }), 1);
  assert.equal(resolveExitCode({ status: 'replayed' }), 0);
  assert.equal(resolveExitCode({ status: 'conflict', validationStatus: 'not-run' }), 1);
  assert.equal(resolveExitCode({ status: 'replayed', validationStatus: 'failed' }), 1);
  assert.equal(resolveExitCode({ status: 'replayed', validationStatus: 'error' }), 1);
});
