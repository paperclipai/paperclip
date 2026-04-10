import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSyncConfig } from './config.mjs';

test('parseSyncConfig applies defaults', () => {
  const config = parseSyncConfig({ GITHUB_REPOSITORY: 'paperclip/paperclip' }, []);

  assert.deepEqual(config, {
    baseBranch: 'zh-enterprise',
    upstreamRemote: 'upstream',
    upstreamRef: 'upstream/master',
    maintenanceRef: 'origin/zh-enterprise',
    branchPrefix: 'bot-upgrade',
    dryRun: false,
    llmApiBase: undefined,
    llmApiKey: undefined,
    llmModel: undefined,
    githubRepository: 'paperclip/paperclip',
  });
});

test('parseSyncConfig parses dry-run flag', () => {
  const config = parseSyncConfig({ GITHUB_REPOSITORY: 'paperclip/paperclip' }, ['--dry-run']);

  assert.equal(config.dryRun, true);
});

test('parseSyncConfig requires repository metadata', () => {
  assert.throws(() => parseSyncConfig({}, []), /GITHUB_REPOSITORY/);
});
