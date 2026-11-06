import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { updateIssueSchema } from "../../../packages/shared/src/validators/issue.js";
import { repositoryWaitingOwnerInput, repositoryWaitingOwnerRetained } from "./runtime-workspace-repositories.js";

type Context = Parameters<typeof repositoryWaitingOwnerInput>[0];
function valid(): Context {
  return { companyId: "company", personId: "person", workerId: "worker", taskId: "task", workspaceId: "workspace", fixtureRunId: "run",
    members: [{ companyId: "company", principalType: "user", principalId: "person", status: "active" }],
    task: { id: "task", companyId: "company", status: "done", assigneeAgentId: "worker", assigneeUserId: null, executionWorkspaceId: "workspace" },
    run: { id: "run", companyId: "company", agentId: "worker", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "task" } } };
}
function saved(input = valid()) {
  return { ...input.task, ...repositoryWaitingOwnerInput(input) };
}
const service = readFileSync(new URL("../../../server/src/services/issues.ts", import.meta.url), "utf8");
const guard = service.match(/if\s*\(\s*(patch\.status === "in_progress"\s*&&\s*!nextAssigneeAgentId\s*&&\s*!nextAssigneeUserId)\s*\)\s*\{\s*throw unprocessable\("in_progress issues require an assignee"\)/)?.[1];
if (!guard) throw new Error("Actual public issue-update ownership guard changed; review repository setup contract");
const rejectsOwner = new Function("patch", "nextAssigneeAgentId", "nextAssigneeUserId", `return (${guard});`) as (patch: { status: string }, agentId: string | null, userId: string | null) => boolean;

describe("repository waiting task public ownership", () => {
  it("satisfies the actual service predicate with a real human owner and rejects the original unassigned active patch", () => {
    const input = valid(), patch = repositoryWaitingOwnerInput(input);
    expect(updateIssueSchema.parse(patch)).toEqual(patch);
    expect(patch).toEqual({ status: "in_progress", assigneeAgentId: null, assigneeUserId: "person" });
    expect(rejectsOwner(patch, patch.assigneeAgentId, patch.assigneeUserId)).toBe(false);
    expect(rejectsOwner({ status: "in_progress" }, null, null)).toBe(true);
    expect(input.task.status).toBe("done");
    expect(input.run.status).toBe("succeeded");
    expect(input.task.assigneeAgentId).toBe("worker");
  });
  it("requires the signed-in active human membership in the exact company", () => {
    for (const change of [
      (v: Context) => { v.personId = undefined; },
      (v: Context) => { v.members = []; },
      (v: Context) => { v.members[0]!.principalType = "agent"; },
      (v: Context) => { v.members[0]!.principalId = "another-person"; },
      (v: Context) => { v.members[0]!.companyId = "foreign-company"; },
      (v: Context) => { v.members[0]!.status = "suspended"; },
    ]) { const input = valid(); change(input); expect(() => repositoryWaitingOwnerInput(input)).toThrow(); }
  });
  it("preserves actual completed worker, task, workspace and native-run provenance", () => {
    for (const change of [
      (v: Context) => { v.task.id = "other-task"; },
      (v: Context) => { v.task.companyId = "foreign"; },
      (v: Context) => { v.task.status = "in_progress"; },
      (v: Context) => { v.task.assigneeAgentId = "another-worker"; },
      (v: Context) => { v.task.assigneeUserId = "another-person"; },
      (v: Context) => { v.task.executionWorkspaceId = "another-workspace"; },
      (v: Context) => { v.run.id = "invented-run"; },
      (v: Context) => { v.run.companyId = "foreign"; },
      (v: Context) => { v.run.agentId = "another-worker"; },
      (v: Context) => { v.run.status = "running"; },
      (v: Context) => { v.run.status = "cancelled"; },
      (v: Context) => { v.run.status = "failed"; },
      (v: Context) => { v.run.runtimeMode = "legacy"; },
      (v: Context) => { v.run.contextSnapshot = { issueId: "another-task" }; },
    ]) { const input = valid(); change(input); expect(() => repositoryWaitingOwnerInput(input)).toThrow(); }
  });
  it("requires independent saved ownership and no extra or cancelled native runs", () => {
    const input = valid();
    expect(repositoryWaitingOwnerRetained(input, saved(), ["run"], [{ id: "run", status: "succeeded" }])).toBe(true);
    const changes: Array<Partial<Context["task"]>> = [
      { assigneeAgentId: "worker" }, { assigneeUserId: "other" }, { assigneeUserId: null }, { companyId: "foreign" },
      { id: "other-task" }, { executionWorkspaceId: "other-workspace" }, { status: "done" },
    ];
    for (const change of changes) expect(repositoryWaitingOwnerRetained(input, { ...saved(), ...change }, ["run"], [{ id: "run", status: "succeeded" }])).toBe(false);
    for (const runs of [[], [{ id: "other-run", status: "succeeded" }], [{ id: "run", status: "cancelled" }], [{ id: "run", status: "succeeded" }, { id: "extra", status: "running" }]] as const)
      expect(repositoryWaitingOwnerRetained(input, saved(), ["run"], [...runs])).toBe(false);
    expect(repositoryWaitingOwnerRetained(input, saved(), ["run", "earlier-unaccounted"], [{ id: "run", status: "succeeded" }])).toBe(false);
  });
});
