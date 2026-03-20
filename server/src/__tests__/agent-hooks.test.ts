import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockIssueService = vi.hoisted(() => ({
  update: vi.fn(),
}));
const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
}));

const { runAgentHooksForEvent } = await import("../services/agent-hooks.js");

type AgentRow = typeof agents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

function buildAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: "agent-source",
    companyId: "company-1",
    name: "Benchmark Worker",
    role: "engineer",
    title: "Benchmark Worker",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    pauseReason: null,
    pausedAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as AgentRow;
}

function buildIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    id: "issue-1",
    companyId: "company-1",
    issueNumber: 1,
    identifier: "PAP-1",
    title: "Benchmark issue",
    description: null,
    status: "todo",
    priority: "medium",
    goalId: null,
    projectId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionLockedAt: null,
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    assigneeAdapterOverrides: null,
    issueType: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as IssueRow;
}

function createDbMock(input: {
  sourceAgent: AgentRow;
  directoryAgents?: AgentRow[];
  issuesById?: Record<string, IssueRow>;
}): Db {
  let agentSelectCount = 0;

  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === agents) {
            agentSelectCount += 1;
            return Promise.resolve(
              agentSelectCount === 1
                ? [input.sourceAgent]
                : (input.directoryAgents ?? [input.sourceAgent]),
            );
          }
          if (table === issues) {
            return Promise.resolve(Object.values(input.issuesById ?? {}));
          }
          return Promise.resolve([]);
        },
      }),
    }),
  } as unknown as Db;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLogActivity.mockResolvedValue(undefined);
  mockIssueService.update.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mockLogger.info.mockReset();
  mockLogger.debug.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runAgentHooksForEvent", () => {
  it("wakes allow-listed target agents when a matching run succeeds", async () => {
    const sourceAgent = buildAgent({
      runtimeConfig: {
        hooks: {
          enabled: true,
          permissions: {
            allowedAgentRefs: ["CTO"],
          },
          rules: [
            {
              id: "benchmark-finished",
              event: "heartbeat.run.succeeded",
              match: {
                "run.contextSnapshot.workflow": "benchmark",
              },
              actions: [
                {
                  type: "wake_agent",
                  agentRefs: ["CTO"],
                  reason: "benchmark_finished",
                  payload: {
                    issueId: "{{event.issueId}}",
                    sourceRunId: "{{run.id}}",
                    completedBy: "{{agent.name}}",
                  },
                  contextSnapshot: {
                    issueId: "{{event.issueId}}",
                    workflow: "{{run.contextSnapshot.workflow}}",
                  },
                  forceFreshSession: true,
                },
              ],
            },
          ],
        },
      },
    });
    const targetAgent = buildAgent({
      id: "agent-cto",
      name: "CTO",
      role: "cto",
      title: "CTO",
    });
    const wakeAgent = vi.fn().mockResolvedValue(undefined);
    const db = createDbMock({
      sourceAgent,
      directoryAgents: [sourceAgent, targetAgent],
    });

    await runAgentHooksForEvent(
      db,
      {
        eventType: "heartbeat.run.succeeded",
        companyId: "company-1",
        sourceAgentId: sourceAgent.id,
        issueId: "issue-123",
        run: {
          id: "run-1",
          status: "succeeded",
          invocationSource: "automation",
          triggerDetail: "callback",
          contextSnapshot: {
            workflow: "benchmark",
            issueId: "issue-123",
          },
          usageJson: null,
          resultJson: null,
        },
      },
      { wakeAgent },
    );

    expect(wakeAgent).toHaveBeenCalledTimes(1);
    expect(wakeAgent).toHaveBeenCalledWith(
      "agent-cto",
      expect.objectContaining({
        source: "automation",
        triggerDetail: "callback",
        reason: "benchmark_finished",
        payload: {
          issueId: "issue-123",
          sourceRunId: "run-1",
          completedBy: "Benchmark Worker",
        },
        contextSnapshot: {
          issueId: "issue-123",
          workflow: "benchmark",
          forceFreshSession: true,
        },
        requestedByActorType: "system",
        requestedByActorId: "agent_hook:agent-source:benchmark-finished:0",
        idempotencyKey: "hook:run-1:benchmark-finished:0:agent-cto",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_hook.wake_requested",
        entityId: "agent-cto",
        details: expect.objectContaining({
          ruleId: "benchmark-finished",
          targetAgentId: "agent-cto",
          reason: "benchmark_finished",
        }),
      }),
    );
  });

  it("denies command hooks unless allowCommand is enabled", async () => {
    const sourceAgent = buildAgent({
      runtimeConfig: {
        hooks: {
          enabled: true,
          permissions: {
            allowCommand: false,
          },
          rules: [
            {
              id: "run-local-script",
              event: "heartbeat.run.finished",
              actions: [
                {
                  type: "command",
                  command: "./scripts/post-run.sh",
                },
              ],
            },
          ],
        },
      },
    });
    const db = createDbMock({ sourceAgent });

    await runAgentHooksForEvent(
      db,
      {
        eventType: "heartbeat.run.finished",
        companyId: "company-1",
        sourceAgentId: sourceAgent.id,
        run: {
          id: "run-2",
          status: "succeeded",
          invocationSource: "automation",
          triggerDetail: "callback",
          contextSnapshot: {},
        },
      },
      { wakeAgent: vi.fn().mockResolvedValue(undefined) },
    );

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_hook.permission_denied",
        details: expect.objectContaining({
          ruleId: "run-local-script",
          actionType: "command",
          reason: "hooks.permissions.allowCommand is false",
        }),
      }),
    );
  });

  it("posts webhooks with rendered payloads when enabled", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      text: vi.fn().mockResolvedValue("accepted"),
    } as any);

    const sourceAgent = buildAgent({
      runtimeConfig: {
        hooks: {
          enabled: true,
          permissions: {
            allowWebhook: true,
          },
          rules: [
            {
              id: "notify-api",
              event: "heartbeat.run.finished",
              actions: [
                {
                  type: "webhook",
                  url: "https://example.test/hooks/run-finished",
                  method: "POST",
                  headers: {
                    "x-hook-event": "{{event.name}}",
                  },
                  body: {
                    runId: "{{run.id}}",
                    status: "{{run.status}}",
                    issueId: "{{event.issueId}}",
                  },
                },
              ],
            },
          ],
        },
      },
    });
    const db = createDbMock({ sourceAgent });

    await runAgentHooksForEvent(
      db,
      {
        eventType: "heartbeat.run.finished",
        companyId: "company-1",
        sourceAgentId: sourceAgent.id,
        issueId: "issue-9",
        run: {
          id: "run-3",
          status: "failed",
          invocationSource: "automation",
          triggerDetail: "callback",
          contextSnapshot: {},
        },
      },
      { wakeAgent: vi.fn().mockResolvedValue(undefined) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/hooks/run-finished",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-hook-event": "heartbeat.run.finished",
        }),
        body: JSON.stringify({
          runId: "run-3",
          status: "failed",
          issueId: "issue-9",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_hook.webhook_succeeded",
        details: expect.objectContaining({
          ruleId: "notify-api",
          url: "https://example.test/hooks/run-finished",
          statusCode: 202,
        }),
      }),
    );
  });

  it("assigns the issue to an allow-listed agent and can wake them", async () => {
    const sourceAgent = buildAgent({
      runtimeConfig: {
        hooks: {
          enabled: true,
          permissions: {
            allowIssueAssignment: true,
            allowedAgentRefs: ["CTO"],
          },
          rules: [
            {
              id: "handoff-to-cto",
              event: "heartbeat.run.succeeded",
              actions: [
                {
                  type: "assign_issue",
                  agentRef: "CTO",
                  status: "in_review",
                  wakeAssignee: true,
                },
              ],
            },
          ],
        },
      },
    });
    const targetAgent = buildAgent({
      id: "agent-cto",
      name: "CTO",
      role: "cto",
      title: "CTO",
    });
    const issue = buildIssue({ id: "issue-77" });
    mockIssueService.update.mockResolvedValue({
      id: issue.id,
      companyId: issue.companyId,
    });
    const wakeAgent = vi.fn().mockResolvedValue(undefined);
    const db = createDbMock({
      sourceAgent,
      directoryAgents: [sourceAgent, targetAgent],
      issuesById: { [issue.id]: issue },
    });

    await runAgentHooksForEvent(
      db,
      {
        eventType: "heartbeat.run.succeeded",
        companyId: "company-1",
        sourceAgentId: sourceAgent.id,
        issueId: issue.id,
        run: {
          id: "run-4",
          status: "succeeded",
          invocationSource: "automation",
          triggerDetail: "callback",
          contextSnapshot: {
            issueId: issue.id,
          },
        },
      },
      { wakeAgent },
    );

    expect(mockIssueService.update).toHaveBeenCalledWith(issue.id, {
      assigneeAgentId: "agent-cto",
      status: "in_review",
    });
    expect(wakeAgent).toHaveBeenCalledWith(
      "agent-cto",
      expect.objectContaining({
        reason: "issue_assigned_by_hook",
        payload: {
          issueId: issue.id,
          mutation: "hook.assign_issue",
        },
        contextSnapshot: {
          issueId: issue.id,
          source: "agent_hook.assign_issue",
          wakeReason: "issue_assigned_by_hook",
        },
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_hook.issue_assigned",
        entityType: "issue",
        entityId: issue.id,
      }),
    );
  });

  it("refuses to wake the originating agent even when it is allow-listed", async () => {
    const sourceAgent = buildAgent({
      runtimeConfig: {
        hooks: {
          enabled: true,
          permissions: {
            allowedAgentRefs: ["Benchmark Worker"],
          },
          rules: [
            {
              id: "self-wake",
              event: "heartbeat.run.succeeded",
              actions: [
                {
                  type: "wake_agent",
                  agentRefs: ["Benchmark Worker"],
                },
              ],
            },
          ],
        },
      },
    });
    const wakeAgent = vi.fn().mockResolvedValue(undefined);
    const db = createDbMock({
      sourceAgent,
      directoryAgents: [sourceAgent],
    });

    await runAgentHooksForEvent(
      db,
      {
        eventType: "heartbeat.run.succeeded",
        companyId: "company-1",
        sourceAgentId: sourceAgent.id,
        run: {
          id: "run-5",
          status: "succeeded",
          invocationSource: "automation",
          triggerDetail: "callback",
          contextSnapshot: {},
        },
      },
      { wakeAgent },
    );

    expect(wakeAgent).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_hook.permission_denied",
        details: expect.objectContaining({
          ruleId: "self-wake",
          actionType: "wake_agent",
          reason: "Hooks cannot wake the originating agent",
        }),
      }),
    );
  });

  it("refuses to assign issues back to the originating agent", async () => {
    const sourceAgent = buildAgent({
      runtimeConfig: {
        hooks: {
          enabled: true,
          permissions: {
            allowIssueAssignment: true,
            allowedAgentRefs: ["Benchmark Worker"],
          },
          rules: [
            {
              id: "self-assign",
              event: "heartbeat.run.succeeded",
              actions: [
                {
                  type: "assign_issue",
                  agentRef: "Benchmark Worker",
                },
              ],
            },
          ],
        },
      },
    });
    const issue = buildIssue({ id: "issue-88" });
    const db = createDbMock({
      sourceAgent,
      directoryAgents: [sourceAgent],
      issuesById: { [issue.id]: issue },
    });

    await runAgentHooksForEvent(
      db,
      {
        eventType: "heartbeat.run.succeeded",
        companyId: "company-1",
        sourceAgentId: sourceAgent.id,
        issueId: issue.id,
        run: {
          id: "run-6",
          status: "succeeded",
          invocationSource: "automation",
          triggerDetail: "callback",
          contextSnapshot: {
            issueId: issue.id,
          },
        },
      },
      { wakeAgent: vi.fn().mockResolvedValue(undefined) },
    );

    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent_hook.permission_denied",
        details: expect.objectContaining({
          ruleId: "self-assign",
          actionType: "assign_issue",
          reason: "Hooks cannot assign issues back to the originating agent",
        }),
      }),
    );
  });
});
