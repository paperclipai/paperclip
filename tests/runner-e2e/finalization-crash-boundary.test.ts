import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseFinalizationCrashBinding, readFinalizationCrashBoundary } from "./finalization-crash-boundary.js";

function fixture() {
  const binding = { companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID() };
  const run = { id: binding.runId, companyId: binding.companyId, nativeIssueId: binding.issueId, agentId: "agent",
    runtimeMode: "native", status: "running", nativePhase: "workspace_finalizing" };
  const issue = { id: binding.issueId, companyId: binding.companyId, assigneeAgentId: "agent", executionRunId: binding.runId, status: "in_progress" };
  const read = vi.fn(async (path: string) => path.includes("heartbeat-runs") ? run : issue);
  return { binding, run, issue, read };
}

describe("isolated finalization crash admission", () => {
  it("requires the current company, task, assignee and result-bearing run before admitting the fault", async () => {
    const value = fixture();
    expect(parseFinalizationCrashBinding(value.binding)).toEqual(value.binding);
    expect(await readFinalizationCrashBoundary(value.read, value.binding)).toMatchObject({ ...value.binding, nativePhase: "workspace_finalizing" });
    expect(value.read.mock.calls.map(([path]) => path).sort()).toEqual([
      `/api/heartbeat-runs/${value.binding.runId}`, `/api/issues/${value.binding.issueId}`,
    ].sort());
  });
  it.each([
    ["foreign run", (v: ReturnType<typeof fixture>) => { v.run.id = randomUUID(); }],
    ["foreign run company", (v: ReturnType<typeof fixture>) => { v.run.companyId = randomUUID(); }],
    ["foreign bound task", (v: ReturnType<typeof fixture>) => { v.run.nativeIssueId = randomUUID(); }],
    ["foreign task", (v: ReturnType<typeof fixture>) => { v.issue.id = randomUUID(); }],
    ["foreign task company", (v: ReturnType<typeof fixture>) => { v.issue.companyId = randomUUID(); }],
    ["changed run owner", (v: ReturnType<typeof fixture>) => { v.issue.executionRunId = randomUUID(); }],
    ["changed assignee", (v: ReturnType<typeof fixture>) => { v.issue.assigneeAgentId = "other"; }],
    ["provider still working", (v: ReturnType<typeof fixture>) => { v.run.nativePhase = "running"; }],
    ["already committed", (v: ReturnType<typeof fixture>) => { v.run.nativePhase = "committed"; }],
    ["terminal run", (v: ReturnType<typeof fixture>) => { v.run.status = "succeeded"; }],
    ["legacy run", (v: ReturnType<typeof fixture>) => { v.run.runtimeMode = "legacy"; }],
    ["stopped task", (v: ReturnType<typeof fixture>) => { v.issue.status = "cancelled"; }],
    ["completed task", (v: ReturnType<typeof fixture>) => { v.issue.status = "done"; }],
    ["blocked task", (v: ReturnType<typeof fixture>) => { v.issue.status = "blocked"; }],
  ] as const)("refuses an unexercised boundary: %s", async (_name, change) => {
    const value = fixture(); change(value);
    await expect(readFinalizationCrashBoundary(value.read, value.binding)).rejects.toThrow("boundary was not exercised");
  });
  it("fails closed on unavailable state and malformed control bindings", async () => {
    await expect(readFinalizationCrashBoundary(async () => { throw new Error("unavailable"); }, fixture().binding)).rejects.toThrow("unavailable");
    const binding = fixture().binding;
    for (const value of [null, [], {}, { ...binding, runId: "../foreign" }, { ...binding, command: "arbitrary" }])
      expect(() => parseFinalizationCrashBinding(value)).toThrow("Invalid finalization crash binding");
  });
});
