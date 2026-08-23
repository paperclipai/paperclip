import { describe, expect, it } from "vitest";
import { resolveRuntimeSessionParamsForWorkspace } from "../services/heartbeat.js";

/**
 * TSMC-21089: the fallback→project migration rotates the session ONCE. It keyed
 * solely on `previousWorkspaceSource`, which several adapters never persist, so
 * the same task rotated on every run — each rotation a fresh context-less
 * session that frequently no-ops and is still recorded as SUCCESS.
 */
const PROJECT_CWD = "/Users/x/.paperclip/instances/default/projects/co/pr/_default";
const workspace = { source: "project_primary", cwd: PROJECT_CWD } as never;

const call = (previousSessionParams: Record<string, unknown> | null, previousWorkspaceSource: string | null) =>
  resolveRuntimeSessionParamsForWorkspace({
    agentId: "a1", previousSessionParams, previousWorkspaceSource, resolvedWorkspace: workspace,
  });

describe("project workspace migration convergence", () => {
  it("still rotates once away from a genuine fallback tree", () => {
    const r = call({ sessionId: "s1", cwd: "/Users/x/.paperclip/agent-home" }, "agent_home");
    expect(r.sessionParams).toBeNull();
    expect(r.resetReason).toBe("project_workspace_migration_from_fallback");
  });

  it("does NOT rotate again once the session already runs in the project cwd", () => {
    // The adapter never recorded workspaceSource — the case that looped.
    const r = call({ sessionId: "s1", cwd: PROJECT_CWD }, null);
    expect(r.sessionParams).toEqual({ sessionId: "s1", cwd: PROJECT_CWD });
    expect(r.resetReason).toBeNull();
    expect(r.warning).toBeNull();
  });

  it("keeps honouring an explicitly recorded project_primary source", () => {
    const r = call({ sessionId: "s1", cwd: "/somewhere/else" }, "project_primary");
    expect(r.resetReason).toBeNull();
  });

  it("rotates when the prior cwd is a different tree, even if non-empty", () => {
    const r = call({ sessionId: "s1", cwd: "/Users/x/some-other-project" }, null);
    expect(r.sessionParams).toBeNull();
    expect(r.resetReason).toBe("project_workspace_migration_from_fallback");
  });

  it("leaves runs with no prior session untouched", () => {
    expect(call({ cwd: PROJECT_CWD }, null).resetReason).toBeNull();
    expect(call(null, null).resetReason).toBeNull();
  });

  it("does not rotate when the resolved workspace is not project_primary", () => {
    const r = resolveRuntimeSessionParamsForWorkspace({
      agentId: "a1",
      previousSessionParams: { sessionId: "s1", cwd: "/fallback" },
      previousWorkspaceSource: null,
      resolvedWorkspace: { source: "agent_home", cwd: "/fallback" } as never,
    });
    expect(r.resetReason).toBeNull();
  });
});
