import { describe, expect, it } from "vitest";
import { assertHandedOffRunTaskOwnership } from "../run-task-ownership.js";

describe("governed self-handoff authority", () => {
  const run = { id: "source", companyId: "company", runtimeMode: "legacy", contextSnapshot: {
    issueId: "task", governedSelfHandoff: { runId: "source", issueId: "task" },
  } };
  const issue = { id: "task", companyId: "company", assigneeAgentId: "reviewer", assigneeUserId: null };

  it("rejects later mutations by the handing-off run", () => {
    expect(() => assertHandedOffRunTaskOwnership(run, issue)).toThrow("handed off");
  });

  it("does not restore the old run's authority after an assignment back", () => {
    expect(() => assertHandedOffRunTaskOwnership(run, { ...issue, assigneeAgentId: "worker" })).toThrow("handed off");
  });

  it("does not revoke a successor that carries the old source context", () => {
    expect(() => assertHandedOffRunTaskOwnership({ ...run, id: "successor" }, issue)).not.toThrow();
  });

  it("keeps ordinary visible-task writes unchanged", () => {
    expect(() => assertHandedOffRunTaskOwnership({ ...run, contextSnapshot: { issueId: "task" } }, issue)).not.toThrow();
  });

  it("does not use a foreign task or company marker", () => {
    expect(() => assertHandedOffRunTaskOwnership(run, { ...issue, id: "other" })).not.toThrow();
    expect(() => assertHandedOffRunTaskOwnership(run, { ...issue, companyId: "other" })).not.toThrow();
  });
});
