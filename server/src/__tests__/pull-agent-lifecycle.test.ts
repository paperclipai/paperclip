import { describe, expect, it } from "vitest";
import {
  agentStatusFromPullLifecycle,
  derivePullAgentLifecycle,
  resolveStoredPullReport,
} from "../services/pull-agent-lifecycle.js";

const now = new Date("2026-08-14T20:00:00.000Z");

function report(overrides: Record<string, unknown> = {}) {
  return {
    source: "resident-seat",
    observedAt: "2026-08-14T19:59:30.000Z",
    expiresAt: "2026-08-14T20:01:30.000Z",
    evidence: [],
    ...overrides,
  } as never;
}

describe("derivePullAgentLifecycle", () => {
  it("treats a pull agent with no fresh lease as unreachable", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: null,
      queuedIssueCount: 3,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle.state).toBe("unreachable");
    expect(lifecycle.dispatchEnabled).toBe(false);
  });

  it("derives running from active process evidence", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({ evidence: [{ kind: "external_lease", active: true }] }),
      queuedIssueCount: 2,
      blockedIssueCount: 1,
      now,
    });

    expect(lifecycle.state).toBe("running");
    expect(lifecycle.source).toBe("resident-seat");
  });

  it("distinguishes an idle pull agent that has queued work", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({ state: "idle" }),
      queuedIssueCount: 2,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle.state).toBe("idle_queued");
  });

  it("lets an explicit blocked report override queued work", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({ state: "blocked" }),
      queuedIssueCount: 2,
      blockedIssueCount: 1,
      now,
    });

    expect(lifecycle.state).toBe("blocked");
  });

  it("does not treat a far-future expiresAt as fresh past the lease cap", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({
        observedAt: "2026-08-14T18:00:00.000Z",
        expiresAt: "2027-08-14T20:00:00.000Z",
        state: "running",
      }),
      queuedIssueCount: 0,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle.state).toBe("unreachable");
  });

  it("does not treat a future observedAt as extending the lease past now plus TTL", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({
        observedAt: "2026-08-14T21:00:00.000Z",
        expiresAt: "2026-08-14T23:00:00.000Z",
        state: "running",
      }),
      queuedIssueCount: 0,
      blockedIssueCount: 0,
      now: new Date("2026-08-14T20:01:01.000Z"),
    });

    expect(lifecycle.state).toBe("unreachable");
  });

  it("still honors a far-future expiresAt until the observedAt plus max TTL", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({
        observedAt: "2026-08-14T19:59:30.000Z",
        expiresAt: "2027-08-14T20:00:00.000Z",
        state: "running",
      }),
      queuedIssueCount: 0,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle.state).toBe("running");
  });

  it("marks an expired report unreachable", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({ expiresAt: "2026-08-14T19:59:59.999Z", state: "running" }),
      queuedIssueCount: 0,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle.state).toBe("unreachable");
  });

  it("keeps push agents dispatchable without pull evidence", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: {},
      storedReport: null,
      queuedIssueCount: 0,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle).toMatchObject({ executionModel: "push", state: "idle", dispatchEnabled: true });
  });

  it("derives running from a fresh native task session when the posted lease is stale", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({ expiresAt: "2026-08-14T19:59:59.999Z", state: "idle" }),
      nativeEvidence: [{ kind: "task_session", id: "sess-1", active: true }],
      queuedIssueCount: 1,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle.state).toBe("running");
    expect(lifecycle.source).toBe("task_session");
    expect(lifecycle.evidence).toEqual([
      { kind: "task_session", id: "sess-1", active: true },
    ]);
  });

  it("maps only running/idle pull states onto agent.status", () => {
    expect(agentStatusFromPullLifecycle("running")).toBe("running");
    expect(agentStatusFromPullLifecycle("idle")).toBe("idle");
    expect(agentStatusFromPullLifecycle("idle_queued")).toBe("idle");
    expect(agentStatusFromPullLifecycle("blocked")).toBeNull();
    expect(agentStatusFromPullLifecycle("unreachable")).toBe("idle");
  });
});

describe("resolveStoredPullReport", () => {
  const lease = {
    source: "resident-seat",
    observedAt: "2026-08-16T15:00:00.000Z",
    expiresAt: "2026-08-16T15:03:00.000Z",
    state: "running",
  };

  it("prefers the native runtime-state lease over runtimeConfig", () => {
    expect(resolveStoredPullReport(
      { pullLifecycleReport: { ...lease, source: "runtime-state" } },
      { pullLifecycle: { ...lease, source: "runtime-config" } },
    )?.source).toBe("runtime-state");
  });

  it("falls back to runtimeConfig.pullLifecycle when runtime-state has no lease", () => {
    expect(resolveStoredPullReport({ keepMe: true }, { pullLifecycle: lease })).toEqual(lease);
  });

  it("returns null when neither store has a well-formed lease", () => {
    expect(resolveStoredPullReport({ pullLifecycleReport: { state: "running" } }, {})).toBeNull();
    expect(resolveStoredPullReport(null, { pullLifecycle: { source: "missing-dates" } })).toBeNull();
  });
});
