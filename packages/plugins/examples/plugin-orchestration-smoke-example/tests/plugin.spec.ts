import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema, type Issue } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function issue(input: Partial<Issue> & Pick<Issue, "id" | "companyId" | "title">): Issue {
  const now = new Date();
  const { id, companyId, title, ...rest } = input;
  return {
    id,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

describe("orchestration smoke plugin", () => {
  it("declares the Phase 1 orchestration surfaces", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "paperclipai.plugin-orchestration-smoke-example",
      database: {
        migrationsDir: "migrations",
        coreReadTables: ["issues"],
      },
      apiRoutes: [
        expect.objectContaining({ routeKey: "initialize" }),
        expect.objectContaining({ routeKey: "summary" }),
      ],
    });
  });

  it("creates plugin-owned orchestration rows, issue tree, document, wakeup, and summary reads", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const agentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: rootIssueId,
          companyId,
          title: "Root orchestration issue",
          assigneeAgentId: agentId,
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<{
      rootIssueId: string;
      childIssueId: string;
      blockerIssueId: string;
      billingCode: string;
      subtreeIssueIds: string[];
      wakeupQueued: boolean;
    }>("initialize-smoke", {
      companyId,
      issueId: rootIssueId,
      assigneeAgentId: agentId,
    });

    expect(result.rootIssueId).toBe(rootIssueId);
    expect(result.childIssueId).toEqual(expect.any(String));
    expect(result.blockerIssueId).toEqual(expect.any(String));
    expect(result.billingCode).toBe(`plugin-smoke:${rootIssueId}`);
    expect(result.wakeupQueued).toBe(true);
    expect(result.subtreeIssueIds).toEqual(expect.arrayContaining([rootIssueId, result.childIssueId]));
    expect(harness.dbExecutes[0]?.sql).toContain(".smoke_runs");
    expect(harness.dbQueries.some((entry) => entry.sql.includes("JOIN public.issues"))).toBe(true);

    const relations = await harness.ctx.issues.relations.get(result.childIssueId, companyId);
    expect(relations.blockedBy).toEqual([
      expect.objectContaining({
        id: result.blockerIssueId,
        status: "done",
      }),
    ]);
    const docs = await harness.ctx.issues.documents.list(result.childIssueId, companyId);
    expect(docs).toEqual([
      expect.objectContaining({
        key: "orchestration-smoke",
        title: "Orchestration Smoke",
      }),
    ]);
  });

  it("dispatches the scoped API route through the same smoke path", async () => {
    const companyId = randomUUID();
    const rootIssueId = randomUUID();
    const agentId = randomUUID();
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [
        issue({
          id: rootIssueId,
          companyId,
          title: "Scoped API root",
          assigneeAgentId: agentId,
        }),
      ],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(plugin.definition.onApiRequest?.({
      routeKey: "initialize",
      method: "POST",
      path: `/issues/${rootIssueId}/smoke`,
      params: { issueId: rootIssueId },
      query: {},
      body: { assigneeAgentId: agentId },
      actor: {
        actorType: "user",
        actorId: "board",
        userId: "board",
        agentId: null,
        runId: null,
      },
      companyId,
      headers: {},
    })).resolves.toMatchObject({
      status: 201,
      body: expect.objectContaining({
        rootIssueId,
        wakeupQueued: true,
      }),
    });
  });
});
