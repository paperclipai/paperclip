import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const companyId = "company-1";

function seedIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date("2026-04-16T12:00:00.000Z");
  return {
    id: "issue-1",
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Audit and Clean 1Password Vault Entries",
    description: "Validate credentials and clean stale entries.",
    status: "in_progress",
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 309,
    identifier: "JHJ-309",
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
    ...overrides,
  };
}

describe("plugin-linear-sync outbound create", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates and links a Linear issue when a Paperclip issue is created", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "issue.comments.read"],
      config: {
        linearApiKey: "env:LINEAR_API_KEY",
        teamId: "team-1",
        enableOutboundSync: true,
      },
    });

    harness.seed({
      companies: [{
        id: companyId,
        name: "JHJ",
        slug: "jhj",
        description: null,
        goals: null,
        defaultProjectId: null,
        createdAt: new Date("2026-04-16T12:00:00.000Z"),
        updatedAt: new Date("2026-04-16T12:00:00.000Z"),
      }],
      issues: [seedIssue()],
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "linear-uuid-1",
              identifier: "DAN-999",
              title: "[JHJ-309] Audit and Clean 1Password Vault Entries",
              description: "stub",
              priority: 2,
              state: { name: "In Progress" },
              labels: { nodes: [] },
              assignee: null,
              createdAt: "2026-04-16T12:00:00.000Z",
              updatedAt: "2026-04-16T12:00:00.000Z",
              url: "https://linear.app/dizhaky/issue/DAN-999/test",
            },
          },
        },
      }), { status: 200 }),
    );

    await plugin.definition.setup(harness.ctx);
    await harness.emit("issue.created", { id: "issue-1" }, {
      companyId,
      entityId: "issue-1",
      entityType: "issue",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.linear.app/graphql");
    expect(String((init as RequestInit).body)).toContain("issueCreate");
    expect(String((init as RequestInit).body)).toContain("[JHJ-309] Audit and Clean 1Password Vault Entries");

    expect(
      harness.getState({ scopeKind: "issue", scopeId: "issue-1", stateKey: "linear-id" }),
    ).toBe("DAN-999");

    const linkedEntities = await harness.ctx.entities.list({
      entityType: "linear-issue",
      externalId: "DAN-999",
    });
    expect(linkedEntities).toHaveLength(1);
    expect(linkedEntities[0]?.data).toMatchObject({
      paperclipIssueId: "issue-1",
      paperclipIdentifier: "JHJ-309",
      linearIdentifier: "DAN-999",
    });

    const comments = await harness.ctx.issues.listComments("issue-1", companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("DAN-999");
  });
});
