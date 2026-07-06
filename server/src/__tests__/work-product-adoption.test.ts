import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { adoptWorkProductsForRun } from "../services/work-product-adoption.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres work product adoption tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("work product adoption", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  const projectId = "33333333-3333-4333-8333-333333333333";
  const issueId = "44444444-4444-4444-8444-444444444444";
  const runId = "55555555-5555-4555-8555-555555555555";
  const executionWorkspaceId = "66666666-6666-4666-8666-666666666666";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-work-product-adoption-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(workspaceRuntimeServices);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBase() {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runtime",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "PAP-11218",
      cwd: "/workspace/paperclip",
      repoUrl: "https://github.com/paperclipai/paperclip",
      branchName: "pap-11218-work-products",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      identifier: "PAP-11218",
      title: "Drive work-product adoption",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
  }

  it("adopts managed runtime services as durable work products idempotently", async () => {
    await seedBase();
    const runtimeServiceId = "77777777-7777-4777-8777-777777777777";
    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      companyId,
      projectId,
      executionWorkspaceId,
      issueId,
      scopeType: "execution_workspace",
      scopeId: executionWorkspaceId,
      serviceName: "preview",
      status: "running",
      lifecycle: "ephemeral",
      url: "https://preview.example.com/",
      provider: "local_process",
      ownerAgentId: agentId,
      startedByRunId: runId,
      healthStatus: "healthy",
    });

    const runtimeService = {
      id: runtimeServiceId,
      companyId,
      projectId,
      projectWorkspaceId: null,
      executionWorkspaceId,
      issueId,
      serviceName: "preview",
      status: "running",
      lifecycle: "ephemeral",
      scopeType: "execution_workspace",
      scopeId: executionWorkspaceId,
      reuseKey: null,
      command: "pnpm dev",
      cwd: "/workspace/paperclip",
      port: 3100,
      url: "https://preview.example.com/",
      provider: "local_process",
      providerRef: null,
      ownerAgentId: agentId,
      startedByRunId: runId,
      lastUsedAt: "2026-07-01T20:00:00.000Z",
      startedAt: "2026-07-01T20:00:00.000Z",
      stoppedAt: null,
      stopPolicy: null,
      healthStatus: "healthy",
      reused: false,
    } as const;

    await expect(adoptWorkProductsForRun({
      db,
      companyId,
      issueId,
      runId,
      projectId,
      executionWorkspaceId,
      runtimeServices: [runtimeService],
    })).resolves.toEqual({ created: 1, updated: 0, skipped: 0 });
    await expect(adoptWorkProductsForRun({
      db,
      companyId,
      issueId,
      runId,
      projectId,
      executionWorkspaceId,
      runtimeServices: [runtimeService],
    })).resolves.toEqual({ created: 0, updated: 1, skipped: 0 });

    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "runtime_service",
      provider: "paperclip",
      externalId: runtimeServiceId,
      url: "https://preview.example.com/",
      runtimeServiceId,
      executionWorkspaceId,
      projectId,
      createdByRunId: runId,
      healthStatus: "healthy",
    });
  });

  it("adopts PR, preview, artifact, branch, and commit metadata from final result JSON", async () => {
    await seedBase();

    await expect(adoptWorkProductsForRun({
      db,
      companyId,
      issueId,
      runId,
      projectId,
      executionWorkspaceId,
      workspace: {
        cwd: "/workspace/paperclip",
        repoUrl: "https://github.com/paperclipai/paperclip",
        branchName: "pap-11218-work-products",
      },
      resultJson: {
        pullRequestUrl: "https://github.com/paperclipai/paperclip/pull/11218",
        previewUrls: ["https://pap-11218.example.com"],
        commit: {
          sha: "abcdef1234567890abcdef1234567890abcdef12",
          url: "https://github.com/paperclipai/paperclip/commit/abcdef1234567890abcdef1234567890abcdef12",
          message: "Drive work-product adoption",
        },
        artifacts: [{
          title: "Smoke report",
          url: "https://artifacts.example.com/smoke.html",
        }],
      },
    })).resolves.toEqual({ created: 5, updated: 0, skipped: 0 });

    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(rows.map((row) => row.type).sort()).toEqual(["artifact", "branch", "commit", "preview_url", "pull_request"]);
    expect(rows.find((row) => row.type === "pull_request")).toMatchObject({
      provider: "github",
      externalId: "paperclipai/paperclip#11218",
      status: "ready_for_review",
      reviewState: "needs_board_review",
      isPrimary: true,
    });
    expect(rows.find((row) => row.type === "preview_url")).toMatchObject({
      url: "https://pap-11218.example.com/",
      status: "active",
      isPrimary: true,
    });
    expect(rows.find((row) => row.type === "branch")).toMatchObject({
      provider: "git",
      externalId: "https://github.com/paperclipai/paperclip#pap-11218-work-products",
    });
    expect(rows.find((row) => row.type === "commit")).toMatchObject({
      provider: "github",
      externalId: "abcdef1234567890abcdef1234567890abcdef12",
      summary: "Drive work-product adoption",
    });
    expect(rows.find((row) => row.type === "artifact")).toMatchObject({
      provider: "custom",
      title: "Smoke report",
      url: "https://artifacts.example.com/smoke.html",
      status: "ready_for_review",
      reviewState: "needs_board_review",
    });
  });

  it("deduplicates concurrent adoption for the same external work product", async () => {
    await seedBase();

    const input = {
      db,
      companyId,
      issueId,
      runId,
      projectId,
      executionWorkspaceId,
      resultJson: {
        pullRequestUrl: "https://github.com/paperclipai/paperclip/pull/11218",
      },
    };

    await Promise.all([
      adoptWorkProductsForRun(input),
      adoptWorkProductsForRun(input),
    ]);

    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "pull_request",
      provider: "github",
      externalId: "paperclipai/paperclip#11218",
      isPrimary: true,
    });
  });
});
