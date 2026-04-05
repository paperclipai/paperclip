
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHermesConfig, parseEnvText } from '../src/ui/build-config.js';

test('parseEnvText parses KEY=value lines', () => {
  assert.deepEqual(parseEnvText('FOO=bar\n# comment\nBAZ=qux'), { FOO: 'bar', BAZ: 'qux' });
});

test('buildHermesConfig maps documented fields', () => {
  const config = buildHermesConfig({
    model: 'gpt-5.4',
    provider: 'copilot',
    cwd: '/work',
    hermesHome: '/profiles/litellm',
    instructionsFilePath: '/work/AGENT.md',
    promptTemplate: 'hello',
    bootstrapPrompt: 'boot',
    command: 'hermes_maximus',
    toolsets: 'web,terminal',
    timeoutSec: 100,
    graceSec: 7,
    maxTurnsPerRun: 15,
    persistSession: true,
    worktreeMode: true,
    checkpoints: true,
    dangerouslySkipPermissions: false,
    extraArgs: '--foo bar',
    envVars: 'FOO=bar',
  });
  assert.equal(config.hermesCommand, 'hermes_maximus');
  assert.equal(config.command, 'hermes_maximus');
  assert.equal(config.toolsets, 'web,terminal');
  assert.equal(config.env.HERMES_HOME, '/profiles/litellm');
  assert.equal(config.instructionsFilePath, '/work/AGENT.md');
  assert.deepEqual(config.extraArgs, ['--foo', 'bar']);
  assert.deepEqual(config.env, { HERMES_HOME: '/profiles/litellm', FOO: 'bar' });
  assert.equal(config.maxTurnsPerRun, 15);
  assert.equal(config.dangerouslySkipPermissions, false);
});
