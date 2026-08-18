import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CITRO_SOCIAL_CMS_EXTENSION } from "@paperclipai/shared";
import {
  companies,
  createDb,
  workflowDeliverables,
  workflowExtensionRequests,
  workflowHandoffs,
  workflowRunEvents,
  workflowRunPhases,
  workflowRunTelemetryEvents,
  workflowRuns,
  workflows,
} from "@paperclipai/db";
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
const mockDeleteObject = vi.hoisted(() => vi.fn(async () => undefined));
const mockGetStorageService = vi.hoisted(() => vi.fn(() => ({
  provider: "local_disk",
  putFile: mockPutFile,
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: mockDeleteObject,
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
    expect(phases[0]?.status).toBe("idle");
  });

  it("rejects manual runs for archived workflows", async () => {
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
      title: "Archived workflow",
      status: "archived",
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });

    await expect(workflowService(db).runManual(workflowId, { inputMarkdown: "generate" }))
      .rejects.toThrow(/archived.*restore/i);
    expect(mockInvokeGoogleAdk).not.toHaveBeenCalled();
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
    expect(phases[0]?.status).toBe("idle");
  });

  it("creates a live phase when runtime instrumentation observes an unlisted ADK agent", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Live trace",
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
      status: "running",
      inputMarkdown: "Create a Facebook post",
      startedAt: new Date(),
    });

    const phase = await workflowService(db).applyPhaseEvent(runId, {
      phaseKey: "agent-runtime:platform_intake_agent",
      label: "platform_intake_agent",
      status: "running",
      metadata: {
        runtimeAgent: true,
        agentName: "platform_intake_agent",
        model: "bedrock/global.anthropic.claude-sonnet-4-6",
        prompt: "Create a Facebook post",
        systemPrompt: "Return a validated platform brief.",
        configuredTools: [],
      },
    });

    expect(phase).toMatchObject({
      phaseKey: "agent-runtime:platform_intake_agent",
      kind: "agent",
      status: "running",
      metadata: expect.objectContaining({
        model: "bedrock/global.anthropic.claude-sonnet-4-6",
        systemPrompt: "Return a validated platform brief.",
        runtimeCalled: true,
      }),
    });
  });

  it("ingests telemetry idempotently and returns normalized events with the run", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Telemetry company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Telemetry workflow",
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
      status: "running",
      inputMarkdown: "generate",
    });
    const event = {
      schema: "bizbox.telemetry/v1" as const,
      event: "operation.completed" as const,
      eventId: "evt-partnerpal-1",
      spanId: "tool-partnerpal-1",
      parentSpanId: "agent-grounding-1",
      sequence: 2,
      timestamp: "2026-08-12T00:00:00.000Z",
      actor: { kind: "tool" as const, name: "partnerpal" },
      operation: { kind: "tool" as const, name: "partnerpal" },
      status: "succeeded" as const,
      output: { matches: 1 },
      attributes: { provenance: "gcs" },
    };
    const svc = workflowService(db);

    await expect(svc.applyTelemetryEvents(runId, [event])).resolves.toEqual({ accepted: 1, duplicates: 0 });
    await expect(svc.applyTelemetryEvents(runId, [event])).resolves.toEqual({ accepted: 0, duplicates: 1 });

    const rows = await db.select().from(workflowRunTelemetryEvents).where(eq(workflowRunTelemetryEvents.workflowRunId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId, eventId: event.eventId, operationName: "partnerpal" });
    const detail = await svc.getRunDetail(runId);
    expect(detail?.telemetryEvents).toEqual([
      expect.objectContaining({
        schema: "bizbox.telemetry/v1",
        eventId: event.eventId,
        output: { matches: 1 },
      }),
    ]);
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

  it("keeps generic and Social CMS handoffs on the compatible awaiting_human lifecycle", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const genericRunId = randomUUID();
    const socialRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Mixed workflow fixtures",
      status: "active",
      capabilities: [CITRO_SOCIAL_CMS_EXTENSION],
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });
    await db.insert(workflowRuns).values([
      { id: genericRunId, companyId, workflowId, status: "running", inputMarkdown: "generic" },
      { id: socialRunId, companyId, workflowId, status: "running", inputMarkdown: "social" },
    ]);
    await db.insert(workflowRunPhases).values([
      { companyId, workflowRunId: genericRunId, phaseKey: "approval", label: "Approval", kind: "phase", ordinal: 0, status: "running" },
      { companyId, workflowRunId: socialRunId, phaseKey: "assets", label: "Assets", kind: "phase", ordinal: 0, status: "running" },
    ]);

    const svc = workflowService(db);
    const genericHandoff = await svc.createRuntimeHandoff(genericRunId, {
      phaseKey: "approval",
      kind: "approval",
      promptMarkdown: "Continue?",
    });
    await svc.createRuntimeHandoff(socialRunId, {
      phaseKey: "assets",
      kind: "approval",
      stage: "content",
      eventPhase: "assets",
      reviewSummary: "Rendered assets are ready.",
      idempotencyKey: "social-assets-review-0",
      promptMarkdown: "Review assets?",
    });

    const [genericParked] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, genericRunId));
    const [socialParked] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, socialRunId));
    const genericEvents = await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.workflowRunId, genericRunId));
    const socialEvents = await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.workflowRunId, socialRunId));

    expect(genericParked).toMatchObject({ status: "awaiting_human", reviewStage: null });
    expect(socialParked).toMatchObject({ status: "awaiting_human", reviewStage: "content" });
    expect(genericEvents).toHaveLength(0);
    expect(socialEvents).toHaveLength(1);
    expect(socialEvents[0]).toMatchObject({ phase: "assets", summary: "Rendered assets are ready." });

    await svc.resolveHandoff(genericHandoff.id, "rejected", { userId: "board" }, { responseMarkdown: "No" });
    const [genericResumed] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, genericRunId));
    const [genericPhase] = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, genericRunId));

    expect(genericResumed?.status).toBe("running");
    expect(genericResumed?.finishedAt).toBeNull();
    expect(genericPhase?.status).toBe("running");
  });

  it("makes Social CMS publications and exact-handoff feedback retry-safe", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Social CMS",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Social workflow",
      status: "active",
      capabilities: [CITRO_SOCIAL_CMS_EXTENSION],
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", inputMarkdown: "social" });
    await db.insert(workflowRunPhases).values({
      companyId,
      workflowRunId: runId,
      phaseKey: "review",
      label: "Review",
      kind: "phase",
      ordinal: 0,
      status: "running",
    });

    const svc = workflowService(db);
    const handoff = await svc.createRuntimeHandoff(runId, {
      phaseKey: "review",
      kind: "approval",
      stage: "content",
      reviewSummary: "Draft ready",
      idempotencyKey: "handoff-content-0",
      promptMarkdown: "Review the draft",
    });
    const reviewRequest = {
      idempotencyKey: "review-publication-0",
      generationId: "generation-1",
      revision: 0,
      deliverables: [{ id: "post-1", title: "Post", contentMarkdown: "Hello", screens: [{ screenNumber: 1, copy: "Hello" }] }],
    };
    await expect(svc.publishRunReview(runId, reviewRequest)).resolves.toMatchObject({ generationId: "generation-1", revision: 0 });
    await expect(svc.publishRunReview(runId, reviewRequest)).resolves.toMatchObject({ generationId: "generation-1", revision: 0 });
    await expect(svc.publishRunReview(runId, {
      ...reviewRequest,
      deliverables: [{ ...reviewRequest.deliverables[0]!, contentMarkdown: "Changed under the same retry key" }],
    })).rejects.toThrow(/idempotency key/i);
    const deliverables = await db.select().from(workflowDeliverables).where(eq(workflowDeliverables.workflowRunId, runId));
    expect(deliverables).toHaveLength(1);

    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    mockPutFile
      .mockResolvedValueOnce({
        provider: "local_disk",
        objectKey: "workflow-deliverables/first.png",
        contentType: "image/png",
        byteSize: 8,
        sha256: "hash",
        originalFilename: "first.png",
      })
      .mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(svc.publishRunAssets(runId, {
      idempotencyKey: "asset-publication-0",
      generationId: "generation-1",
      revision: 0,
      assets: [1, 2].map((screenNumber) => ({
        id: `asset-${screenNumber}`,
        deliverableId: "post-1",
        screenNumber,
        postType: "carousel",
        templateId: "template-1",
        contentBase64: pngHeader,
        contentType: "image/png",
      })),
    })).rejects.toThrow("storage unavailable");
    expect(mockDeleteObject).toHaveBeenCalledWith(companyId, "workflow-deliverables/first.png");
    const deliverablesAfterFailure = await db.select().from(workflowDeliverables).where(eq(workflowDeliverables.workflowRunId, runId));
    expect(deliverablesAfterFailure).toHaveLength(1);

    const feedback = {
      idempotencyKey: "feedback-content-0",
      generationId: "generation-1",
      revision: 0,
      action: "request_changes" as const,
      stage: "content" as const,
      instruction: "Warmer tone",
      target: { scope: "copy" as const },
    };
    await expect(svc.submitRunFeedback(runId, randomUUID(), feedback, { userId: "board" }))
      .rejects.toThrow(/handoff not found/i);
    await expect(svc.submitRunFeedback(runId, handoff.id, feedback, { userId: "board" }))
      .resolves.toMatchObject({ status: "running", revision: 1, duplicate: false });
    await expect(svc.submitRunFeedback(runId, handoff.id, feedback, { userId: "board" }))
      .resolves.toMatchObject({ status: "running", revision: 1, duplicate: true });
    const requests = await db.select().from(workflowExtensionRequests).where(eq(workflowExtensionRequests.workflowRunId, runId));
    expect(requests).toHaveLength(2);
  });

  it("rejects Social CMS APIs when the workflow did not opt in", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Generic",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Generic workflow",
      status: "active",
      capabilities: [],
      runnerType: "google_adk",
      runnerConfig: { agentPath: "/tmp/agent.py" },
      pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
      pipelineSourceHash: null,
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", inputMarkdown: "generic" });
    await expect(workflowService(db).getRunReview(runId)).rejects.toThrow(/has not enabled/i);
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
