import { describe, expect, it } from "vitest";

import { createCapabilityFixtureState } from "../mock-core/capability-control-plane-types.js";
import type { CapabilityLiveSessionSnapshot } from "../live/live-session.js";
import { projectCapabilityDevtools } from "./index.js";

function snapshot(): CapabilityLiveSessionSnapshot {
  const seed = createCapabilityFixtureState({
    comments: [{
      id: "comment-1",
      taskId: "task-1",
      authorActorId: "actor-1",
      body: "credential pcp_1234567890 should not cross the browser boundary",
      createdAt: "2026-08-09T00:00:00.000Z",
    }],
  });
  const current = structuredClone(seed);
  current.revision = 2;
  current.lifecycle = "running";
  current.artifacts.push({
    id: "artifact-1",
    companyId: "company-1",
    taskId: "task-1",
    runId: "run-1",
    kind: "text",
    name: "result.txt",
    contentRef: "file:///private/result.txt",
    metadata: {},
    createdAt: "2026-08-09T00:00:01.000Z",
  });
  return {
    id: "session-1",
    revision: 1,
    status: "running",
    activeTurnId: null,
    providerThreadId: "thread-1",
    providerSessionId: "provider-session-1",
    providerModel: "gpt-test",
    config: {
      seedState: JSON.stringify(seed),
      workingDirectory: "/private/worktree",
      scenario: "hb-baseline",
      capabilities: ["task:read"],
      explicitClaims: [],
      turnTimeoutMs: 1_000,
    },
    authority: {
      companyId: "company-1",
      actorId: "actor-1",
      taskId: "task-1",
      runId: "run-1",
      sessionId: "session-1",
    },
    transcript: [],
    evidence: [{
      id: "evidence-1",
      at: "2026-08-09T00:00:01.000Z",
      turnId: null,
      kind: "session",
      data: {
        authorization: "Bearer secret-token-value",
        api_key: "plain-secret-that-is-only-sensitive-because-of-its-key",
        apiKey: "camel-case-secret",
      },
    }],
    mockState: JSON.stringify(current),
    process: null,
    networkEvidence: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:01.000Z",
    stateHistory: [{
      revision: current.revision,
      at: "2026-08-09T00:00:01.000Z",
      turnId: null,
      operationId: "session.open",
      state: JSON.stringify(current),
    }],
  };
}

describe("projectCapabilityDevtools", () => {
  it("projects the seed and complete current company scaffolding", () => {
    const result = projectCapabilityDevtools(snapshot());
    const state = result.revisions.at(-1)!.state as Record<string, unknown>;

    expect(result.revisions.map(({ operationId }) => operationId)).toEqual([
      "fixture.seed",
      "session.open",
    ]);
    expect(Object.keys(state)).toEqual(expect.arrayContaining([
      "company", "actors", "tasks", "comments", "documents", "interactions",
      "approvals", "artifacts", "workProducts", "blockers", "workspaceServices",
      "budgets", "runs", "wakes", "audit", "decisions", "idempotency", "faults",
    ]));
  });

  it("withholds browser-forbidden state and redacts secret-shaped strings", () => {
    const serialized = JSON.stringify(projectCapabilityDevtools(snapshot()));

    expect(serialized).not.toContain("pcp_1234567890");
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("plain-secret-that-is-only-sensitive-because-of-its-key");
    expect(serialized).not.toContain("camel-case-secret");
    expect(serialized).not.toContain("file:///private/result.txt");
    expect(serialized).not.toContain("/private/worktree");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[withheld]");
  });
});
