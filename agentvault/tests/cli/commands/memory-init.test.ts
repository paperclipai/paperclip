import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeInit } from '../../../cli/commands/init.js';
import type { InitAnswers, InitOptions } from '../../../cli/commands/init.js';

describe('Init Command — Soul.md Detection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const defaultAnswers: InitAnswers = {
    name: 'test-agent',
    description: 'Test agent',
    confirm: true,
  };

  const defaultOptions: InitOptions = { yes: true };

  it('should detect soul.md and create memory-repo.config.json', async () => {
    // Create a soul.md in the working directory
    fs.writeFileSync(path.join(tmpDir, 'soul.md'), '# Test Soul\n\nIdentity content', 'utf-8');

    await executeInit(defaultAnswers, defaultOptions, tmpDir);

    const configPath = path.join(tmpDir, '.agentvault', 'memory-repo.config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.soulDetected).toBe(true);
    expect(config.soulFile).toBe('soul.md');
    expect(config.detectedAt).toBeGreaterThan(0);
  });

  it('should not create memory-repo.config.json when no soul.md exists', async () => {
    await executeInit(defaultAnswers, defaultOptions, tmpDir);

    const configPath = path.join(tmpDir, '.agentvault', 'memory-repo.config.json');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('should still create standard project structure when soul.md exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'soul.md'), '# Soul', 'utf-8');

    await executeInit(defaultAnswers, defaultOptions, tmpDir);

    const projectDir = path.join(tmpDir, '.agentvault');
    expect(fs.existsSync(path.join(projectDir, 'config', 'agent.config.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.gitignore'))).toBe(true);
  });

  it('should create standard project structure without soul.md', async () => {
    await executeInit(defaultAnswers, defaultOptions, tmpDir);

    const projectDir = path.join(tmpDir, '.agentvault');
    expect(fs.existsSync(path.join(projectDir, 'config', 'agent.config.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'agent'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'canister'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'src'))).toBe(true);
  });
});
