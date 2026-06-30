import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  routineRuns,
  routines,
  workflowInvocations,
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
    phases: [],
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

import { workflowService, resolveWorkflowByInvocationTarget } from "../services/workflows.ts";
import { workflowInvocationService } from "../services/workflow-invocations.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow invocation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function seedCompany(db: ReturnType<typeof createDb>, title = "Paperclip") {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: title,
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  return companyId;
}

async function seedRoutine(db: ReturnType<typeof createDb>, companyId: string, title = "Brief intake") {
  const routineId = randomUUID();
  const routineRunId = randomUUID();
  await db.insert(routines).values({
    id: routineId,
    companyId,
    title,
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    priority: "medium",
    variables: [],
  });
  await db.insert(routineRuns).values({
    id: routineRunId,
    companyId,
    routineId,
    source: "manual",
    status: "received",
  });
  return { routineId, routineRunId };
}

async function seedWorkflow(
  db: ReturnType<typeof createDb>,
  companyId: string,
  input: { title: string; workflowKey?: string | null; capabilities?: string[] },
) {
  const workflowId = randomUUID();
  await db.insert(workflows).values({
    id: workflowId,
    companyId,
    title: input.title,
    workflowKey: input.workflowKey ?? null,
    capabilities: input.capabilities ?? [],
    status: "active",
    runnerType: "google_adk",
    runnerConfig: { agentPath: "/tmp/agent.py" },
    pipelineDefinition: { entrypoint: "agent.py", generatedAt: new Date(0).toISOString(), phases: [] },
    pipelineSourceHash: null,
  });
  return workflowId;
}

describeEmbeddedPostgres("workflow invocation bridge", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-invocations-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(workflowInvocations);
    await db.delete(workflowRuns);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(workflows);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves workflows by id, key, and capability while rejecting ambiguous targets", async () => {
    const companyId = await seedCompany(db);
    const workflowId = await seedWorkflow(db, companyId, {
      title: "Brief generator",
      workflowKey: "brief-generator",
      capabilities: ["briefing"],
    });
    const otherWorkflowId = await seedWorkflow(db, companyId, {
      title: "Brief reviewer",
      workflowKey: "brief-reviewer",
      capabilities: ["review"],
    });
    const otherCompanyId = await seedCompany(db, "Other company");
    const otherCompanyWorkflowId = await seedWorkflow(db, otherCompanyId, {
      title: "Foreign",
      workflowKey: "foreign-workflow",
      capabilities: ["briefing"],
    });

    await expect(resolveWorkflowByInvocationTarget(db, companyId, {
      workflowId,
    })).resolves.toMatchObject({ id: workflowId });
    await expect(resolveWorkflowByInvocationTarget(db, companyId, {
      workflowKey: "brief-generator",
    })).resolves.toMatchObject({ id: workflowId });
    await expect(resolveWorkflowByInvocationTarget(db, companyId, {
      capability: "briefing",
    })).resolves.toMatchObject({ id: workflowId });
    await expect(resolveWorkflowByInvocationTarget(db, companyId, {
      workflowId: otherCompanyWorkflowId,
    })).rejects.toThrow(/not found for this company/i);
    await expect(resolveWorkflowByInvocationTarget(db, companyId, {
      capability: "missing-capability",
    })).rejects.toThrow(/no workflow matches/i);
    await seedWorkflow(db, companyId, {
      title: "Duplicate capability",
      workflowKey: "duplicate-capability",
      capabilities: ["briefing"],
    });
    await expect(resolveWorkflowByInvocationTarget(db, companyId, {
      capability: "briefing",
    })).rejects.toThrow(/ambiguous/i);
  });

  it("records markdown invocations and links them to a workflow run", async () => {
    const companyId = await seedCompany(db);
    const { routineId, routineRunId } = await seedRoutine(db, companyId);
    const workflowId = await seedWorkflow(db, companyId, {
      title: "Brief generator",
      workflowKey: "brief-generator",
      capabilities: ["briefing"],
    });

    const result = await workflowInvocationService(db).invokeFromRoutine({
      routineId,
      sourceRoutineRunId: routineRunId,
      envelope: {
        contractVersion: "workflow-invocation/v1",
        target: { workflowId },
        payload: {
          kind: "markdown",
          inputMarkdown: "Generate a short brief.",
        },
      },
    });

    await vi.waitFor(async () => {
      const updated = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.workflowRunId ?? "")).then((rows) => rows[0] ?? null);
      expect(updated?.status).toBe("succeeded");
    }, 10_000);

    const invocationRow = await db.select().from(workflowInvocations).where(eq(workflowInvocations.id, result.id)).then((rows) => rows[0] ?? null);
    expect(invocationRow).toMatchObject({
      status: "linked",
      inputKind: "markdown",
      inputMarkdown: "Generate a short brief.",
      targetWorkflowId: workflowId,
      workflowRunId: result.workflowRunId,
    });

    const run = await workflowService(db).getRunDetail(result.workflowRunId!);
    expect(run?.invocation).toMatchObject({
      contractVersion: "workflow-invocation/v1",
      inputKind: "markdown",
      sourceRoutineId: routineId,
      sourceRoutineRunId: routineRunId,
      targetWorkflowId: workflowId,
      targetWorkflowKey: "brief-generator",
      targetCapability: null,
    });
    expect(run?.contextSnapshot).toMatchObject({
      invocation: {
        contractVersion: "workflow-invocation/v1",
        inputKind: "markdown",
        sourceRoutineId: routineId,
        sourceRoutineRunId: routineRunId,
      },
    });
  });

  it("records structured json invocations while keeping markdown compatibility", async () => {
    const companyId = await seedCompany(db);
    const { routineId, routineRunId } = await seedRoutine(db, companyId);
    const workflowId = await seedWorkflow(db, companyId, {
      title: "JSON workflow",
      workflowKey: "json-workflow",
      capabilities: ["structured-input"],
    });

    const result = await workflowInvocationService(db).invokeFromRoutine({
      routineId,
      sourceRoutineRunId: routineRunId,
      envelope: {
        contractVersion: "workflow-invocation/v1",
        target: { workflowKey: "json-workflow" },
        payload: {
          kind: "json",
          inputJson: {
            title: "A structured brief",
            priority: "high",
          },
        },
      },
    });

    await vi.waitFor(async () => {
      const updated = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.workflowRunId ?? "")).then((rows) => rows[0] ?? null);
      expect(updated?.status).toBe("succeeded");
    }, 10_000);

    const invocationRow = await db.select().from(workflowInvocations).where(eq(workflowInvocations.id, result.id)).then((rows) => rows[0] ?? null);
    expect(invocationRow).toMatchObject({
      status: "linked",
      inputKind: "json",
      inputJson: {
        title: "A structured brief",
        priority: "high",
      },
      workflowRunId: result.workflowRunId,
    });

    const run = await workflowService(db).getRunDetail(result.workflowRunId!);
    expect(run?.inputMarkdown).toContain("Structured JSON");
    expect(run?.inputMarkdown).toContain('"title": "A structured brief"');
    expect(run?.invocation).toMatchObject({
      contractVersion: "workflow-invocation/v1",
      inputKind: "json",
      sourceRoutineId: routineId,
      sourceRoutineRunId: routineRunId,
      targetWorkflowId: workflowId,
      targetWorkflowKey: "json-workflow",
    });
    expect(run?.contextSnapshot).toMatchObject({
      invocation: {
        inputJson: {
          title: "A structured brief",
          priority: "high",
        },
      },
    });
  });
});
