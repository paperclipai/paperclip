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

test('parseSyncConfig falls back from blank config values', () => {
  const config = parseSyncConfig(
    {
      GITHUB_REPOSITORY: ' paperclip/paperclip ',
      BASE_BRANCH: '',
      UPSTREAM_REMOTE: '   ',
      UPSTREAM_REF: '',
      MAINTENANCE_REF: ' ',
      BRANCH_PREFIX: '\t',
      LLM_API_BASE: ' ',
      LLM_API_KEY: '',
      LLM_MODEL: '   ',
    },
    [],
  );

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

test('parseSyncConfig infers repository metadata from git remote when missing', () => {
  const config = parseSyncConfig({}, [], {
    readRepositoryFromGitRemote: () => 'paperclip/paperclip',
  });

  assert.equal(config.githubRepository, 'paperclip/paperclip');
});
