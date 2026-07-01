import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const GITHUB_PLUGIN_ID = "github";
const GITHUB_PLUGIN_DB_ID = "00000000-0000-4000-8000-000000000123";
const GITHUB_MANIFEST: PaperclipPluginManifestV1 = {
  id: GITHUB_PLUGIN_ID,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "GitHub",
  description: "Test fixture",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
  tools: [
    {
      name: "create_pull_request",
      displayName: "Create pull request",
      description: "Create a PR",
      parametersSchema: { type: "object", properties: {} },
    },
  ],
} as unknown as PaperclipPluginManifestV1;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin publish guard dispatcher tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin tool dispatcher publish guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-publish-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows github.create_pull_request only when the destination matches the issue execution workspace repo", async () => {
    const fixture = await seedFixture({
      executionWorkspaceRepoUrl: "https://github.com/acme/allowed-repo.git",
      projectWorkspaceRepoUrl: "https://github.com/acme/project-repo.git",
    });
    const workerManager = createWorkerManager();
    const dispatcher = createPluginToolDispatcher({ workerManager, db });
    dispatcher.registerPluginTools(GITHUB_PLUGIN_ID, GITHUB_MANIFEST, GITHUB_PLUGIN_DB_ID);

    await expect(
      dispatcher.executeTool(
        "github:create_pull_request",
        {
          repository_full_name: "acme/allowed-repo",
          head_branch: "feature/publish-guard",
          base_branch: "main",
          title: "test",
        },
        fixture.runContext,
      ),
    ).resolves.toEqual(expect.objectContaining({ pluginId: "github", toolName: "create_pull_request" }));

    expect(workerManager.call).toHaveBeenCalledOnce();
  });

  it("blocks github.create_pull_request when the repository differs from the authorized workspace repo", async () => {
    const fixture = await seedFixture({
      executionWorkspaceRepoUrl: "https://github.com/acme/allowed-repo.git",
      projectWorkspaceRepoUrl: "https://github.com/acme/project-repo.git",
    });
    const workerManager = createWorkerManager();
    const dispatcher = createPluginToolDispatcher({ workerManager, db });
    dispatcher.registerPluginTools(GITHUB_PLUGIN_ID, GITHUB_MANIFEST, GITHUB_PLUGIN_DB_ID);

    await expect(
      dispatcher.executeTool(
        "github:create_pull_request",
        {
          repository_full_name: "acme/forbidden-repo",
          head_branch: "feature/publish-guard",
          base_branch: "main",
          title: "test",
        },
        fixture.runContext,
      ),
    ).rejects.toThrow(/Blocked GitHub publish tool "github[:.]create_pull_request"/);

    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("fails closed when the connector request omits repository_full_name", async () => {
    const fixture = await seedFixture({
      executionWorkspaceRepoUrl: "https://github.com/acme/allowed-repo.git",
      projectWorkspaceRepoUrl: "https://github.com/acme/project-repo.git",
    });
    const workerManager = createWorkerManager();
    const dispatcher = createPluginToolDispatcher({ workerManager, db });
    dispatcher.registerPluginTools(GITHUB_PLUGIN_ID, GITHUB_MANIFEST, GITHUB_PLUGIN_DB_ID);

    await expect(
      dispatcher.executeTool(
        "github:create_pull_request",
        {
          head_branch: "feature/publish-guard",
          base_branch: "main",
          title: "test",
        },
        fixture.runContext,
      ),
    ).rejects.toThrow(/missing required repository_full_name target/);

    expect(workerManager.call).not.toHaveBeenCalled();
  });

  async function seedFixture(input: {
    executionWorkspaceRepoUrl: string;
    projectWorkspaceRepoUrl: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Publish Guard",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "git_repo",
      repoUrl: input.projectWorkspaceRepoUrl,
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue workspace",
      status: "active",
      repoUrl: input.executionWorkspaceRepoUrl,
      providerType: "git_worktree",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      title: "Protect publish",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      identifier: "TST-1",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        projectId,
      },
    });

    return {
      runContext: {
        agentId,
        runId,
        companyId,
        projectId,
      },
    };
  }
});

function createWorkerManager(): PluginWorkerManager & {
  call: ReturnType<typeof vi.fn>;
} {
  const isRunning = vi.fn((id: string) => id === GITHUB_PLUGIN_DB_ID);
  const call = vi.fn(async () => ({ content: "ok" }));
  return {
    startWorker: vi.fn(),
    stopWorker: vi.fn(),
    getWorker: vi.fn(),
    isRunning,
    stopAll: vi.fn(),
    diagnostics: vi.fn(() => []),
    call,
  } as unknown as PluginWorkerManager & { call: ReturnType<typeof vi.fn> };
}
