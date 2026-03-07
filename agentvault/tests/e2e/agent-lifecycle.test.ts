/**
 * E2E Agent Lifecycle Test
 *
 * Covers the full agent lifecycle without requiring network access or real
 * credentials:
 *
 *   init → orchestrate (dry-run) → backup export → backup import/restore
 *
 * All ICP / Anthropic network calls are mocked so the tests run in CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Mocks – must be declared before any dynamic imports
// ---------------------------------------------------------------------------

vi.mock('execa', () => ({
  default: vi.fn().mockResolvedValue({ stdout: 'dfx 0.15.0', stderr: '' }),
  execaCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

vi.mock('@dfinity/agent', () => ({
  HttpAgent: vi.fn().mockImplementation(() => ({
    fetchRootKey: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({}),
  })),
  Actor: {
    createActor: vi.fn().mockReturnValue({
      getState: vi.fn().mockResolvedValue({ ok: { status: 'running', memory: {}, tasks: [] } }),
      getTasks: vi.fn().mockResolvedValue({ ok: [] }),
      getMemory: vi.fn().mockResolvedValue({ ok: {} }),
      getContext: vi.fn().mockResolvedValue({ ok: {} }),
      execute: vi.fn().mockResolvedValue({ ok: new Uint8Array() }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(label: string): string {
  const dir = path.join(os.tmpdir(), `av-e2e-${label}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

/** Write a minimal package.json so orchestrator can locate a project root. */
function writePackageJson(dir: string, name: string): void {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.1.0', scripts: { test: 'exit 0' } })
  );
}

// ---------------------------------------------------------------------------
// Phase 1: Agent initialisation
// ---------------------------------------------------------------------------

describe('Phase 1 – Agent init', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = makeTmpDir('init');
  });

  afterEach(() => removeTmpDir(agentDir));

  it('executeInit creates the .agentvault directory', async () => {
    const { executeInit } = await import('../../cli/commands/init.js');

    await executeInit(
      { name: 'lifecycle-agent', description: 'Lifecycle test', confirm: true },
      { name: 'lifecycle-agent' },
      agentDir
    );

    expect(fs.existsSync(path.join(agentDir, '.agentvault'))).toBe(true);
  });

  it('executeInit writes agent.config.json with correct name', async () => {
    const { executeInit } = await import('../../cli/commands/init.js');

    await executeInit(
      { name: 'lifecycle-agent', description: 'Lifecycle test', confirm: true },
      { name: 'lifecycle-agent' },
      agentDir
    );

    const configPath = path.join(agentDir, '.agentvault', 'config', 'agent.config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { name: string };
    expect(config.name).toBe('lifecycle-agent');
  });

  it('executeInit creates all required subdirectories', async () => {
    const { executeInit } = await import('../../cli/commands/init.js');

    await executeInit(
      { name: 'lifecycle-agent', description: 'Lifecycle test', confirm: true },
      { name: 'lifecycle-agent' },
      agentDir
    );

    const expectedSubdirs = ['agent', 'canister', 'config', 'src'];
    for (const sub of expectedSubdirs) {
      const fullPath = path.join(agentDir, '.agentvault', sub);
      expect(fs.existsSync(fullPath), `expected .agentvault/${sub} to exist`).toBe(true);
    }
  });

  it('executeInit is idempotent – calling twice does not throw', async () => {
    const { executeInit } = await import('../../cli/commands/init.js');

    await executeInit(
      { name: 'lifecycle-agent', description: 'First call', confirm: true },
      { name: 'lifecycle-agent' },
      agentDir
    );

    await expect(
      executeInit(
        { name: 'lifecycle-agent', description: 'Second call', confirm: true },
        { name: 'lifecycle-agent' },
        agentDir
      )
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Orchestration (dry-run, no credentials required)
// ---------------------------------------------------------------------------

describe('Phase 2 – Orchestration (dry-run)', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    projectDir = makeTmpDir('orch');
    writePackageJson(projectDir, 'lifecycle-agent');
  });

  afterEach(() => removeTmpDir(projectDir));

  it('dry-run returns success=true', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const result = await orch.orchestrate({ task: 'Add hello-world', dryRun: true });

    expect(result.success).toBe(true);
  });

  it('dry-run result carries the task description', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);
    const task = 'Implement persistent cache layer';

    const result = await orch.orchestrate({ task, dryRun: true });

    expect(result.taskDescription).toBe(task);
  });

  it('dry-run session ID matches expected pattern', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const result = await orch.orchestrate({ task: 'Session ID test', dryRun: true });

    expect(result.sessionId).toMatch(/^orch_\d+_[0-9a-f]{8}$/);
  });

  it('dry-run writes an audit log that contains outcome=dry_run', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const result = await orch.orchestrate({ task: 'Audit log check', dryRun: true });

    expect(result.auditLogId).toBeDefined();
    expect(fs.existsSync(result.auditLogId!)).toBe(true);

    const log = JSON.parse(fs.readFileSync(result.auditLogId!, 'utf-8')) as Record<string, unknown>;
    expect(log['outcome']).toBe('dry_run');
    expect(log['sessionId']).toBe(result.sessionId);
    expect(log['task']).toBe('Audit log check');
  });

  it('dry-run reports no changed files', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const result = await orch.orchestrate({ task: 'No-change test', dryRun: true });

    expect(result.filesChanged).toHaveLength(0);
  });

  it('dry-run provides a state snapshot before the session', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const result = await orch.orchestrate({ task: 'Snapshot test', dryRun: true });

    expect(result.stateSnapshotBefore).toBeDefined();
    const snapshot = JSON.parse(result.stateSnapshotBefore!) as Record<string, string>;
    expect(typeof snapshot).toBe('object');
    // package.json should appear in the snapshot
    expect(Object.keys(snapshot).some((k) => k.includes('package.json'))).toBe(true);
  });

  it('dry-run with canister ID embeds it in the audit log', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const result = await orch.orchestrate({
      task: 'Canister binding test',
      dryRun: true,
      canisterId: 'test-canister-id-001',
    });

    expect(result.success).toBe(true);
    const log = JSON.parse(fs.readFileSync(result.auditLogId!, 'utf-8')) as Record<string, unknown>;
    expect(log['canisterId']).toBe('test-canister-id-001');
  });

  it('dry-run with reviewers list is reflected in the audit log', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const reviewers = ['alice', 'bob', 'carol'];
    const result = await orch.orchestrate({
      task: 'Multi-sig reviewer test',
      dryRun: true,
      reviewers,
    });

    expect(result.success).toBe(true);
    const log = JSON.parse(fs.readFileSync(result.auditLogId!, 'utf-8')) as Record<string, unknown>;
    expect(log['reviewers']).toEqual(reviewers);
  });

  it('dry-run picks up project conventions', async () => {
    const conventionsDir = path.join(projectDir, '.agentvault', 'conventions');
    fs.mkdirSync(conventionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(conventionsDir, 'Claude.md'),
      '# Conventions\n\nAlways write tests.'
    );

    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const messages: string[] = [];
    const result = await orch.orchestrate({
      task: 'Conventions loading test',
      dryRun: true,
      onProgress: (m) => messages.push(m),
    });

    expect(result.success).toBe(true);
    expect(messages.some((m) => m.includes('conventions'))).toBe(true);
  });

  it('dry-run invokes onProgress callback at least once', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const messages: string[] = [];
    await orch.orchestrate({
      task: 'Progress callback test',
      dryRun: true,
      onProgress: (m) => messages.push(m),
    });

    expect(messages.length).toBeGreaterThan(0);
  });

  it('dry-run durationMs is a non-negative number', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(projectDir);

    const result = await orch.orchestrate({ task: 'Duration test', dryRun: true });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('multiple concurrent dry-run sessions produce unique session IDs', async () => {
    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');

    const dirs = [makeTmpDir('orch-a'), makeTmpDir('orch-b'), makeTmpDir('orch-c')];
    try {
      for (const d of dirs) writePackageJson(d, 'agent');

      const results = await Promise.all(
        dirs.map((d) =>
          new ClaudeOrchestrator(d).orchestrate({ task: 'Concurrent test', dryRun: true })
        )
      );

      const sessionIds = results.map((r) => r.sessionId);
      const unique = new Set(sessionIds);
      expect(unique.size).toBe(dirs.length);
    } finally {
      dirs.forEach(removeTmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Backup export
// ---------------------------------------------------------------------------

describe('Phase 3 – Backup export', () => {
  let backupOutputDir: string;

  beforeEach(() => {
    backupOutputDir = makeTmpDir('backup-out');
  });

  afterEach(() => removeTmpDir(backupOutputDir));

  it('exportBackup returns success=true and writes a JSON file', async () => {
    const { exportBackup } = await import('../../src/backup/backup.js');

    const outputPath = path.join(backupOutputDir, 'my-agent.json');
    const result = await exportBackup({
      agentName: 'my-agent',
      outputPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('exported backup is valid JSON with a manifest', async () => {
    const { exportBackup } = await import('../../src/backup/backup.js');

    const outputPath = path.join(backupOutputDir, 'manifest-check.json');
    await exportBackup({
      agentName: 'manifest-agent',
      outputPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    const raw = fs.readFileSync(outputPath, 'utf-8');
    const manifest = JSON.parse(raw) as { version: string; agentName: string; components: string[] };

    expect(manifest.version).toBeDefined();
    expect(manifest.agentName).toBe('manifest-agent');
    expect(Array.isArray(manifest.components)).toBe(true);
  });

  it('exportBackup includes config component when includeConfig=true', async () => {
    const { exportBackup } = await import('../../src/backup/backup.js');

    const outputPath = path.join(backupOutputDir, 'config-check.json');
    const result = await exportBackup({
      agentName: 'config-agent',
      outputPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    expect(result.manifest?.components).toContain('config');
  });

  it('exportBackup omits config component when includeConfig=false', async () => {
    const { exportBackup } = await import('../../src/backup/backup.js');

    const outputPath = path.join(backupOutputDir, 'no-config.json');
    const result = await exportBackup({
      agentName: 'no-config-agent',
      outputPath,
      includeConfig: false,
      includeCanisterState: false,
    });

    expect(result.manifest?.components).not.toContain('config');
  });

  it('exportBackup returns sizeBytes greater than zero', async () => {
    const { exportBackup } = await import('../../src/backup/backup.js');

    const outputPath = path.join(backupOutputDir, 'size-check.json');
    const result = await exportBackup({
      agentName: 'size-agent',
      outputPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('previewBackup reads the manifest without importing', async () => {
    const { exportBackup, previewBackup } = await import('../../src/backup/backup.js');

    const outputPath = path.join(backupOutputDir, 'preview.json');
    await exportBackup({
      agentName: 'preview-agent',
      outputPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    const manifest = await previewBackup(outputPath);
    expect(manifest).not.toBeNull();
    expect(manifest?.agentName).toBe('preview-agent');
  });

  it('previewBackup returns null for a non-existent file', async () => {
    const { previewBackup } = await import('../../src/backup/backup.js');

    const result = await previewBackup('/tmp/does-not-exist-ever.json');
    expect(result).toBeNull();
  });

  it('formatBackupSize returns human-readable strings', async () => {
    const { formatBackupSize } = await import('../../src/backup/backup.js');

    expect(formatBackupSize(512)).toMatch(/B/);
    expect(formatBackupSize(2048)).toMatch(/KB/);
    expect(formatBackupSize(1024 * 1024 * 3)).toMatch(/MB/);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Backup import / restore
// ---------------------------------------------------------------------------

describe('Phase 4 – Backup import / restore', () => {
  let backupDir: string;

  beforeEach(() => {
    backupDir = makeTmpDir('restore');
  });

  afterEach(() => removeTmpDir(backupDir));

  it('importBackup returns success=true for a valid backup file', async () => {
    const { exportBackup, importBackup } = await import('../../src/backup/backup.js');

    const backupPath = path.join(backupDir, 'restore-test.json');
    await exportBackup({
      agentName: 'restore-agent',
      outputPath: backupPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    const result = await importBackup({ inputPath: backupPath });

    expect(result.success).toBe(true);
  });

  it('importBackup reports the agent name from the manifest', async () => {
    const { exportBackup, importBackup } = await import('../../src/backup/backup.js');

    const backupPath = path.join(backupDir, 'named-restore.json');
    await exportBackup({
      agentName: 'named-agent',
      outputPath: backupPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    const result = await importBackup({ inputPath: backupPath });

    expect(result.agentName).toBe('named-agent');
  });

  it('importBackup allows overriding the target agent name', async () => {
    const { exportBackup, importBackup } = await import('../../src/backup/backup.js');

    const backupPath = path.join(backupDir, 'renamed.json');
    await exportBackup({
      agentName: 'original-agent',
      outputPath: backupPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    const result = await importBackup({
      inputPath: backupPath,
      targetAgentName: 'cloned-agent',
    });

    expect(result.success).toBe(true);
    expect(result.agentName).toBe('cloned-agent');
  });

  it('importBackup returns success=false for a missing file', async () => {
    const { importBackup } = await import('../../src/backup/backup.js');

    const result = await importBackup({ inputPath: '/tmp/does-not-exist-ever.json' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('importBackup (dry-run) restores listed components without overwrite', async () => {
    const { exportBackup, importBackup } = await import('../../src/backup/backup.js');

    const backupPath = path.join(backupDir, 'dry-import.json');
    await exportBackup({
      agentName: 'dry-import-agent',
      outputPath: backupPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    const result = await importBackup({ inputPath: backupPath, overwrite: false });

    expect(result.success).toBe(true);
    expect(result.components).toContain('config');
    // dry-run warning should be present
    expect(result.warnings.some((w) => w.toLowerCase().includes('dry'))).toBe(true);
  });

  it('deleteBackup removes the file from disk', async () => {
    const { exportBackup, deleteBackup } = await import('../../src/backup/backup.js');

    const backupPath = path.join(backupDir, 'to-delete.json');
    await exportBackup({
      agentName: 'delete-me',
      outputPath: backupPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    expect(fs.existsSync(backupPath)).toBe(true);

    const deleted = await deleteBackup(backupPath);

    expect(deleted).toBe(true);
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it('deleteBackup returns false for a non-existent file', async () => {
    const { deleteBackup } = await import('../../src/backup/backup.js');

    const deleted = await deleteBackup('/tmp/nonexistent-av-backup.json');

    expect(deleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: Full lifecycle  init → orchestrate → backup → restore
// ---------------------------------------------------------------------------

describe('Phase 5 – Full lifecycle: init → orchestrate → backup → restore', () => {
  let workspaceDir: string;
  let backupOutputDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceDir = makeTmpDir('lifecycle-full');
    backupOutputDir = makeTmpDir('lifecycle-backups');
  });

  afterEach(() => {
    removeTmpDir(workspaceDir);
    removeTmpDir(backupOutputDir);
  });

  it('complete pipeline succeeds end-to-end', async () => {
    // ── Step 1: Init ──────────────────────────────────────────────────────
    const { executeInit } = await import('../../cli/commands/init.js');

    await executeInit(
      { name: 'e2e-agent', description: 'Full lifecycle agent', confirm: true },
      { name: 'e2e-agent' },
      workspaceDir
    );

    const configPath = path.join(workspaceDir, '.agentvault', 'config', 'agent.config.json');
    expect(fs.existsSync(configPath)).toBe(true);

    // ── Step 2: Orchestrate (dry-run) ─────────────────────────────────────
    writePackageJson(workspaceDir, 'e2e-agent');

    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(workspaceDir);

    const orchResult = await orch.orchestrate({
      task: 'Add a comprehensive README',
      dryRun: true,
    });

    expect(orchResult.success).toBe(true);
    expect(orchResult.auditLogId).toBeDefined();
    expect(fs.existsSync(orchResult.auditLogId!)).toBe(true);

    // ── Step 3: Backup export ─────────────────────────────────────────────
    const { exportBackup } = await import('../../src/backup/backup.js');

    const backupPath = path.join(backupOutputDir, 'e2e-agent.json');
    const backupResult = await exportBackup({
      agentName: 'e2e-agent',
      outputPath: backupPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    expect(backupResult.success).toBe(true);
    expect(fs.existsSync(backupPath)).toBe(true);

    // ── Step 4: Restore ───────────────────────────────────────────────────
    const { importBackup } = await import('../../src/backup/backup.js');

    const restoreResult = await importBackup({
      inputPath: backupPath,
      overwrite: true,
    });

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.agentName).toBe('e2e-agent');
    expect(restoreResult.components).toContain('config');
  });

  it('orchestration audit log can be read after backup/restore cycle', async () => {
    writePackageJson(workspaceDir, 'audit-persist-agent');

    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(workspaceDir);

    const orchResult = await orch.orchestrate({
      task: 'Audit persistence check',
      dryRun: true,
      canisterId: 'audit-canister-001',
    });

    // Backup should capture the workspace that now has an audit log
    const { exportBackup } = await import('../../src/backup/backup.js');

    const backupPath = path.join(backupOutputDir, 'audit-persist.json');
    const backupResult = await exportBackup({
      agentName: 'audit-persist-agent',
      outputPath: backupPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    expect(backupResult.success).toBe(true);

    // The original audit log written by the orchestrator must still be readable
    const auditData = JSON.parse(
      fs.readFileSync(orchResult.auditLogId!, 'utf-8')
    ) as Record<string, unknown>;

    expect(auditData['task']).toBe('Audit persistence check');
    expect(auditData['canisterId']).toBe('audit-canister-001');
    expect(auditData['outcome']).toBe('dry_run');
  });

  it('restore to a different agent name succeeds', async () => {
    const { executeInit } = await import('../../cli/commands/init.js');

    await executeInit(
      { name: 'source-agent', description: 'Source agent', confirm: true },
      { name: 'source-agent' },
      workspaceDir
    );

    const { exportBackup } = await import('../../src/backup/backup.js');
    const backupPath = path.join(backupOutputDir, 'source-agent.json');
    await exportBackup({
      agentName: 'source-agent',
      outputPath: backupPath,
      includeConfig: true,
      includeCanisterState: false,
    });

    const { importBackup } = await import('../../src/backup/backup.js');
    const result = await importBackup({
      inputPath: backupPath,
      targetAgentName: 'cloned-from-source',
      overwrite: true,
    });

    expect(result.success).toBe(true);
    expect(result.agentName).toBe('cloned-from-source');
  });

  it('repeated orchestrate-backup cycles produce unique session IDs', async () => {
    writePackageJson(workspaceDir, 'repeat-agent');

    const { ClaudeOrchestrator } = await import('../../src/orchestration/claude.js');
    const orch = new ClaudeOrchestrator(workspaceDir);
    const { exportBackup } = await import('../../src/backup/backup.js');

    const sessionIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const orchResult = await orch.orchestrate({
        task: `Iteration ${i} task`,
        dryRun: true,
      });
      expect(orchResult.success).toBe(true);
      sessionIds.push(orchResult.sessionId);

      const backupPath = path.join(backupOutputDir, `repeat-agent-${i}.json`);
      const backupResult = await exportBackup({
        agentName: 'repeat-agent',
        outputPath: backupPath,
        includeConfig: true,
        includeCanisterState: false,
      });
      expect(backupResult.success).toBe(true);
    }

    const unique = new Set(sessionIds);
    expect(unique.size).toBe(3);
  });
});
