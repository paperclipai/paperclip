import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, workflows } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockGetStorageService = vi.hoisted(() => vi.fn(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
})));
const mockAnalyzeWorkflowProject = vi.hoisted(() => vi.fn(async () => {
  throw new Error("workflow analysis should not run for prompt template updates");
}));

vi.mock("../storage/index.js", () => ({
  getStorageService: mockGetStorageService,
}));

vi.mock("../services/workflows-runtime.js", () => ({
  analyzeWorkflowProject: mockAnalyzeWorkflowProject,
  prepareInstrumentedWorkflowRuntime: vi.fn(),
  collectWorkflowRuntimeArtifacts: vi.fn(),
}));

vi.mock("@paperclipai/adapter-google-adk/server", () => ({
  invokeGoogleAdk: vi.fn(),
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
    `Skipping embedded Postgres workflow service update tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workflowService.update", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-service-update-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(workflows);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("preserves existing runner config fields when prompt templates change", async () => {
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
      runnerConfig: {
        agentPath: "/tmp/agent.py",
        cwd: "/tmp/workspace",
        command: "python run.py",
        model: "gemini-2.5-pro",
        customFlag: "keep-me",
      },
      pipelineDefinition: {
        entrypoint: "agent.py",
        generatedAt: new Date(0).toISOString(),
        phases: [],
      },
      pipelineSourceHash: "hash-1",
    });

    const svc = workflowService(db);
    const updated = await svc.update(
      workflowId,
      {
        runnerConfig: {
          promptTemplates: [
            {
              label: "Summarize",
              promptMarkdown: "Summarize the workflow input.",
            },
          ],
        },
      },
      { userId: "board-user" },
    );

    expect(mockAnalyzeWorkflowProject).not.toHaveBeenCalled();
    expect(updated?.runnerConfig).toMatchObject({
      agentPath: "/tmp/agent.py",
      cwd: "/tmp/workspace",
      command: "python run.py",
      model: "gemini-2.5-pro",
      customFlag: "keep-me",
      promptTemplates: [
        {
          label: "Summarize",
          promptMarkdown: "Summarize the workflow input.",
        },
      ],
    });

    const reloaded = await svc.get(workflowId);
    expect(reloaded?.runnerConfig).toMatchObject({
      agentPath: "/tmp/agent.py",
      cwd: "/tmp/workspace",
      command: "python run.py",
      model: "gemini-2.5-pro",
      customFlag: "keep-me",
      promptTemplates: [
        {
          label: "Summarize",
          promptMarkdown: "Summarize the workflow input.",
        },
      ],
    });
  });
});
