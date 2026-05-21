import { describe, expect, it } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";
import {
  countActiveAgentsInWindow,
  countFactoryManagementIssues,
  getLatestCompletedCycleIssue,
} from "./FactoryHealthBadge";

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    title: "Issue",
    status: "todo",
    ...overrides,
  } as unknown as Issue;
}

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    urlKey: "agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("FactoryHealthBadge helpers", () => {
  it("counts open FM issues from title pattern", () => {
    const count = countFactoryManagementIssues([
      issue({ title: "FM12: investigate queue" }),
      issue({ title: "factory/fm007 spike" }),
      issue({ title: "unrelated issue" }),
    ]);
    expect(count).toBe(2);
  });

  it("selects latest completed cycle run from sorted issues", () => {
    const result = getLatestCompletedCycleIssue([
      issue({ id: "a", title: "Cycle Run #124", status: "in_progress" }),
      issue({ id: "b", title: "Cycle Run #123A", status: "done" }),
      issue({ id: "c", title: "Cycle Run #123", status: "blocked" }),
      issue({ id: "d", title: "Cycle Run #122", status: "done" }),
    ]);
    expect(result?.id).toBe("c");
  });

  it("counts distinct active non-board agents in the 15m window", () => {
    const now = Date.parse("2026-05-21T14:00:00.000Z");
    const count = countActiveAgentsInWindow(
      [
        { actorType: "agent", actorId: "agent-a", createdAt: "2026-05-21T13:58:00.000Z" },
        { actorType: "agent", actorId: "agent-a", createdAt: "2026-05-21T13:57:00.000Z" },
        { actorType: "agent", actorId: "board-agent", createdAt: "2026-05-21T13:59:00.000Z" },
        { actorType: "agent", actorId: "agent-old", createdAt: "2026-05-21T13:00:00.000Z" },
        { actorType: "user", actorId: "person-1", createdAt: "2026-05-21T13:59:00.000Z" },
      ],
      [agent({ id: "board-agent", metadata: { agentType: "local-board" } })],
      now,
    );
    expect(count).toBe(1);
  });
});
