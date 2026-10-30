import { describe, expect, it } from "vitest";
import { assertHireAuditCoverage, assertHireBinding, assertHireDocument, assertHireRuns, hireDelegateNames, observedHireResources, type HireScope } from "./hire-delegate-evidence.js";
import { agentJourneyRuns, journeyRequiredChecks } from "./success-contract.js";

type Row = Record<string, any>;
const scope: HireScope = { companyId: "company", leadId: "lead", chatId: "chat", projectId: "project", campaignId: "journey-1-deadbeef",
  model: "fixed-model", provider: "opencode", environmentId: "daytona", connectionBinding: { connectionId: "connection" } };
function fixture() {
  const names = hireDelegateNames(scope.campaignId);
  const agent = { id: "hire", companyId: scope.companyId, name: names.hire, reportsTo: scope.leadId, adapterType: "paperclip_runner",
    adapterConfig: { model: scope.model }, runtimeConfig: { aiConnection: scope.connectionBinding } };
  const task = { id: "task", title: names.checklist, identifier: "TEST-1", companyId: scope.companyId, projectId: scope.projectId, status: "done", assigneeAgentId: agent.id };
  const run = (id: string, issueId: string, agentId: string) => ({ id, companyId: scope.companyId, agentId, issueId, status: "succeeded", runtimeMode: "native",
    contextSnapshot: { issueId, paperclipEnvironment: { id: scope.environmentId } }, runnerProfileJson: { nativeExecutionInput: { provider: { kind: scope.provider, model: scope.model } } } });
  const leadRun = run("lead-run", scope.chatId, scope.leadId), taskRun = run("task-run", task.id, agent.id);
  const event = (action: string, entityId: string) => ({ companyId: scope.companyId, actorType: "agent", actorId: scope.leadId, agentId: scope.leadId, runId: leadRun.id, action, entityId });
  const state = { agents: [agent], tasks: [task], leadRuns: [leadRun], activity: [event("agent.hire_created", agent.id), event("issue.created", task.id)] };
  return { agent, task, leadRun, taskRun, state, event, run };
}
describe("deployment hiring qualification", () => {
  it("uses seven bounded native runs and has closed retained-result success requirements", () => {
    expect(agentJourneyRuns["hire-delegate-reuse"]).toBe(7);
    expect(journeyRequiredChecks["hire-delegate-reuse"]).toContain("review-authored-by-same-hired-run");
  });
  it("accepts old activity only when the page covers the exact current lead runs", () => {
    const activity = Array.from({ length: 500 }, () => ({ createdAt: "2026-10-29T00:00:00Z" }));
    expect(() => assertHireAuditCoverage(activity, [{ startedAt: "2026-10-30T00:00:00Z" }])).not.toThrow();
    expect(() => assertHireAuditCoverage(activity, [{ startedAt: "2026-10-28T00:00:00Z" }])).toThrow();
    expect(() => assertHireAuditCoverage(activity, [{}])).toThrow();
    expect(() => assertHireAuditCoverage(activity, [])).not.toThrow();
  });
  it("trusts the native actor's actual hire/task receipts, not matching names in a shared company", () => {
    const f = fixture();
    expect(observedHireResources(scope, f.state).hires).toEqual([f.agent]);
    for (const property of ["companyId", "actorType", "actorId", "agentId", "runId"]) {
      const changed = structuredClone(f.state); changed.activity[0]![property as keyof typeof changed.activity[0]] = "foreign";
      const observed = observedHireResources(scope, changed);
      expect(() => assertHireBinding(scope, observed.agents)).toThrow();
    }
    const unrelated = { ...f.agent, id: "unrelated", name: "Other work" };
    expect(observedHireResources(scope, { ...f.state, agents: [...f.state.agents, unrelated] }).agents).toEqual([f.agent]);
    expect(observedHireResources(scope, { ...f.state, activity: [] }).agents).toEqual([]);
  });
  it("rejects duplicate hires, altered runtime/account binding and a replaced teammate", () => {
    const f = fixture(); expect(assertHireBinding(scope, [f.agent]).id).toBe("hire");
    expect(() => assertHireBinding(scope, [f.agent], "old-hire")).toThrow();
    expect(() => assertHireBinding(scope, [f.agent, { ...f.agent, id: "duplicate" }])).toThrow();
    for (const change of [{ companyId: "other" }, { reportsTo: "other" }, { adapterType: "legacy" },
      { adapterConfig: { model: "other" } }, { runtimeConfig: { aiConnection: { connectionId: "other" } } }]) {
      expect(() => assertHireBinding(scope, [{ ...f.agent, ...change }])).toThrow();
    }
  });
  it("keeps unexpected authored children visible for failure cleanup without grading them as the requested work", () => {
    const f = fixture(), extra = { ...f.task, id: "extra", title: `Unexpected ${scope.campaignId}` };
    const observed = observedHireResources(scope, { ...f.state, tasks: [...f.state.tasks, extra], activity: [...f.state.activity, f.event("issue.created", extra.id)] });
    expect(observed.tasks).toHaveLength(2); expect(observed.expectedTasks).toEqual([f.task]);
    const mismatch = observedHireResources(scope, { ...f.state, tasks: [{ ...f.task, projectId: "other" }] });
    expect(mismatch.tasks).toHaveLength(1); expect(mismatch.scopeMismatch).toBe(true);
  });
  it("binds lead and worker runs to their exact tasks, provider, model and environment", () => {
    const f = fixture(); expect(() => assertHireRuns(scope, f.agent.id, [f.task], [f.leadRun, f.taskRun])).not.toThrow();
    for (const change of [{ companyId: "other" }, { agentId: scope.leadId }, { issueId: "other" }, { status: "failed" },
      { runtimeMode: "legacy" }, { contextSnapshot: { paperclipEnvironment: { id: "local" } } },
      { runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "other" } } } }]) {
      expect(() => assertHireRuns(scope, f.agent.id, [f.task], [f.leadRun, { ...f.taskRun, ...change }])).toThrow();
    }
    expect(() => assertHireRuns(scope, f.agent.id, [f.task], [f.taskRun, f.taskRun])).toThrow();
    expect(() => assertHireRuns(scope, f.agent.id, [f.task], [f.leadRun, f.taskRun], 5)).toThrow();
  });
  it("accounts for three requested lead turns, two exact completion callbacks and two child runs", () => {
    const f = fixture(), second = { ...f.task, id: "review", identifier: "TEST-2" };
    const requested = ["message-1", "message-2", "message-3"].map((id, i) => ({ ...f.run(`lead-${i}`, scope.chatId, scope.leadId),
      contextSnapshot: { ...f.leadRun.contextSnapshot, source: "issue.comment", wakeCommentId: id } }));
    const callbacks = [f.task, second].map((task, i) => ({ ...f.run(`completion-${i}`, scope.chatId, scope.leadId), invocationSource: "automation", triggerDetail: "system",
      contextSnapshot: { ...f.leadRun.contextSnapshot, wakeReason: "chat_task_completed", wakeSource: "automation", wakeTriggerDetail: "system",
        chatCompletionDeliveryIds: [`delivery-${i}`], chatCompletionUpdates: [{ id: task.id, status: "done" }] } }));
    const runs = [...requested, ...callbacks, f.taskRun, f.run("review-run", second.id, f.agent.id)];
    const comments = callbacks.map(run => ({ companyId: scope.companyId, issueId: scope.chatId, authorAgentId: scope.leadId, createdByRunId: run.id, body: "Completed saved result" }));
    const grade = (value = runs, replies = comments) => assertHireRuns(scope, f.agent.id, [f.task, second], value, 7, ["message-1", "message-2", "message-3"], replies);
    expect(() => grade()).not.toThrow();
    expect(() => grade(runs, [])).toThrow("hire_completion_reply_missing");
    expect(assertHireRuns(scope, f.agent.id, [f.task, second], runs, undefined, ["message-1", "message-2", "message-3"], [])).toBe(false);
    expect(() => assertHireRuns(scope, f.agent.id, [f.task, second], runs, undefined, ["message-1", "message-2", "message-3"],
      comments.map(comment => ({ ...comment, authorAgentId: "foreign" })))).toThrow("hire_completion_reply_mismatch");
    for (const change of [{ invocationSource: "on_demand" }, { contextSnapshot: { ...callbacks[0]!.contextSnapshot, chatCompletionUpdates: [{ id: "foreign", status: "done" }] } },
      { contextSnapshot: { ...callbacks[0]!.contextSnapshot, chatCompletionDeliveryIds: ["delivery-1"] } },
      { contextSnapshot: { ...callbacks[0]!.contextSnapshot, wakeReason: "arbitrary_extra_turn" } }]) {
      const corrupted = runs.map(row => row.id === "completion-0" ? { ...row, ...change } : row);
      expect(() => grade(corrupted)).toThrow();
    }
    expect(() => grade([...runs, f.run("extra", scope.chatId, scope.leadId)])).toThrow();
  });
  it("requires the saved document revision to come from the successful hired-agent work run", () => {
    const f = fixture(), body = "Reference: independent-marker";
    const document = { id: "doc", issueId: f.task.id, companyId: scope.companyId, key: "checklist", body, latestRevisionId: "revision" };
    const revision: Row = { id: "revision", body, createdByAgentId: f.agent.id, createdByRunId: f.taskRun.id };
    const grade = (doc = document, revisions = [revision], runs = [f.taskRun]) => assertHireDocument(scope, f.task, doc, revisions, runs, "independent-marker", f.agent.id);
    expect(() => grade()).not.toThrow();
    for (const change of [{ body: "old output" }, { createdByAgentId: "board" }, { createdByRunId: f.leadRun.id }, { id: "stale-revision" }]) {
      expect(() => grade(document, [{ ...revision, ...change }])).toThrow();
    }
    expect(() => grade({ ...document, issueId: "other" })).toThrow();
    expect(() => grade({ ...document, key: "plan" })).toThrow();
    expect(() => grade(document, [])).toThrow();
    expect(() => grade(document, [revision], [])).toThrow();
  });
});
