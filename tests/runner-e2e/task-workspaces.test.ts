import { describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { gradeTaskWorkspaces, type TaskWorkspaceObservation } from "./task-workspaces-scoring.js";
import { TASK_WORKSPACES_SUITE, taskWorkspaceFiles, taskWorkspacePrompt } from "./task-workspaces-cases.js";

function valid(): TaskWorkspaceObservation {
  const nonce = "fixture", cwd = "/isolated/task", pin = "a".repeat(40), head = "b".repeat(40);
  return { nonce, native: true, daytona: true, initial: { workspaceId: "workspace", cwd, repositories: 0 },
    checkpoints: [1, 2, 3].map(turn => ({ turn,
      issue: { id: "issue", projectId: null, executionWorkspaceId: "workspace", status: "done" },
      workspace: { id: "workspace", projectId: null, cwd }, confinedTaskRoot: true,
      note: `task-files-turn-${turn}-${nonce}\n`,
      repositories: [{ id: "repo", state: turn === 1 ? "pending" : "ready", relativePath: `.paperclip-repositories/task-repo-${"a".repeat(24)}`,
        pinnedCommit: turn === 1 ? null : pin, requestedByIssueId: "issue", requestKeys: [`repository-${nonce}`] }],
      run: { id: `run-${turn}`, status: "succeeded", runtimeMode: "native", nativePhase: "committed", nativeBinding: "workspace",
        nativeCwd: "/workspace/task", transport: "provider_ingress", authenticated: true, nativeCompleted: true },
      ...(turn > 1 ? { repository: { head, baseIsAncestor: true, dirty: true, content: `repository-dirty-${nonce}\n` } } : {}),
      prepareCalls: turn === 1 ? 2 : 0,
    })), projectCount: 0, runCount: 3, restarted: true, pendingInteractions: 0, activeOperations: 0, activeRecovery: false,
    artifact: { content: `repository-dirty-${nonce}\n`, contentVerified: true, mimeType: "text/plain" },
    remoteLeaseRunIds: ["run-1", "run-2", "run-3"] };
}
describe("task workspace product E2E", () => {
  it("declares exactly the three authorized cells with no project/cwd and one attempt", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === TASK_WORKSPACES_SUITE);
    expect(cells.map(cell => cell.id).sort()).toEqual([
      "task-workspaces.legacy-opencode.local.task-directory-repository-resume",
      "task-workspaces.runner-opencode.daytona.task-directory-repository-resume",
      "task-workspaces.runner-opencode.local.task-directory-repository-resume",
    ]);
    for (const cell of cells) {
      expect(cell.suite.manualOnly).toBe(true);
      expect(cell.task.automaticRetryPolicy).toBe("single_attempt");
      expect(cell.task.expectedRunCount).toBe(3);
      const agent = cell.profile.buildAgent({ environmentId: "environment", environmentFixtureId: cell.environment.id,
        workspacePath: "/must-not-use", executionId: "fixture", secretRefs: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "secret", version: "latest" } } });
      expect(agent.budgetMonthlyCents).toBe(1000);
      expect((agent.adapterConfig as Record<string, unknown>).cwd).toBeUndefined();
    }
  });
  it("keeps native tools and legacy authenticated API prompts distinct", () => {
    expect(taskWorkspacePrompt("fixture", 1, true)).toContain("Call prepare_repository twice");
    expect(taskWorkspacePrompt("fixture", 1, false)).toContain("POST /api/issues/$PAPERCLIP_TASK_ID/workspace/repositories twice");
    expect(taskWorkspacePrompt("fixture", 3, true)).not.toContain(taskWorkspaceFiles("fixture").repositoryBytes.trim());
  });
  it("accepts independently consistent persisted observations", () => {
    expect(gradeTaskWorkspaces(valid()).filter(check => !check.passed)).toEqual([]);
    const legacy = valid(); legacy.native = false; legacy.daytona = false;
    legacy.checkpoints.forEach(point => { point.run.runtimeMode = "legacy"; delete point.prepareCalls; });
    expect(gradeTaskWorkspaces(legacy).filter(check => !check.passed)).toEqual([]);
  });
  it.each([
    ["missing evidence", (v: TaskWorkspaceObservation) => { v.checkpoints = []; }],
    ["agent home", (v: TaskWorkspaceObservation) => { v.checkpoints[0]!.confinedTaskRoot = false; }],
    ["new project", (v: TaskWorkspaceObservation) => { v.projectCount = 1; }],
    ["root switched", (v: TaskWorkspaceObservation) => { v.checkpoints[1]!.workspace.cwd = "/different"; }],
    ["early clone", (v: TaskWorkspaceObservation) => { v.checkpoints[0]!.repositories[0]!.state = "ready"; }],
    ["duplicate receipt", (v: TaskWorkspaceObservation) => { v.checkpoints[1]!.repositories.push(v.checkpoints[1]!.repositories[0]!); }],
    ["different pin", (v: TaskWorkspaceObservation) => { v.checkpoints[2]!.repositories[0]!.pinnedCommit = "c".repeat(40); }],
    ["lost Git commit", (v: TaskWorkspaceObservation) => { v.checkpoints[2]!.repository!.head = "a".repeat(40); }],
    ["lost dirty bytes", (v: TaskWorkspaceObservation) => { v.checkpoints[2]!.repository!.content = "reset"; }],
    ["missing download", (v: TaskWorkspaceObservation) => { v.artifact = null; }],
    ["unverified download", (v: TaskWorkspaceObservation) => { v.artifact!.contentVerified = false; }],
    ["extra wake", (v: TaskWorkspaceObservation) => { v.runCount = 4; }],
    ["unfinished persistence", (v: TaskWorkspaceObservation) => { v.activeOperations = 1; }],
    ["wrong native binding", (v: TaskWorkspaceObservation) => { v.checkpoints[2]!.run.nativeBinding = "another"; }],
    ["tool bypass", (v: TaskWorkspaceObservation) => { v.checkpoints[0]!.prepareCalls = 0; }],
    ["missing remote lease", (v: TaskWorkspaceObservation) => { v.remoteLeaseRunIds = ["run-1"]; }],
  ] as const)("rejects %s instead of accepting model claims", (_label, mutate) => {
    const observation = valid(); mutate(observation);
    expect(gradeTaskWorkspaces(observation).some(check => !check.passed)).toBe(true);
  });
});
