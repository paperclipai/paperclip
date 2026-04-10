import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runUpstreamSync } from './orchestrator.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function createSandbox(name) {
  const sandboxRoot = path.join(repoRoot, 'scripts', 'upstream-sync', '.test-artifacts');
  const sandbox = path.join(sandboxRoot, name);
  fs.mkdirSync(sandbox, { recursive: true });
  return { sandboxRoot, sandbox };
}

test('runUpstreamSync writes bootstrap artifacts and marks the status as not ready', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`bootstrap-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'upstream/master',
        maintenanceRef: 'origin/zh-enterprise',
        branchPrefix: 'bot-upgrade',
        dryRun: false,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
    });

    assert.equal(result.status, 'bootstrap-not-ready');
    assert.equal(result.branchName, 'bot-upgrade/sync');
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
    assert.match(fs.readFileSync(path.join(sandbox, result.reportPath), 'utf8'), /bootstrap artifact/);
    assert.match(fs.readFileSync(path.join(sandbox, result.prBodyPath), 'utf8'), /bootstrap placeholder/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runUpstreamSync uses a distinct bootstrap status in dry-run mode', async () => {
  const { sandboxRoot, sandbox } = createSandbox(`dry-run-${Date.now()}`);
  const previousCwd = process.cwd();
  process.chdir(sandbox);

  try {
    const result = await runUpstreamSync({
      config: {
        githubRepository: 'paperclip/paperclip',
        baseBranch: 'zh-enterprise',
        upstreamRemote: 'upstream',
        upstreamRef: 'upstream/master',
        maintenanceRef: 'origin/zh-enterprise',
        branchPrefix: 'bot-upgrade',
        dryRun: true,
        llmApiBase: undefined,
        llmApiKey: undefined,
        llmModel: undefined,
      },
    });

    assert.equal(result.status, 'bootstrap-dry-run');
    assert.equal(fs.existsSync(path.join(sandbox, result.reportPath)), true);
    assert.equal(fs.existsSync(path.join(sandbox, result.prBodyPath)), true);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
