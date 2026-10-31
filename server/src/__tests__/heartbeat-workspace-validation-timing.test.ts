import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// SOU-184: `assertGitSensitiveAdapterWorkspaceValid` (the `codex_local`
// workspace-validation stage that raises `workspace_validation_failed` for a
// non-git adapter cwd) must run as part of workspace preparation, before the
// run/agent are marked "running" and before the adapter is dispatched. A
// non-git knowledge-vault-style binding must fail there instead of mid-run,
// which previously left a started run and a "running" agent to recover from.
//
// This is a source-shape guard rather than a full heartbeat integration test:
// exercising the real dispatch path end-to-end requires provider credentials
// that are not available in every test environment. The validation function
// itself (reject a missing-.git cwd; accept an eligible git/project-primary
// workspace) is already covered directly in heartbeat-workspace-session.test.ts.

const heartbeatSourcePath = fileURLToPath(
  new URL("../services/heartbeat.ts", import.meta.url),
);
const heartbeatSource = readFileSync(heartbeatSourcePath, "utf8");

function requireSingleIndex(needle: string): number {
  const first = heartbeatSource.indexOf(needle);
  expect(first, `expected to find ${JSON.stringify(needle)} in heartbeat.ts`).toBeGreaterThanOrEqual(0);
  expect(heartbeatSource.indexOf(needle, first + 1), `expected exactly one occurrence of ${JSON.stringify(needle)} in heartbeat.ts`).toBe(-1);
  return first;
}

describe("heartbeat workspace validation timing", () => {
  it("runs the git-sensitive workspace validation before the agent is marked running", () => {
    const validationCallIndex = requireSingleIndex("assertGitSensitiveAdapterWorkspaceValid({");
    const agentRunningUpdateIndex = requireSingleIndex('.set({ status: "running", updatedAt: new Date() })');

    expect(validationCallIndex).toBeLessThan(agentRunningUpdateIndex);
  });

  it("runs the git-sensitive workspace validation immediately after workspace preparation resolves", () => {
    const workspacePrepIndex = requireSingleIndex('await timePreparation("workspace", () => prepareHeartbeatWorkspace(db, {');
    const validationCallIndex = requireSingleIndex("assertGitSensitiveAdapterWorkspaceValid({");
    const runtimeServicesIndex = requireSingleIndex('await timePreparation("runtime_services", () => startHeartbeatRuntimeServices(db, {');

    expect(workspacePrepIndex).toBeLessThan(validationCallIndex);
    expect(validationCallIndex).toBeLessThan(runtimeServicesIndex);
  });
});
