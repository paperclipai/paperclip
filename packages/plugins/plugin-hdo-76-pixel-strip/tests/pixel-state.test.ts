/**
 * Tests use Node's built-in `node:test` runner so we do not depend on
 * the workspace vitest (which is currently broken in this environment
 * — see the issue summary on the parent ticket). The functions under
 * test are pure and have no external dependencies.
 */

import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  buildPixelStrip,
  deriveSpriteStateForAgent,
  deriveSpriteStateFromIssue,
  spriteStateLabel,
  type AgentRuntimeSnapshot,
  type IssueRuntimeSnapshot,
  type PixelSpriteState,
  type ProjectIssueIndex,
} from "../src/pixel-state.ts";

function issue(
  id: string,
  partial: Partial<IssueRuntimeSnapshot> = {},
): IssueRuntimeSnapshot {
  return {
    id,
    status: partial.status ?? "todo",
    assigneeAgentId: partial.assigneeAgentId ?? null,
    hasActiveHeartbeat: partial.hasActiveHeartbeat ?? false,
    pendingInteraction: partial.pendingInteraction ?? null,
    ...partial,
  };
}

function agent(
  id: string,
  partial: Partial<AgentRuntimeSnapshot> = {},
): AgentRuntimeSnapshot {
  return {
    id,
    displayName: partial.displayName ?? id,
    heartbeatStatus: partial.heartbeatStatus ?? "idle",
  };
}

describe("deriveSpriteStateFromIssue", () => {
  it("returns idle for done issues", () => {
    strictEqual(
      deriveSpriteStateFromIssue(issue("i1", { status: "done", hasActiveHeartbeat: true })),
      "idle",
    );
  });

  it("returns idle for cancelled issues", () => {
    strictEqual(deriveSpriteStateFromIssue(issue("i1", { status: "cancelled" })), "idle");
  });

  it("returns decision_ready when a request_confirmation is pending", () => {
    strictEqual(
      deriveSpriteStateFromIssue(
        issue("i1", {
          status: "in_review",
          pendingInteraction: "request_confirmation",
          hasActiveHeartbeat: true,
        }),
      ),
      "decision_ready",
    );
  });

  it("returns decision_ready when an ask_user_questions is pending", () => {
    strictEqual(
      deriveSpriteStateFromIssue(
        issue("i1", {
          status: "in_progress",
          pendingInteraction: "ask_user_questions",
          hasActiveHeartbeat: true,
        }),
      ),
      "decision_ready",
    );
  });

  it("returns blocked for blocked status without a pending interaction", () => {
    strictEqual(deriveSpriteStateFromIssue(issue("i1", { status: "blocked" })), "blocked");
  });

  it("returns waiting for in_review issues without a pending interaction", () => {
    strictEqual(deriveSpriteStateFromIssue(issue("i1", { status: "in_review" })), "waiting");
  });

  it("returns working when an in_progress issue has an active heartbeat", () => {
    strictEqual(
      deriveSpriteStateFromIssue(
        issue("i1", { status: "in_progress", hasActiveHeartbeat: true }),
      ),
      "working",
    );
  });

  it("returns idle when an in_progress issue has no active heartbeat", () => {
    strictEqual(
      deriveSpriteStateFromIssue(
        issue("i1", { status: "in_progress", hasActiveHeartbeat: false }),
      ),
      "idle",
    );
  });

  it("returns working when a todo issue has an active heartbeat", () => {
    strictEqual(
      deriveSpriteStateFromIssue(
        issue("i1", { status: "todo", hasActiveHeartbeat: true }),
      ),
      "working",
    );
  });
});

describe("deriveSpriteStateForAgent", () => {
  it("returns idle when the agent has no issues in the project", () => {
    const index: ProjectIssueIndex = { projectId: "p1", issues: [] };
    strictEqual(deriveSpriteStateForAgent(index, "agent-1"), "idle");
  });

  it("returns decision_ready when any owned issue is decision_ready", () => {
    const index: ProjectIssueIndex = {
      projectId: "p1",
      issues: [
        issue("i1", { assigneeAgentId: "agent-1", status: "in_progress" }),
        issue("i2", {
          assigneeAgentId: "agent-1",
          status: "in_review",
          pendingInteraction: "request_confirmation",
        }),
      ],
    };
    strictEqual(deriveSpriteStateForAgent(index, "agent-1"), "decision_ready");
  });

  it("returns blocked when the highest priority is blocked", () => {
    const index: ProjectIssueIndex = {
      projectId: "p1",
      issues: [
        issue("i1", { assigneeAgentId: "agent-1", status: "blocked" }),
        issue("i2", { assigneeAgentId: "agent-1", status: "in_progress" }),
      ],
    };
    strictEqual(deriveSpriteStateForAgent(index, "agent-1"), "blocked");
  });

  it("returns waiting when only waiting issues exist", () => {
    const index: ProjectIssueIndex = {
      projectId: "p1",
      issues: [issue("i1", { assigneeAgentId: "agent-1", status: "in_review" })],
    };
    strictEqual(deriveSpriteStateForAgent(index, "agent-1"), "waiting");
  });

  it("returns working when only working issues exist", () => {
    const index: ProjectIssueIndex = {
      projectId: "p1",
      issues: [
        issue("i1", {
          assigneeAgentId: "agent-1",
          status: "in_progress",
          hasActiveHeartbeat: true,
        }),
      ],
    };
    strictEqual(deriveSpriteStateForAgent(index, "agent-1"), "working");
  });

  it("ignores issues owned by other agents", () => {
    const index: ProjectIssueIndex = {
      projectId: "p1",
      issues: [
        issue("i1", {
          assigneeAgentId: "agent-other",
          status: "in_progress",
          hasActiveHeartbeat: true,
        }),
      ],
    };
    strictEqual(deriveSpriteStateForAgent(index, "agent-1"), "idle");
  });
});

describe("buildPixelStrip", () => {
  it("includes only active-idle agents in the idle tail", () => {
    const index: ProjectIssueIndex = { projectId: "p1", issues: [] };
    const agents = [
      agent("agent-a", { heartbeatStatus: "active" }),
      agent("agent-b", { heartbeatStatus: "idle" }),
      agent("agent-c", { heartbeatStatus: "paused" }),
      agent("agent-d", { heartbeatStatus: "errored" }),
    ];
    deepStrictEqual(buildPixelStrip(index, agents), [
      { agentId: "agent-a", state: "idle" },
    ]);
  });

  it("lists non-idle sprites first, then idle sprites, each sorted by agentId", () => {
    const index: ProjectIssueIndex = {
      projectId: "p1",
      issues: [
        issue("i1", {
          assigneeAgentId: "agent-b",
          status: "in_progress",
          hasActiveHeartbeat: true,
        }),
        issue("i2", {
          assigneeAgentId: "agent-c",
          status: "in_review",
        }),
      ],
    };
    const agents = [
      agent("agent-a", { heartbeatStatus: "active" }),
      agent("agent-b", { heartbeatStatus: "active" }),
      agent("agent-c", { heartbeatStatus: "active" }),
    ];
    deepStrictEqual(buildPixelStrip(index, agents), [
      { agentId: "agent-b", state: "working" },
      { agentId: "agent-c", state: "waiting" },
      { agentId: "agent-a", state: "idle" },
    ]);
  });

  it("returns an empty strip when there are no agents", () => {
    const index: ProjectIssueIndex = { projectId: "p1", issues: [] };
    deepStrictEqual(buildPixelStrip(index, []), []);
  });
});

describe("spriteStateLabel", () => {
  const expected: Record<PixelSpriteState, string> = {
    working: "WORKING",
    waiting: "WAITING",
    blocked: "BLOCKED",
    decision_ready: "DECISION_READY",
    idle: "IDLE",
  };
  for (const [state, label] of Object.entries(expected)) {
    it(`maps ${state} -> ${label}`, () => {
      strictEqual(spriteStateLabel(state as PixelSpriteState).label, label);
    });
  }
});
