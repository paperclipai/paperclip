import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, workflowRunPhases, workflowRuns, workflows } from "@paperclipai/db";
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

vi.mock("../storage/index.js", () => ({
  getStorageService: mockGetStorageService,
}));

vi.mock("@paperclipai/adapter-google-adk/server", () => ({
  invokeGoogleAdk: mockInvokeGoogleAdk,
}));

vi.mock("../services/workflows-runtime.js", () => ({
  analyzeWorkflowProject: mockAnalyzeWorkflowProject,
  prepareInstrumentedWorkflowRuntime: mockPrepareInstrumentedWorkflowRuntime,
  collectWorkflowRuntimeArtifacts: mockCollectWorkflowRuntimeArtifacts,
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

    await vi.waitFor(async () => {
      const updated = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).then((rows) => rows[0] ?? null);
      expect(updated?.status).toBe("succeeded");
    }, 10_000);

    expect(mockAnalyzeWorkflowProject).toHaveBeenCalledTimes(1);
    expect(mockPrepareInstrumentedWorkflowRuntime).toHaveBeenCalledTimes(1);
    expect(mockPrepareInstrumentedWorkflowRuntime.mock.calls[0]?.[0]).toMatchObject({
      analysis: expect.objectContaining({ sourceHash: "hash-1" }),
    });

    const phases = await db.select().from(workflowRunPhases).where(eq(workflowRunPhases.workflowRunId, run.id));
    expect(phases).toHaveLength(1);
    expect(phases[0]?.phaseKey).toBe("phase-1");
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
});
