import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, workflowHandoffs, workflowRunPhases, workflowRuns, workflows } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockPutFile = vi.hoisted(() => vi.fn(async () => ({
  provider: "local_disk",
  objectKey: "workflow-deliverables/object.md",
  contentType: "text/markdown; charset=utf-8",
  byteSize: 12,
  sha256: "hash",
  originalFilename: "object.md",
})));
const mockGetStorageService = vi.hoisted(() => vi.fn(() => ({
  provider: "local_disk",
  putFile: mockPutFile,
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
})));
const mockInvokeGoogleAdk = vi.hoisted(() => vi.fn(async () => ({
  summary: "done",
  resultJson: { ok: true },
  errorMessage: null,
  provider: "google",
  model: "gemini",
  usage: null,
})));
const mockAnalyzeWorkflowProject = vi.hoisted(() => vi.fn(async () => ({
  pipelineDefinition: {
    entrypoint: "agent.py",
    generatedAt: "2026-06-02T12:00:00.000Z",
    phases: [{
      key: "phase-1",
      label: "Phase 1",
      kind: "phase",
      ordinal: 0,
      filePath: "agent.py",
      functionName: "run",
      parentKey: null,
      depth: 0,
      agentName: null,
      description: null,
    }],
  },
  sourceHash: "hash-1",
})));
const mockPrepareInstrumentedWorkflowRuntime = vi.hoisted(() => vi.fn(async (input: { analysis: unknown; runnerConfig: Record<string, unknown> }) => ({
  runtimeRoot: "/tmp/workflow-runtime",
  tempRoot: "/tmp/workflow-runtime/tmp",
  copiedAgentPath: "/tmp/workflow-runtime/agent.py",
  patchedRunnerConfig: input.runnerConfig,
  analysis: input.analysis,
})));
const mockCollectWorkflowRuntimeArtifacts = vi.hoisted(() => vi.fn(async () => []));
const mockCloseResolvedHandoff = vi.hoisted(() => vi.fn(async () => null));
const mockCloseTerminalRunHandoffs = vi.hoisted(() => vi.fn(async () => []));
const mockWorkflowHandoffBridgeService = vi.hoisted(() => vi.fn(() => ({
  closeResolvedHandoff: mockCloseResolvedHandoff,
  closeTerminalRunHandoffs: mockCloseTerminalRunHandoffs,
})));

vi.mock("../storage/index.js", () => ({
  getStorageService: mockGetStorageService,
}));

vi.mock("@paperclipai/adapter-google-adk/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-google-adk/server")>();
  return {
    ...actual,
    invokeGoogleAdk: mockInvokeGoogleAdk,
  };
});

vi.mock("../services/workflows-runtime.js", () => ({
  analyzeWorkflowProject: mockAnalyzeWorkflowProject,
  prepareInstrumentedWorkflowRuntime: mockPrepareInstrumentedWorkflowRuntime,
  collectWorkflowRuntimeArtifacts: mockCollectWorkflowRuntimeArtifacts,
}));

vi.mock("../services/workflow-handoff-bridge.js", () => ({
  workflowHandoffBridgeService: mockWorkflowHandoffBridgeService,
}));

vi.mock("../workflow-run-jwt.js", () => ({
  createWorkflowRunJwt: vi.fn(() => "workflow-token"),
  verifyWorkflowRunJwt: vi.fn(),
}));

import { workflowService } from "../services/workflows.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workflowService.runManual", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(workflowHandoffs);
    await db.delete(workflowRunPhases);
    await db.delete(workflowRuns);
    await db.delete(workflows);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reuses the initial workflow analysis for async execution", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Brief generator",
      status: "active",
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });

    const svc = workflowService(db);
    const run = await svc.runManual(workflowId, { inputMarkdown: "generate" });
    expect(run.invocation).toBeNull();

    await vi.waitFor(async () => {
      const updated = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).then((rows) => rows[0] ?? null);
      expect(updated?.status).toBe("succeeded");
    }, 10_000);

    expect(mockAnalyzeWorkflowProject).toHaveBeenCalledTimes(1);
    expect(mockPrepareInstrumentedWorkflowRuntime).toHaveBeenCalledTimes(1);
    expect(mockPrepareInstrumentedWorkflowRuntime.mock.calls[0]?.[0]).toMatchObject({
      analysis: expect.objectContaining({ sourceHash: "hash-1" }),
    });
    expect(mockPrepareInstrumentedWorkflowRuntime.mock.calls[0]?.[0]).toMatchObject({
      runnerConfig: expect.objectContaining({ timeoutSec: 86400 }),
    });
    expect(mockInvokeGoogleAdk).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ timeoutSec: 86400 }),
    }));

    const phases = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, run.id));
    expect(phases).toHaveLength(1);
    expect(phases[0]?.phaseKey).toBe("phase-1");
  });

  it("closes active phases when the ADK invocation exits", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Brief generator",
      status: "active",
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });

    mockInvokeGoogleAdk.mockImplementationOnce(async (input: { runId: string }) => {
      await db.update(workflowRunPhases).set({
        status: "running",
        updatedAt: new Date(),
      }).where(eq(workflowRunPhases.workflowRunId, input.runId));
      return {
        summary: "done",
        resultJson: { ok: true },
        errorMessage: null,
        provider: "google",
        model: "gemini",
        usage: null,
      };
    });

    const svc = workflowService(db);
    const run = await svc.runManual(workflowId, { inputMarkdown: "generate" });

    await vi.waitFor(async () => {
      const updated = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).then((rows) => rows[0] ?? null);
      expect(updated?.status).toBe("succeeded");
    }, 10_000);

    const [phase] = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, run.id));
    expect(phase?.status).toBe("succeeded");
    expect(phase?.finishedAt).toBeInstanceOf(Date);
  });

  it("does not let late phase events overwrite a terminal run status", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Brief generator",
      status: "active",
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });

    const svc = workflowService(db);
    const run = await svc.runManual(workflowId, { inputMarkdown: "generate" });

    await vi.waitFor(async () => {
      const updated = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).then((rows) => rows[0] ?? null);
      expect(updated?.status).toBe("succeeded");
    }, 10_000);

    await svc.applyPhaseEvent(run.id, { phaseKey: "phase-1", status: "running" });
    await svc.applyPhaseEvent(run.id, { phaseKey: "phase-1", status: "awaiting_human" });

    const updated = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).then((rows) => rows[0] ?? null);
    expect(updated?.status).toBe("succeeded");
    const phases = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, run.id));
    expect(phases[0]?.status).toBe("succeeded");
  });

  it("marks active workflow runs interrupted on startup recovery", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const durableWorkflowId = randomUUID();
    const activeRunId = randomUUID();
    const durableRunId = randomUUID();
    const doneRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Brief generator",
      status: "active",
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });
    await db.insert(workflows).values({
      id: durableWorkflowId,
      companyId,
      title: "Durable workflow",
      status: "active",
      runnerType: "durable_queue",
      runnerConfig: {},
      pipelineDefinition: { entrypoint: "queue", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });
    await db.insert(workflowRuns).values([
      {
        id: activeRunId,
        companyId,
        workflowId,
        status: "awaiting_human",
        inputMarkdown: "generate",
      },
      {
        id: durableRunId,
        companyId,
        workflowId: durableWorkflowId,
        status: "awaiting_human",
        inputMarkdown: "durable",
      },
      {
        id: doneRunId,
        companyId,
        workflowId,
        status: "succeeded",
        inputMarkdown: "done",
      },
    ]);
    await db.insert(workflowRunPhases).values([
      {
        companyId,
        workflowRunId: activeRunId,
        phaseKey: "phase-1",
        label: "Phase 1",
        kind: "phase",
        ordinal: 0,
        status: "idle",
      },
      {
        companyId,
        workflowRunId: durableRunId,
        phaseKey: "phase-1",
        label: "Phase 1",
        kind: "phase",
        ordinal: 0,
        status: "awaiting_human",
      },
      {
        companyId,
        workflowRunId: doneRunId,
        phaseKey: "phase-1",
        label: "Phase 1",
        kind: "phase",
        ordinal: 0,
        status: "succeeded",
      },
    ]);

    const result = await workflowService(db).failInterruptedActiveRuns();

    expect(result).toMatchObject({ failed: 1, runIds: [activeRunId] });
    const [activeRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, activeRunId));
    expect(activeRun?.status).toBe("failed");
    expect(activeRun?.error).toBe("Workflow process was interrupted before completion.");
    const [activePhase] = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, activeRunId));
    expect(activePhase?.status).toBe("failed");
    expect(activePhase?.startedAt).toBeInstanceOf(Date);
    expect(activePhase?.finishedAt).toBeInstanceOf(Date);

    const [durableRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, durableRunId));
    expect(durableRun?.status).toBe("awaiting_human");
    expect(durableRun?.error).toBeNull();
    const [durablePhase] = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, durableRunId));
    expect(durablePhase?.status).toBe("awaiting_human");

    const [doneRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, doneRunId));
    expect(doneRun?.status).toBe("succeeded");
    const [donePhase] = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, doneRunId));
    expect(donePhase?.status).toBe("succeeded");
  });

  it("closes an active ClickUp bridge when a handoff is resolved directly", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const handoffId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Brief generator",
      status: "active",
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });
    await db.insert(workflowRuns).values({
      id: runId,
      companyId,
      workflowId,
      status: "awaiting_human",
      inputMarkdown: "generate",
    });
    await db.insert(workflowRunPhases).values({
      companyId,
      workflowRunId: runId,
      phaseKey: "phase-1",
      label: "Phase 1",
      kind: "phase",
      ordinal: 0,
      status: "awaiting_human",
    });
    await db.insert(workflowHandoffs).values({
      id: handoffId,
      companyId,
      workflowRunId: runId,
      phaseKey: "phase-1",
      kind: "approval",
      status: "pending",
      promptMarkdown: "Approve?",
    });

    const resolved = await workflowService(db).resolveHandoff(
      handoffId,
      "approved",
      { userId: "board" },
      { responseMarkdown: "Approve" },
    );

    expect(resolved?.status).toBe("approved");
    expect(mockCloseResolvedHandoff).toHaveBeenCalledWith(handoffId, "approved");

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run?.status).toBe("running");
    const [phase] = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, runId));
    expect(phase?.status).toBe("running");
  });

  it("cancels an active workflow run and closes pending handoffs", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const handoffId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Brief generator",
      status: "active",
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });
    await db.insert(workflowRuns).values({
      id: runId,
      companyId,
      workflowId,
      status: "awaiting_human",
      inputMarkdown: "generate",
    });
    await db.insert(workflowRunPhases).values({
      companyId,
      workflowRunId: runId,
      phaseKey: "phase-1",
      label: "Phase 1",
      kind: "phase",
      ordinal: 0,
      status: "awaiting_human",
    });
    await db.insert(workflowHandoffs).values({
      id: handoffId,
      companyId,
      workflowRunId: runId,
      phaseKey: "phase-1",
      kind: "approval",
      status: "pending",
      promptMarkdown: "Approve?",
    });

    const cancelled = await workflowService(db).cancelRun(runId, { userId: "board-user" });

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error).toBe("Workflow run was cancelled by the board.");
    expect(mockCloseTerminalRunHandoffs).toHaveBeenCalledWith(runId, "cancelled");

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run?.status).toBe("cancelled");
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(run?.contextSnapshot).toMatchObject({
      resultJson: {
        stopReason: "cancelled",
        cancelledByUserId: "board-user",
      },
    });

    const [phase] = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, runId));
    expect(phase?.status).toBe("cancelled");
    expect(phase?.finishedAt).toBeInstanceOf(Date);

    const [handoff] = await db.select().from(workflowHandoffs).where(eq(workflowHandoffs.id, handoffId));
    expect(handoff?.status).toBe("cancelled");
    expect(handoff?.decidedByUserId).toBe("board-user");
  });
});
