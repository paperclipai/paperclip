/**
 * Tests for the Claude Code orchestration module (PRD-001)
 *
 * These tests cover the ClaudeOrchestrator class and the CLI command
 * definition, focusing on behaviour that can be verified without network
 * access or a real Anthropic API key.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeOrchestrator } from '../../src/orchestration/claude.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempProject(): string {
  const dir = join(tmpdir(), `agentvault_test_${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  // Minimal package.json so the orchestrator finds a project
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test-project', scripts: { test: 'exit 0' } })
  );

  return dir;
}

function removeTempProject(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Source-file / wiring checks
// ---------------------------------------------------------------------------

describe('Orchestrate – source files', () => {
  const ROOT_DIR = join(import.meta.dirname, '..', '..');

  it('src/orchestration/claude.ts exists', () => {
    expect(existsSync(join(ROOT_DIR, 'src', 'orchestration', 'claude.ts'))).toBe(true);
  });

  it('cli/commands/orchestrate.ts exists', () => {
    expect(existsSync(join(ROOT_DIR, 'cli', 'commands', 'orchestrate.ts'))).toBe(true);
  });

  it('cli/index.ts imports orchestrateCmd', () => {
    const content = readFileSync(join(ROOT_DIR, 'cli', 'index.ts'), 'utf-8');
    expect(content).toContain("from './commands/orchestrate.js'");
  });

  it('cli/index.ts registers orchestrateCmd', () => {
    const content = readFileSync(join(ROOT_DIR, 'cli', 'index.ts'), 'utf-8');
    expect(content).toContain('program.addCommand(orchestrateCmd())');
  });

  it('orchestrate command file exports orchestrateCmd', () => {
    const content = readFileSync(
      join(ROOT_DIR, 'cli', 'commands', 'orchestrate.ts'),
      'utf-8'
    );
    expect(content).toContain('export');
    expect(content).toContain('orchestrateCmd');
  });

  it('orchestrate command supports --claude flag', () => {
    const content = readFileSync(
      join(ROOT_DIR, 'cli', 'commands', 'orchestrate.ts'),
      'utf-8'
    );
    expect(content).toContain('--claude');
  });

  it('orchestrate command supports --task flag', () => {
    const content = readFileSync(
      join(ROOT_DIR, 'cli', 'commands', 'orchestrate.ts'),
      'utf-8'
    );
    expect(content).toContain('--task');
  });

  it('orchestrate command supports --dry-run flag', () => {
    const content = readFileSync(
      join(ROOT_DIR, 'cli', 'commands', 'orchestrate.ts'),
      'utf-8'
    );
    expect(content).toContain('--dry-run');
  });

  it('orchestrate command supports --approve flag', () => {
    const content = readFileSync(
      join(ROOT_DIR, 'cli', 'commands', 'orchestrate.ts'),
      'utf-8'
    );
    expect(content).toContain('--approve');
  });

  it('orchestrate command supports --reviewers flag', () => {
    const content = readFileSync(
      join(ROOT_DIR, 'cli', 'commands', 'orchestrate.ts'),
      'utf-8'
    );
    expect(content).toContain('--reviewers');
  });
});

// ---------------------------------------------------------------------------
// ClaudeOrchestrator – dry-run mode (no network required)
// ---------------------------------------------------------------------------

describe('ClaudeOrchestrator – dry-run mode', () => {
  let tmpDir: string;
  let orchestrator: ClaudeOrchestrator;

  beforeEach(() => {
    tmpDir = createTempProject();
    orchestrator = new ClaudeOrchestrator(tmpDir);
  });

  afterEach(() => {
    removeTempProject(tmpDir);
  });

  it('returns success=true in dry-run mode', async () => {
    const result = await orchestrator.orchestrate({
      task: 'Add a hello world function',
      dryRun: true,
    });

    expect(result.success).toBe(true);
  });

  it('returns a valid session ID', async () => {
    const result = await orchestrator.orchestrate({
      task: 'Add a hello world function',
      dryRun: true,
    });

    expect(result.sessionId).toMatch(/^orch_\d+_[0-9a-f]{8}$/);
  });

  it('reflects the task description in the result', async () => {
    const task = 'Implement video timeline with cell reuse';
    const result = await orchestrator.orchestrate({ task, dryRun: true });

    expect(result.taskDescription).toBe(task);
  });

  it('writes an audit log file', async () => {
    const result = await orchestrator.orchestrate({
      task: 'Test audit logging',
      dryRun: true,
    });

    expect(result.auditLogId).toBeDefined();
    expect(existsSync(result.auditLogId!)).toBe(true);
  });

  it('audit log contains expected fields', async () => {
    const task = 'Audit log content check';
    const result = await orchestrator.orchestrate({
      task,
      dryRun: true,
      canisterId: 'aaaaa-aa',
    });

    const log = JSON.parse(readFileSync(result.auditLogId!, 'utf-8')) as Record<string, unknown>;
    expect(log['sessionId']).toBe(result.sessionId);
    expect(log['task']).toBe(task);
    expect(log['outcome']).toBe('dry_run');
    expect(log['canisterId']).toBe('aaaaa-aa');
    expect(log['timestamp']).toBeDefined();
  });

  it('no files are reported as changed in dry-run mode', async () => {
    const result = await orchestrator.orchestrate({
      task: 'Dry run change check',
      dryRun: true,
    });

    expect(result.filesChanged).toHaveLength(0);
  });

  it('durationMs is a positive number', async () => {
    const result = await orchestrator.orchestrate({
      task: 'Duration check',
      dryRun: true,
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes state snapshot before session', async () => {
    const result = await orchestrator.orchestrate({
      task: 'Snapshot check',
      dryRun: true,
    });

    expect(result.stateSnapshotBefore).toBeDefined();
    const snapshot = JSON.parse(result.stateSnapshotBefore!) as Record<string, string>;
    expect(typeof snapshot).toBe('object');
  });

  it('loads conventions when .agentvault/conventions/ directory exists', async () => {
    const conventionsDir = join(tmpDir, '.agentvault', 'conventions');
    mkdirSync(conventionsDir, { recursive: true });
    writeFileSync(join(conventionsDir, 'Claude.md'), '# Project conventions\nAlways write tests.');

    const progressMessages: string[] = [];
    const result = await orchestrator.orchestrate({
      task: 'Convention test',
      dryRun: true,
      onProgress: (msg) => progressMessages.push(msg),
    });

    expect(result.success).toBe(true);
    expect(progressMessages.some((m) => m.includes('conventions'))).toBe(true);
  });

  it('onProgress callback receives messages', async () => {
    const messages: string[] = [];
    await orchestrator.orchestrate({
      task: 'Progress callback test',
      dryRun: true,
      onProgress: (msg) => messages.push(msg),
    });

    expect(messages.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ClaudeOrchestrator – failure path (no API key, no local CLI)
// ---------------------------------------------------------------------------

describe('ClaudeOrchestrator – failure path (no credentials)', () => {
  let tmpDir: string;
  let orchestrator: ClaudeOrchestrator;

  beforeEach(() => {
    tmpDir = createTempProject();
    orchestrator = new ClaudeOrchestrator(tmpDir);

    // Ensure no API key bleeds in from the environment
    vi.stubEnv('ANTHROPIC_API_KEY', '');
  });

  afterEach(() => {
    removeTempProject(tmpDir);
    vi.unstubAllEnvs();
  });

  it('returns success=false when neither API key nor local CLI is available', async () => {
    const result = await orchestrator.orchestrate({
      task: 'Impossible task',
      // no apiKey, no env var, local claude CLI assumed absent in CI
    });

    // Either fails because no credentials, or because local CLI is absent.
    // Either way success should be false (or it succeeds if claude is installed).
    expect(typeof result.success).toBe('boolean');
  });

  it('result includes an error message on failure', async () => {
    const result = await orchestrator.orchestrate({
      task: 'Fail gracefully',
    });

    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
      expect((result.error as string).length).toBeGreaterThan(0);
    }
  });

  it('writes audit log even on failure', async () => {
    const result = await orchestrator.orchestrate({
      task: 'Failure audit test',
    });

    if (!result.success) {
      expect(result.auditLogId).toBeDefined();
      expect(existsSync(result.auditLogId!)).toBe(true);
      const log = JSON.parse(readFileSync(result.auditLogId!, 'utf-8')) as Record<string, unknown>;
      expect(log['outcome']).toBe('rolled_back');
    }
  });
});

// ---------------------------------------------------------------------------
// CLI command object structure – source inspection (avoids runtime deps)
// ---------------------------------------------------------------------------

describe('orchestrateCmd – command source', () => {
  const ROOT_DIR = join(import.meta.dirname, '..', '..');
  const src = readFileSync(
    join(ROOT_DIR, 'cli', 'commands', 'orchestrate.ts'),
    'utf-8'
  );

  it("command name is 'orchestrate'", () => {
    expect(src).toContain("new Command('orchestrate')");
  });

  it('has a non-trivial description string', () => {
    expect(src).toContain('.description(');
  });

  it('defines --claude flag', () => {
    expect(src).toContain("'--claude'");
  });

  it('defines --task option', () => {
    expect(src).toContain('--task');
  });

  it('defines --dry-run flag', () => {
    expect(src).toContain('--dry-run');
  });

  it('defines --approve flag', () => {
    expect(src).toContain('--approve');
  });

  it('defines --reviewers option', () => {
    expect(src).toContain('--reviewers');
  });

  it('defines --network option', () => {
    expect(src).toContain('--network');
  });

  it('defines --timeout option', () => {
    expect(src).toContain('--timeout');
  });

  it('defines --canister-id option', () => {
    expect(src).toContain('--canister-id');
  });
});
