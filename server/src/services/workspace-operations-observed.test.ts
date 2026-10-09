import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  workspaceOperationService,
} from "../services/workspace-operations.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping observed workspace-operation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("observed (adapter-reported) workspace operations", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-observed-workspace-ops-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Observed tool operations",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedExecutionWorkspaceAndRun(companyId: string) {
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Observed tool operations",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Observed tool calls workspace",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });
    return { executionWorkspaceId, runId };
  }

  it("records an observed tool call with run binding and no log store handle", async () => {
    const companyId = await seedCompany();
    const service = workspaceOperationService(db);
    const { executionWorkspaceId, runId } = await seedExecutionWorkspaceAndRun(companyId);
    const issueId = null;

    const id = await service.recordObservedOperation({
      companyId,
      heartbeatRunId: runId,
      issueId,
      executionWorkspaceId,
      phase: "provider_tool_execution",
      command: "bash",
      metadata: { toolName: "Terminal", toolCallId: "call_1", source: "adapter_runtime_event" },
      observedStatus: "running",
    });

    const [row] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, id));
    expect(row).toMatchObject({
      companyId,
      heartbeatRunId: runId,
      issueId,
      executionWorkspaceId,
      phase: "provider_tool_execution",
      command: "bash",
      status: "running",
      logStore: null,
      logRef: null,
    });
    expect(row?.finishedAt).toBeNull();
    expect((row?.metadata as Record<string, unknown>).toolCallId).toBe("call_1");
  });

  it("settles a running observed operation once and ignores later settles", async () => {
    const companyId = await seedCompany();
    const service = workspaceOperationService(db);
    const id = await service.recordObservedOperation({
      companyId,
      phase: "provider_tool_execution",
      metadata: { toolCallId: "call_2" },
      observedStatus: "running",
    });

    await expect(
      service.settleObservedOperation({ companyId, id, status: "succeeded" }),
    ).resolves.toBe(true);
    const [row] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, id));
    expect(row?.status).toBe("succeeded");
    expect(row?.finishedAt).not.toBeNull();

    await expect(
      service.settleObservedOperation({ companyId, id, status: "failed" }),
    ).resolves.toBe(false);
    const [stillSucceeded] = await db
      .select()
      .from(workspaceOperations)
      .where(and(eq(workspaceOperations.id, id), eq(workspaceOperations.status, "succeeded")));
    expect(stillSucceeded).toBeDefined();
  });

  it("records a directly terminal observed operation and returns false for unknown ids", async () => {
    const companyId = await seedCompany();
    const service = workspaceOperationService(db);
    const id = await service.recordObservedOperation({
      companyId,
      phase: "provider_tool_execution",
      metadata: { toolCallId: "call_3" },
      observedStatus: "failed",
    });
    const [row] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, id));
    expect(row?.status).toBe("failed");
    expect(row?.finishedAt).not.toBeNull();

    await expect(
      service.settleObservedOperation({ companyId, id: randomUUID(), status: "succeeded" }),
    ).resolves.toBe(false);
  });
});
