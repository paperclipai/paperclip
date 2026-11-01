import { describe, expect, it } from "vitest";
import { assertHireAuditCoverage, assertHireBinding, assertHireDocument, assertHireRuns, assertHireTaskCreation, hireDelegateNames, observedHireResources, readHireConnectionChoice, type HireScope } from "./hire-delegate-evidence.js";
import { defaultAiConnectionForHire } from "../../../server/src/services/agent-ai-connection-default.js";
import { agentJourneyRuns, journeyRequiredChecks } from "./success-contract.js";

type Row = Record<string, any>;
const scope: HireScope = { companyId: "company", leadId: "lead", chatId: "chat", projectId: "project", campaignId: "journey-1-deadbeef",
  origin: "https://qa.example.test", issuePrefix: "TEST",
  model: "fixed-model", provider: "opencode", environmentId: "daytona", connectionBinding: { connectionId: "connection" } };
function fixture() {
  const names = hireDelegateNames(scope.campaignId);
  const agent = { id: "hire", companyId: scope.companyId, name: names.hire, reportsTo: scope.leadId, adapterType: "paperclip_runner",
    adapterConfig: { model: scope.model }, runtimeConfig: { aiConnection: scope.connectionBinding } };
  const task = { id: "task", title: names.checklist, identifier: "TEST-1", companyId: scope.companyId, projectId: scope.projectId, status: "done", assigneeAgentId: agent.id };
  const run = (id: string, issueId: string, agentId: string) => ({ id, companyId: scope.companyId, agentId, issueId, status: "succeeded", runtimeMode: "native",
    contextSnapshot: { issueId, paperclipEnvironment: { id: scope.environmentId } }, runnerProfileJson: { nativeExecutionInput: { provider: { kind: scope.provider, model: scope.model } } } });
  const leadRun = run("lead-run", scope.chatId, scope.leadId), taskRun = run("task-run", task.id, agent.id);
  const event = (action: string, entityId: string): Row => ({ companyId: scope.companyId, actorType: "agent", actorId: scope.leadId, agentId: scope.leadId, runId: leadRun.id, action, entityId, entityType: action.startsWith("agent.") ? "agent" : "issue",
    details: { assigneeAgentId: agent.id, assigneeUserId: null, status: "todo" } });
  const state = { agents: [agent], tasks: [task], leadRuns: [leadRun], activity: [event("agent.hire_created", agent.id), event("issue.created", task.id)] };
  return { agent, task, leadRun, taskRun, state, event, run };
}
function completionFixture() {
  const f = fixture(), second = { ...f.task, id: "review", identifier: "TEST-2" };
  const requested = ["message-1", "message-2", "message-3"].map((id, i) => ({ ...f.run(`lead-${i}`, scope.chatId, scope.leadId),
    contextSnapshot: { ...f.leadRun.contextSnapshot, source: "issue.comment", wakeCommentId: id } }));
  const callbacks = [f.task, second].map((task, i) => ({ ...f.run(`completion-${i}`, scope.chatId, scope.leadId), invocationSource: "automation", triggerDetail: "system",
    contextSnapshot: { ...f.leadRun.contextSnapshot, wakeReason: "chat_task_completed", wakeSource: "automation", wakeTriggerDetail: "system",
      chatCompletionDeliveryIds: [`delivery-${i}`], chatCompletionUpdates: [{ id: task.id, status: "done" }] } }));
  const runs = [...requested, ...callbacks, f.taskRun, f.run("review-run", second.id, f.agent.id)];
  const comments = callbacks.map(run => ({ companyId: scope.companyId, issueId: scope.chatId, authorAgentId: scope.leadId, createdByRunId: run.id, body: `Completed [saved result](/TEST/issues/${[f.task, second][callbacks.indexOf(run)]!.identifier})` }));
  const grade = (value = runs, replies = comments) => assertHireRuns(scope, f.agent.id, [f.task, second], value, 7, ["message-1", "message-2", "message-3"], replies);
  return { f, second, requested, callbacks, runs, comments, grade };
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
  it("accepts the canonical responsible-user fallback only for the independently approved same credential choice", () => {
    const f = fixture(), delegated = { provider: "openrouter", method: "api_key", mode: "delegated", connectionId: "approved", grantId: "grant" };
    const scoped = { ...scope, connectionBinding: delegated,
      connectionChoice: { connectionId: "approved", grantId: "grant", provider: "openrouter", method: "api_key", responsibleUserId: "user" } };
    Object.assign(f.agent.runtimeConfig, { aiConnection: { provider: "openrouter", method: "api_key", mode: "responsible_user" } });
    expect(() => assertHireBinding(scoped, [f.agent])).not.toThrow();
    expect(() => assertHireBinding({ ...scope, connectionBinding: delegated }, [f.agent])).toThrow();
    expect(() => assertHireBinding({ ...scoped, connectionChoice: { ...scoped.connectionChoice, grantId: "foreign" } }, [f.agent])).toThrow();
  });
  it("uses the production delegated fallback and the actual requesting user's same approved personal default", async () => {
    const binding = { provider: "openrouter", method: "api_key", mode: "delegated", connectionId: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002" };
    expect(defaultAiConnectionForHire("paperclip_runner", { provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" }, binding))
      .toEqual({ provider: "openrouter", method: "api_key", mode: "responsible_user" });
    const selected = { id: binding.connectionId, grantId: binding.grantId, companyId: scope.companyId, provider: binding.provider,
      method: binding.method, ownership: "personal", ownerUserId: "user", isDefault: true, status: "connected" };
    const listed = { currentUserId: "user", connections: [selected] };
    const installed = { connectionId: binding.connectionId, installs: [{ companyId: scope.companyId, targetType: "agent", targetId: "hire" }] };
    const api = { async get<T>(route: string): Promise<T> { return (route.endsWith("/installs") ? installed : listed) as T; } };
    const input = { companyId: scope.companyId, responsibleUserId: "user", binding, hiredId: "hire" };
    await expect(readHireConnectionChoice(api, input)).resolves.toMatchObject({ connectionId: binding.connectionId, grantId: binding.grantId, responsibleUserId: "user" });
    for (const mutate of [() => { listed.currentUserId = "operator"; }, () => { selected.grantId = "foreign"; },
      () => { selected.ownerUserId = "operator"; }, () => { selected.status = "revoked"; },
      () => { selected.isDefault = false; }, () => { installed.installs[0]!.targetId = "foreign"; }]) {
      const before = structuredClone({ listed, installed }); mutate();
      await expect(readHireConnectionChoice(api, input)).rejects.toMatchObject({ code: "hire_connection_choice_mismatch" });
      Object.assign(listed, before.listed); Object.assign(selected, before.listed.connections[0]); listed.connections = [selected]; Object.assign(installed, before.installed);
    }
  });
  it("distinguishes the subscription hire placeholder from the approved resolved native method", async () => {
    const f = fixture(), binding = { provider: "openai", method: "subscription", mode: "delegated",
      connectionId: "00000000-0000-4000-8000-000000000001", grantId: "00000000-0000-4000-8000-000000000002" };
    const placeholder = defaultAiConnectionForHire("paperclip_runner", { provider: "codex", model: "fixed-model" }, binding);
    expect(placeholder).toEqual({ provider: "openai", method: "api_key", mode: "responsible_user" });
    const selected = { id: binding.connectionId, grantId: binding.grantId, companyId: scope.companyId, provider: binding.provider,
      method: binding.method, ownership: "personal", ownerUserId: "user", isDefault: true, status: "connected" };
    const installed = { connectionId: binding.connectionId, installs: [{ companyId: scope.companyId, targetType: "agent", targetId: f.agent.id }] };
    const api = { async get<T>(route: string): Promise<T> { return (route.endsWith("/installs") ? installed : { currentUserId: "user", connections: [selected] }) as T; } };
    const input = { companyId: scope.companyId, responsibleUserId: "user", binding, hiredId: f.agent.id };
    const connectionChoice = await readHireConnectionChoice(api, input);
    const scoped = { ...scope, provider: "codex", connectionBinding: binding, connectionChoice };
    const hired = { ...f.agent, runtimeConfig: { aiConnection: placeholder } };
    expect(() => assertHireBinding(scoped, [hired])).not.toThrow();
    expect(() => assertHireBinding({ ...scoped, connectionChoice: { ...connectionChoice!, grantId: "unapproved" } }, [hired])).toThrow("hire_native_binding_mismatch");
    for (const altered of [{ ...placeholder, provider: "anthropic" }, { ...placeholder, mode: "delegated" }, { ...placeholder, method: "subscription" }]) {
      expect(() => assertHireBinding(scoped, [{ ...hired, runtimeConfig: { aiConnection: altered } }])).toThrow("hire_native_binding_mismatch");
    }
    selected.grantId = "unapproved";
    await expect(readHireConnectionChoice(api, input)).rejects.toMatchObject({ code: "hire_connection_choice_mismatch" });
    const run = { ...f.taskRun, runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex", model: scope.model } } },
      contextSnapshot: { ...f.taskRun.contextSnapshot, aiConnection: { ...binding, mode: "responsible_user", responsibleUserId: "user" } } };
    expect(() => assertHireRuns(scoped, hired.id, [f.task], [run])).not.toThrow();
    expect(() => assertHireRuns(scoped, hired.id, [f.task], [{ ...run,
      contextSnapshot: { ...run.contextSnapshot, aiConnection: { ...run.contextSnapshot.aiConnection, method: "api_key" } } }])).toThrow("hire_run_credential_mismatch");
  });
  it("requires actual execution attribution to keep the approved credential and responsible user", () => {
    const f = fixture(), connectionChoice = { connectionId: "approved", grantId: "grant", provider: "openrouter", method: "api_key", responsibleUserId: "user" };
    const scoped = { ...scope, connectionChoice }, run = { ...f.taskRun, contextSnapshot: { ...f.taskRun.contextSnapshot,
      aiConnection: { ...connectionChoice, mode: "responsible_user" } } };
    expect(() => assertHireRuns(scoped, f.agent.id, [f.task], [run])).not.toThrow();
    for (const field of ["connectionId", "grantId", "provider", "method", "responsibleUserId", "mode"]) {
      expect(() => assertHireRuns(scoped, f.agent.id, [f.task], [{ ...run,
        contextSnapshot: { ...run.contextSnapshot, aiConnection: { ...run.contextSnapshot.aiConnection, [field]: "foreign" } } }])).toThrow("hire_run_credential_mismatch");
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
  it("rejects a lead task run from create-self-then-reassign even after the saved assignee is correct", () => {
    const f = fixture();
    const delegation = { ...f.run("delegate-chat", scope.chatId, scope.leadId), status: "running" };
    const extra = { ...f.run("self-assigned-task", f.task.id, scope.leadId), status: "cancelled", errorCode: "issue_reassigned" };
    const child = { ...f.taskRun, status: "running" };
    expect(f.task.assigneeAgentId).toBe(f.agent.id);
    expect(() => assertHireRuns(scope, f.agent.id, [f.task], [f.leadRun, delegation, extra, child])).toThrow("hire_run_scope_mismatch");
    expect(() => assertHireRuns(scope, f.agent.id, [f.task], [f.leadRun, f.taskRun])).not.toThrow();
  });
  it("accounts for three requested lead turns, two exact completion callbacks and two child runs", () => {
    const { f, second, callbacks, runs, comments, grade } = completionFixture();
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
  it.each([0, 1])("requires callback %s to save its own completed task link", index => {
    const { runs, comments, grade } = completionFixture();
    const changed = comments.map((comment, i) => i === index ? { ...comment, body: "Completed saved result" } : comment);
    expect(() => grade(runs, changed)).toThrow("hire_completion_reply_missing");
  });
  it.each(["foreign", "code", "fenced-code", "wrong-task", "earlier-handoff-only"])("rejects a %s completion link despite seven successful native runs", variant => {
    const { f, requested, runs, comments, grade } = completionFixture();
    const changed = comments.map((comment, i) => ({ ...comment, body: variant === "foreign"
      ? `[TEST-${i + 1}](https://foreign.test/TEST/issues/TEST-${i + 1})`
      : variant === "code" ? `\`[saved result](/TEST/issues/TEST-${i + 1})\``
        : variant === "fenced-code" ? `\`\`\`markdown\n[saved result](/TEST/issues/TEST-${i + 1})\n\`\`\``
        : variant === "wrong-task" ? "[other result](/TEST/issues/TEST-999)" : "Completed saved result" }));
    if (variant === "earlier-handoff-only") changed.push({ ...comments[0]!, createdByRunId: requested[1]!.id,
      body: `[first](/TEST/issues/${f.task.identifier}) and [second](/TEST/issues/TEST-2)` });
    expect(runs).toHaveLength(7);
    expect(() => grade(runs, changed)).toThrow("hire_completion_reply_missing");
  });
  it("requires immutable native creation ownership independently of current assignment and run count", () => {
    const f = fixture();
    expect(() => assertHireTaskCreation(scope, f.agent.id, [f.task], f.state.activity, [f.leadRun])).not.toThrow();
    for (const mutate of [
      (event: Row) => { event.details.assigneeAgentId = scope.leadId; event.details.status = "backlog"; },
      (event: Row) => { delete event.details.assigneeAgentId; },
      (event: Row) => { event.details.assigneeUserId = "user"; },
      (event: Row) => { event.actorId = "foreign"; },
      (event: Row) => { event.companyId = "foreign"; },
      (event: Row) => { event.runId = "foreign"; },
    ]) {
      const activity = structuredClone(f.state.activity); mutate(activity[1]!);
      expect(f.task.assigneeAgentId).toBe(f.agent.id);
      expect(() => assertHireTaskCreation(scope, f.agent.id, [f.task], activity, [f.leadRun])).toThrow("hire_initial_assignee_mismatch");
    }
  });
  it("accepts the actual UI's task auto-links and reference-style links in each callback", () => {
    const { runs, comments, grade } = completionFixture();
    expect(() => grade(runs, comments.map((comment, i) => ({ ...comment, body: `Completed TEST-${i + 1}.` })))).not.toThrow();
    expect(() => grade(runs, comments.map((comment, i) => ({ ...comment,
      body: `Completed [saved result][task].\n\n[task]: /TEST/issues/TEST-${i + 1}` })))).not.toThrow();
  });
  it.each(["heading", "list", "table", "fence", "table-link"])("accepts callback task links in %s replies without grading unrelated Markdown", shape => {
    const { runs, comments, grade } = completionFixture();
    const changed = comments.map((comment, i) => {
      const link = `[saved result](/TEST/issues/TEST-${i + 1})`;
      const table = "| Check | Result |\n| --- | --- |\n| File | Saved |";
      return { ...comment, body: shape === "heading" ? `## Completed\n\n${link}`
        : shape === "list" ? `- Completed\n  - ${link}`
          : shape === "table" ? `${link}\n\n${table}`
            : shape === "fence" ? `\`\`\`markdown\n[not a link](/TEST/issues/TEST-999)\n\`\`\`\n\n${link}`
              : `| Result |\n| --- |\n| ${link} |` };
    });
    expect(() => grade(runs, changed)).not.toThrow();
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
