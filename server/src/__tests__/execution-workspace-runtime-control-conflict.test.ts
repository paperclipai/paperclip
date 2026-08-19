import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  assertRuntimeControlAvailable: vi.fn(),
  createRecorder: vi.fn(),
  reconcileStaleRuntimeControlOperations: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({ normalizeEnvBindingsForPersistence: vi.fn() }));
const mockProjectService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAssertCanManageExecutionWorkspaceRuntimeServices = vi.hoisted(() => vi.fn());
const mockAssertCanManageProjectWorkspaceRuntimeServices = vi.hoisted(() => vi.fn());
const mockStartRuntimeServices = vi.hoisted(() => vi.fn());
const mockStopRuntimeServicesForExecutionWorkspace = vi.hoisted(() => vi.fn());
const mockEnsurePersistedExecutionWorkspaceAvailable = vi.hoisted(() => vi.fn());
const mockBuildWorkspaceRuntimeDesiredStatePatch = vi.hoisted(() => vi.fn());
const mockListConfiguredRuntimeServiceEntries = vi.hoisted(() => vi.fn());
// The integrated control path also takes the durable runtime-control lease (PAP-17205). This
// suite covers the in-flight guard and failed-start reconciliation, so the lease always grants;
// `execution-workspace-runtime-lease-route.test.ts` exercises the lease itself against a real db.
const mockClaimRuntimeLease = vi.hoisted(() => vi.fn(async () => null));
const mockReleaseRuntimeLease = vi.hoisted(() => vi.fn(async () => undefined));
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: mockSpawn,
}));

vi.mock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => mockEnvironmentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
  workspaceRuntimeLeaseService: () => ({
    claim: mockClaimRuntimeLease,
    release: mockReleaseRuntimeLease,
  }),
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart", "repair"],
}));

vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: mockBuildWorkspaceRuntimeDesiredStatePatch,
  cleanupExecutionWorkspaceArtifacts: vi.fn(),
  ensurePersistedExecutionWorkspaceAvailable: mockEnsurePersistedExecutionWorkspaceAvailable,
  listConfiguredRuntimeServiceEntries: mockListConfiguredRuntimeServiceEntries,
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: mockStartRuntimeServices,
  stopRuntimeServicesForExecutionWorkspace: mockStopRuntimeServicesForExecutionWorkspace,
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

vi.mock("../routes/workspace-runtime-service-authz.js", () => ({
  assertCanManageExecutionWorkspaceRuntimeServices: mockAssertCanManageExecutionWorkspaceRuntimeServices,
  assertCanManageProjectWorkspaceRuntimeServices: mockAssertCanManageProjectWorkspaceRuntimeServices,
}));

const executionWorkspaceId = "33333333-3333-4333-8333-333333333333";

function buildExecutionWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: executionWorkspaceId,
    companyId: "company-1",
    // Left unset so the handler does not need a real `db` for project/policy lookups; the
    // runtime config below is what the control path actually reads.
    projectId: null,
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Lane A",
    status: "active",
    cwd: "/tmp/lane-a",
    repoUrl: null,
    baseRef: "main",
    branchName: "canary/lane-a",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: {
      workspaceRuntime: {
        services: [{ name: "app", command: "pnpm dev", port: { type: "fixed", value: 42003 } }],
      },
      desiredState: "running",
    },
    metadata: null,
    runtimeServices: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function createApp() {
  const [{ executionWorkspaceRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/execution-workspaces.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

/**
 * Route-level guarantees for PAP-17249: the competing lane in the PAP-17207 report must get a
 * stable 409 while a control is genuinely live, and a start that fails must leave the workspace
 * stopped and retryable instead of "desired running" with residue.
 */
describe.sequential("execution workspace runtime control conflict and failure reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "runtime:manage",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace());
    mockExecutionWorkspaceService.update.mockResolvedValue(buildExecutionWorkspace());
    mockAssertCanManageExecutionWorkspaceRuntimeServices.mockResolvedValue(undefined);
    mockWorkspaceOperationService.assertRuntimeControlAvailable.mockResolvedValue(undefined);
    mockBuildWorkspaceRuntimeDesiredStatePatch.mockReturnValue({
      desiredState: "stopped",
      serviceStates: { app: "stopped" },
    });
    mockEnsurePersistedExecutionWorkspaceAvailable.mockResolvedValue({
      cwd: "/tmp/lane-a",
      projectId: "project-1",
      workspaceId: null,
      branchName: "canary/lane-a",
      worktreePath: "/tmp/lane-a",
      repoUrl: null,
      repoRef: "main",
    });
    mockStopRuntimeServicesForExecutionWorkspace.mockResolvedValue(undefined);
    mockListConfiguredRuntimeServiceEntries.mockReturnValue([{ name: "app" }]);
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      attachExecutionWorkspaceId: vi.fn(),
      recordOperation: async (input: any) => {
        // Mirror the real recorder: a throwing `run` becomes a terminal failed operation and
        // the error still propagates to the caller.
        try {
          await input.run(async () => undefined);
        } catch (error) {
          (error as any).recordedOperationStatus = "failed";
          throw error;
        }
        return { id: "operation-1", status: "succeeded" };
      },
    });
  });

  it("returns a stable 409 while a managed control is genuinely live", async () => {
    const { conflict } = await import("../errors.js");
    mockWorkspaceOperationService.assertRuntimeControlAvailable.mockRejectedValue(
      conflict("A managed runtime control operation is already in progress for this execution workspace.", {
        code: "workspace_runtime_control_in_progress",
        executionWorkspaceId,
        activeAction: "start",
        requestedAction: "stop",
        activeOperationId: "operation-live",
        remediation: "Wait for the active operation to reach a terminal state before retrying.",
      }),
    );
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/stop`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.details ?? res.body).toMatchObject({
      code: "workspace_runtime_control_in_progress",
      activeAction: "start",
      requestedAction: "stop",
    });
    // The conflict is decided before any runtime mutation happens.
    expect(mockStopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockStartRuntimeServices).not.toHaveBeenCalled();
  });

  it("checks authorization before recovering or claiming the workspace", async () => {
    const { forbidden } = await import("../errors.js");
    mockAssertCanManageExecutionWorkspaceRuntimeServices.mockRejectedValue(
      forbidden("Missing permission to manage workspace runtime services"),
    );
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockWorkspaceOperationService.assertRuntimeControlAvailable).not.toHaveBeenCalled();
  });

  it("tears down residue and records a stopped desired state when a start fails", async () => {
    mockStartRuntimeServices.mockRejectedValue(
      new Error(
        'Runtime service "app" could not start because port 42003 is already in use by pid 4242 (cwd: /tmp/lane-b)',
      ),
    );
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    // No exposure/listener residue: the failed lane is stopped through the ordinary teardown.
    expect(mockStopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ executionWorkspaceId, workspaceCwd: "/tmp/lane-a" }),
    );
    // ...and the workspace is no longer recorded as wanting to run, so it is retryable and a
    // startup reconcile will not resurrect a lane that never came up.
    expect(mockBuildWorkspaceRuntimeDesiredStatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "stop" }),
    );
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledWith(
      executionWorkspaceId,
      expect.objectContaining({ metadata: expect.anything() }),
    );
  });

  it("returns 422 with a stable reason when the repair seed manifest is malformed", async () => {
    const workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-route-repair-malformed-"));
    try {
      const configDir = path.join(workspaceCwd, ".paperclip");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), "{}\n");
      fs.writeFileSync(path.join(configDir, "seed-manifest.json"), "{ definitely-not-json\n");
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace({ cwd: workspaceCwd }));

      const res = await request(await createApp())
        .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-commands/repair`)
        .send({});

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: "workspace_repair_precondition_failed",
        reason: "seed_manifest_malformed",
        repairPhase: "precondition_validation",
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspaceCwd, { recursive: true, force: true });
    }
  });

  it("returns 409 with a stable reason when no repair source is readable", async () => {
    const workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-route-repair-no-source-"));
    try {
      const configDir = path.join(workspaceCwd, ".paperclip");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), "{}\n");
      fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
        version: 2,
        source: { instanceId: "source", configPath: path.join(workspaceCwd, "missing", "config.json") },
        state: "failed",
        attemptId: "previous",
      }));
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace({ cwd: workspaceCwd }));

      const res = await request(await createApp())
        .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-commands/repair`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: "workspace_repair_precondition_failed",
        reason: "source_instance_unavailable",
        repairPhase: "precondition_validation",
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspaceCwd, { recursive: true, force: true });
    }
  });

  it("returns 409 with a stable reason when no Paperclip CLI is runnable", async () => {
    const workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-route-repair-no-cli-"));
    try {
      const configDir = path.join(workspaceCwd, ".paperclip");
      const sourceConfigPath = path.join(workspaceCwd, "source", "config.json");
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), "{}\n");
      fs.writeFileSync(sourceConfigPath, "{}\n");
      fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
        version: 2,
        source: { instanceId: "source", configPath: sourceConfigPath },
        state: "failed",
        attemptId: "previous",
      }));
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace({ cwd: workspaceCwd }));

      const res = await request(await createApp())
        .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-commands/repair`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: "workspace_repair_precondition_failed",
        reason: "paperclip_cli_unavailable",
        repairPhase: "precondition_validation",
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspaceCwd, { recursive: true, force: true });
    }
  });

  it("returns 422 with a stable reason when the verified manifest names another instance", async () => {
    const workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-route-repair-wrong-instance-"));
    try {
      const configDir = path.join(workspaceCwd, ".paperclip");
      const sourceConfigPath = path.join(workspaceCwd, "source", "config.json");
      const cliRunner = path.join(workspaceCwd, "cli", "node_modules", "tsx", "dist", "cli.mjs");
      const cliEntry = path.join(workspaceCwd, "cli", "src", "index.ts");
      for (const dir of [configDir, path.dirname(sourceConfigPath), path.dirname(cliRunner), path.dirname(cliEntry)]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(path.join(configDir, "config.json"), "{}\n");
      fs.writeFileSync(sourceConfigPath, "{}\n");
      fs.writeFileSync(cliRunner, "// test runner\n");
      fs.writeFileSync(cliEntry, "// test entry\n");
      fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
        version: 2,
        source: { instanceId: "source", configPath: sourceConfigPath },
        state: "failed",
        attemptId: "previous",
      }));
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace({ cwd: workspaceCwd }));
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();
        queueMicrotask(() => {
          fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
            version: 2,
            source: { instanceId: "source", configPath: sourceConfigPath },
            snapshotAt: "2026-08-18T00:00:00.000Z",
            seedMode: "full",
            migrationRevision: "0142_test.sql",
            targetInstanceId: "another-workspace-instance",
            phase: "complete",
            state: "verified",
            attemptId: "repair-attempt",
            startedAt: "2026-08-18T00:00:00.000Z",
            finishedAt: "2026-08-18T00:01:00.000Z",
            diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-18T00:01:00.000Z" }],
          }));
          child.emit("exit", 0);
        });
        return child;
      });

      const res = await request(await createApp())
        .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-commands/repair`)
        .send({});

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        code: "workspace_repair_precondition_failed",
        reason: "seed_manifest_instance_mismatch",
        repairPhase: "full_reseed",
      });
      expect(mockStartRuntimeServices).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspaceCwd, { recursive: true, force: true });
    }
  });

  it("uses the recorded instance pointer consistently for readiness, handoff, and repair", async () => {
    const workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-route-repair-success-"));
    try {
      const configDir = path.join(workspaceCwd, ".paperclip");
      const recordedInstanceId = "recorded-repair-instance";
      const sourceConfigPath = path.join(workspaceCwd, "source", "config.json");
      const cliRunner = path.join(workspaceCwd, "cli", "node_modules", "tsx", "dist", "cli.mjs");
      const cliEntry = path.join(workspaceCwd, "cli", "src", "index.ts");
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(cliRunner), { recursive: true });
      fs.mkdirSync(path.dirname(cliEntry), { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), "{}\n");
      fs.writeFileSync(
        path.join(configDir, ".env"),
        `PAPERCLIP_HOME=/srv/home\nPAPERCLIP_INSTANCE_ID=${recordedInstanceId}\n`,
      );
      fs.writeFileSync(sourceConfigPath, "{}\n");
      fs.writeFileSync(cliRunner, "// test runner\n");
      fs.writeFileSync(cliEntry, "// test entry\n");
      fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
        version: 2,
        source: { instanceId: "source", configPath: sourceConfigPath },
        state: "failed",
        attemptId: "previous",
      }));

      const { deriveWorktreeInstanceId } = await import("../services/workspace-instance-cleanup.js");
      const {
        resolveManagedWorkspaceIdentity,
        resolveManagedWorkspaceInstanceId,
      } = await import("../services/managed-workspace-identity.js");
      expect(deriveWorktreeInstanceId(workspaceCwd)).not.toBe(recordedInstanceId);
      expect(resolveManagedWorkspaceInstanceId(workspaceCwd)).toBe(recordedInstanceId);
      expect(resolveManagedWorkspaceIdentity({
        workspaceCwd,
        executionWorkspaceId,
        companyId: "company-1",
        env: { PAPERCLIP_WORKSPACE_HANDOFF_SECRET: "test-root-secret" },
      })?.instanceId).toBe(recordedInstanceId);
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace({ cwd: workspaceCwd }));
      mockEnsurePersistedExecutionWorkspaceAvailable.mockResolvedValue({ cwd: workspaceCwd });
      mockStartRuntimeServices.mockResolvedValue([{
        id: "service-1",
        status: "running",
        healthStatus: "healthy",
      }]);
      mockSpawn.mockImplementation((_command: string, args: string[]) => {
        expect(args).toEqual(expect.arrayContaining([
          "worktree", "reseed", "--seed-mode", "full", "--yes", "--backup-target",
        ]));
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();
        queueMicrotask(() => {
          fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
            version: 2,
            source: { instanceId: "source", configPath: sourceConfigPath },
            snapshotAt: "2026-08-18T00:00:00.000Z",
            seedMode: "full",
            migrationRevision: "0142_test.sql",
            targetInstanceId: recordedInstanceId,
            phase: "complete",
            state: "verified",
            attemptId: "repair-attempt",
            startedAt: "2026-08-18T00:00:00.000Z",
            finishedAt: "2026-08-18T00:01:00.000Z",
            diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-18T00:01:00.000Z" }],
          }));
          child.emit("exit", 0);
        });
        return child;
      });

      const app = await createApp();
      const res = await request(app)
        .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-commands/repair`)
        .send({});

      expect(res.status).toBe(200);
      expect(mockStopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ executionWorkspaceId, workspaceCwd }),
      );
      expect(mockStartRuntimeServices).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "execution_workspace.runtime_repair" }),
      );
    } finally {
      fs.rmSync(workspaceCwd, { recursive: true, force: true });
    }
  });

  it("completes database-only repair when no managed runtime service is configured", async () => {
    const workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-route-repair-db-only-"));
    try {
      const configDir = path.join(workspaceCwd, ".paperclip");
      const sourceConfigPath = path.join(workspaceCwd, "source", "config.json");
      const cliRunner = path.join(workspaceCwd, "cli", "node_modules", "tsx", "dist", "cli.mjs");
      const cliEntry = path.join(workspaceCwd, "cli", "src", "index.ts");
      for (const dir of [configDir, path.dirname(sourceConfigPath), path.dirname(cliRunner), path.dirname(cliEntry)]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(path.join(configDir, "config.json"), "{}\n");
      fs.writeFileSync(sourceConfigPath, "{}\n");
      fs.writeFileSync(cliRunner, "// test runner\n");
      fs.writeFileSync(cliEntry, "// test entry\n");
      fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
        version: 2,
        source: { instanceId: "source", configPath: sourceConfigPath },
        state: "failed",
        attemptId: "previous",
      }));

      const { deriveWorktreeInstanceId } = await import("../services/workspace-instance-cleanup.js");
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace({
        cwd: workspaceCwd,
        config: { desiredState: "stopped" },
      }));
      mockListConfiguredRuntimeServiceEntries.mockReturnValue([]);
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();
        queueMicrotask(() => {
          fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
            version: 2,
            source: { instanceId: "source", configPath: sourceConfigPath },
            snapshotAt: "2026-08-18T00:00:00.000Z",
            seedMode: "full",
            migrationRevision: "0142_test.sql",
            targetInstanceId: deriveWorktreeInstanceId(workspaceCwd),
            phase: "complete",
            state: "verified",
            attemptId: "repair-attempt",
            startedAt: "2026-08-18T00:00:00.000Z",
            finishedAt: "2026-08-18T00:01:00.000Z",
            diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-18T00:01:00.000Z" }],
          }));
          child.emit("exit", 0);
        });
        return child;
      });

      const app = await createApp();
      const res = await request(app)
        .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-commands/repair`)
        .send({});

      expect(res.status).toBe(200);
      expect(mockStopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledTimes(1);
      expect(mockStartRuntimeServices).not.toHaveBeenCalled();
      expect(mockBuildWorkspaceRuntimeDesiredStatePatch).toHaveBeenCalledWith(
        expect.objectContaining({ action: "stop" }),
      );
    } finally {
      fs.rmSync(workspaceCwd, { recursive: true, force: true });
    }
  });

  it("fails repair at the exact seed phase and leaves managed services stopped", async () => {
    const workspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-route-repair-failure-"));
    try {
      const configDir = path.join(workspaceCwd, ".paperclip");
      const sourceConfigPath = path.join(workspaceCwd, "source", "config.json");
      const cliRunner = path.join(workspaceCwd, "cli", "node_modules", "tsx", "dist", "cli.mjs");
      const cliEntry = path.join(workspaceCwd, "cli", "src", "index.ts");
      for (const dir of [configDir, path.dirname(sourceConfigPath), path.dirname(cliRunner), path.dirname(cliEntry)]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(path.join(configDir, "config.json"), "{}\n");
      fs.writeFileSync(sourceConfigPath, "{}\n");
      fs.writeFileSync(cliRunner, "// test runner\n");
      fs.writeFileSync(cliEntry, "// test entry\n");
      fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
        version: 2,
        source: { instanceId: "source", configPath: sourceConfigPath },
        state: "failed",
        attemptId: "previous",
      }));
      mockExecutionWorkspaceService.getById.mockResolvedValue(buildExecutionWorkspace({ cwd: workspaceCwd }));
      mockEnsurePersistedExecutionWorkspaceAvailable.mockResolvedValue({ cwd: workspaceCwd });
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();
        queueMicrotask(() => {
          fs.writeFileSync(path.join(configDir, "seed-manifest.json"), JSON.stringify({
            version: 2,
            source: { instanceId: "source", configPath: sourceConfigPath },
            state: "failed",
            phase: "restore",
            attemptId: "repair-attempt",
          }));
          child.emit("exit", 4);
        });
        return child;
      });

      const progress: Array<Record<string, unknown>> = [];
      mockWorkspaceOperationService.createRecorder.mockReturnValue({
        attachExecutionWorkspaceId: vi.fn(),
        recordOperation: async (input: any) => {
          await input.run(async (entry: Record<string, unknown>) => {
            progress.push(entry);
          });
        },
      });
      const app = await createApp();
      const res = await request(app)
        .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-commands/repair`)
        .send({});

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Internal server error" });
      expect(progress).toEqual(expect.arrayContaining([
        expect.objectContaining({ metadata: { seedFailurePhase: "restore" } }),
      ]));
      expect(mockStartRuntimeServices).not.toHaveBeenCalled();
      expect(mockStopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(workspaceCwd, { recursive: true, force: true });
    }
  });

  it("reconciles once when the operation's own time budget fails a start that never settles", async () => {
    const { WorkspaceOperationTimeoutError } = await import("../services/workspace-operations.js");
    // The recorder's ceiling fires outside `run`, so only the outer handler can reconcile.
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      attachExecutionWorkspaceId: vi.fn(),
      recordOperation: async () => {
        throw new WorkspaceOperationTimeoutError(1_000, "start");
      },
    });
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockStopRuntimeServicesForExecutionWorkspace).toHaveBeenCalledTimes(1);
    expect(mockBuildWorkspaceRuntimeDesiredStatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "stop" }),
    );
  });

  it("leaves a successful start's desired state untouched by the failure path", async () => {
    mockStartRuntimeServices.mockResolvedValue([{ id: "runtime-1" }]);
    const app = await createApp();

    const res = await request(app)
      .post(`/api/execution-workspaces/${executionWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBeLessThan(400);
    expect(mockStopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockBuildWorkspaceRuntimeDesiredStatePatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "stop" }),
    );
  });
});
