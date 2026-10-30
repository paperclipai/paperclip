import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionFailure } from "../connection-config.js";
import { sendChatMessage, readChatOutputDocument } from "../chat-flow.js";
import { hireDelegateReuse, openSavedHireResult } from "./hire-delegate-flow.js";
import { hireDelegateNames } from "./hire-delegate-evidence.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

// These tests exercise the real journey observation/ownership path. Browser
// controls are stubs; they do not claim a live user-journey pass.
vi.mock("@playwright/test", () => ({ expect: (value: unknown) => Object.assign(expect(value), { toBeVisible: async () => {}, toHaveURL: async (predicate: (url: URL) => boolean) => { expect(predicate(new URL("https://qa.example.test/QA/issues/QA-2"))).toBe(true); } }) }));
vi.mock("../chat-flow.js", () => ({ sendChatMessage: vi.fn(), readChatOutputDocument: vi.fn() }));
type Row = Record<string, any>;
const directories: string[] = [];
afterEach(async () => { vi.mocked(sendChatMessage).mockReset(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture(options: { readError?: Error; mutate?(agents: Row[], tasks: Row[]): void; ownError?: Error; firstSendError?: Error } = {}) {
  const campaignId = "journey-1-deadbeef", names = hireDelegateNames(campaignId), owned: Row[] = [], comments: Row[] = [];
  const binding = { connectionId: "approved" }, lead = { id: "lead", companyId: "company", name: `Lead ${campaignId}`, permissions: { canCreateAgents: true }, runtimeConfig: { aiConnection: binding } };
  const hire = { id: "hired", companyId: "company", name: names.hire, reportsTo: lead.id, adapterType: "paperclip_runner",
    adapterConfig: { model: "fixed-model" }, runtimeConfig: { aiConnection: binding } };
  const agents: Row[] = [lead, hire], tasks: Row[] = [];
  const chat = { id: "chat", companyId: "company", title: `Chat with ${lead.name}`, assigneeAgentId: lead.id, conversationAgentId: lead.id,
    conversationUserId: "user", createdByUserId: "user", status: "in_review", conversationState: "waiting" };
  const run = { id: "lead-run", companyId: "company", agentId: lead.id, issueId: chat.id, status: "succeeded", runtimeMode: "native",
    contextSnapshot: { source: "issue.comment", wakeCommentId: "user-comment", paperclipEnvironment: { id: "environment" } }, runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "fixed-model" } } } };
  options.mutate?.(agents, tasks);
  const audit = (action: string, entityId: string) => ({ companyId: "company", actorType: "agent", actorId: lead.id, agentId: lead.id, runId: run.id, action, entityId, entityType: action.startsWith("agent.") ? "agent" : "issue" });
  const activity = [audit("agent.hire_created", hire.id), ...tasks.map(task => audit("issue.created", task.id))];
  let sent = false, failedRead = false, runReads = 0;
  const stop = new JourneyError("failed", "test_stop_before_delegation");
  vi.mocked(sendChatMessage).mockImplementation(async (_page, text) => {
    if (sent) throw stop;
    sent = true; if (options.firstSendError) throw options.firstSendError; comments.push({ id: "user-comment", authorUserId: "user", body: text });
  });
  const api = { origin: "https://qa.example.test", async get(route: string) {
    if (route === "/api/instance/settings/experimental") return { enableAgentChat: true };
    if (route === "/api/companies/company") return { requireBoardApprovalForNewAgents: false };
    if (route === "/api/agents/lead") return lead;
    if (route === "/api/companies/company/chats/lead") return sent ? chat : null;
    if (route === "/api/issues/chat/runs") {
      runReads++;
      if (options.readError && !failedRead) { failedRead = true; throw options.readError; }
      return [{ runId: run.id }];
    }
    if (route === "/api/heartbeat-runs/lead-run") return run;
    if (route === "/api/agents/hired") return agents.find(row => row.id === "hired");
    if (route.startsWith("/api/issues/") && tasks.some(row => route === `/api/issues/${row.id}`)) return tasks.find(row => route === `/api/issues/${row.id}`);
    if (route === "/api/companies/company/agents") return agents;
    if (route === "/api/companies/company/issues") return tasks;
    if (route === "/api/companies/company/activity?agentId=lead&limit=500") return activity;
    if (route === "/api/issues/chat/comments?order=asc") return structuredClone(comments);
    throw new Error(`Unexpected read ${route}`);
  }, async post(route: string) {
    expect(route).toBe("/api/companies/company/projects"); return { id: "project", companyId: "company", name: names.project };
  } };
  const context = { api, page: { async goto() {}, getByTestId() { return {}; } }, user: { id: "user" }, company: { id: "company", issuePrefix: "QA" },
    agent: { id: lead.id, model: "fixed-model", provider: "opencode", runtimeMode: "native" }, environmentId: "environment" } as unknown as JourneyContext;
  const session = { async own(row: Row) { if (row.id === hire.id && options.ownError) throw options.ownError; owned.push(row); } } as unknown as TargetSession;
  const evidence = { checks: [] } as unknown as JourneyEvidence;
  const directory = await mkdtemp(path.join(os.tmpdir(), "hire-observation-")); directories.push(directory);
  return { owned, evidence, stop, runReads: () => runReads,
    run: () => hireDelegateReuse(context, session, campaignId, evidence, { deadlineAt: Date.now() + 10_000, directory, capture: async () => {} }) };
}

it.each(["api_status_503", "api_request_failed"])("recovers a transient %s read without replaying the first user turn", async code => {
  const f = await fixture({ readError: new ConnectionFailure(code) });
  await expect(f.run()).rejects.toBe(f.stop);
  expect(f.runReads()).toBe(2);
  expect(f.evidence.checks).toContainEqual({ id: "one-attributed-native-hire", passed: true });
  expect(vi.mocked(sendChatMessage).mock.calls.filter(([, text]) => text.startsWith("Hire exactly one"))).toHaveLength(1);
});
it.each([new JourneyError("failed", "api_status_503"), new ConnectionFailure("api_status_403"), new ConnectionFailure("api_status_500"), new Error("api_request_failed")])(
  "never retries a candidate, identity, application or unknown error: %s", async readError => {
    const f = await fixture({ readError }); await expect(f.run()).rejects.toBe(readError);
    expect(f.runReads()).toBe(1); expect(sendChatMessage).toHaveBeenCalledTimes(1);
  },
);
it("never retries ownership callbacks, whose mutations may already have committed", async () => {
  const ownError = new ConnectionFailure("api_request_failed"), f = await fixture({ ownError });
  await expect(f.run()).rejects.toBe(ownError); expect(f.runReads()).toBe(1); expect(sendChatMessage).toHaveBeenCalledTimes(1);
});
it.each(["manager", "project", "foreign-company"])("owns proven same-company children before rejecting a %s scope mismatch", async mismatch => {
  const f = await fixture({ mutate(agents, tasks) {
    if (mismatch === "manager") agents[1]!.reportsTo = "other";
    else tasks.push({ id: "unexpected-task", companyId: mismatch === "foreign-company" ? "foreign" : "company",
      title: "Unexpected task", projectId: "other-project" });
  } });
  await expect(f.run()).rejects.toMatchObject({ code: "hire_resource_scope_mismatch" });
  expect(f.owned.some(row => row.id === "hired")).toBe(true);
  expect(f.owned.some(row => row.id === "unexpected-task")).toBe(mismatch === "project");
  expect(sendChatMessage).toHaveBeenCalledTimes(1);
});

it("persists an exact fresh-chat intent before a first send can commit and fail", async () => {
  const firstSendError = new ConnectionFailure("api_request_failed"), f = await fixture({ firstSendError });
  await expect(f.run()).rejects.toBe(firstSendError);
  expect(f.owned).toContainEqual({ kind: "issue", name: "Chat with Lead journey-1-deadbeef", journeyId: "hire-delegate-reuse",
    freshChat: { companyId: "company", userId: "user", leadAgentId: "lead", absent: true } });
  expect(sendChatMessage).toHaveBeenCalledTimes(1);
});

it("waits for reloaded replies and links, then clicks and reloads the exact saved child", async () => {
  let visibleReads = 0, linkReads = 0, clicks = 0, reloads = 0;
  const href = "/QA/issues/QA-2";
  const reply = { async isVisible() { return ++visibleReads > 2; }, locator(selector: string) {
    if (selector === "a[href]") return { async evaluateAll() { return ++linkReads > 1 ? ["https://foreign.test/QA/issues/QA-2", href] : []; } };
    expect(selector).toBe(`a[href=${JSON.stringify(href)}]`);
    return { first() { return { async click() { clicks++; } }; } };
  } };
  const page = { locator(selector: string) { expect(selector).toBe('[id="comment-saved"]'); return reply; },
    async reload() { reloads++; }, getByTestId(id: string) { expect(id).toBe("issue-detail-header"); return { getByRole(role: string, options: Row) {
      expect(role).toBe("heading"); expect(options).toEqual({ name: "Saved review", exact: true }); return {}; } }; } };
  expect(await openSavedHireResult(page as any, "https://qa.example.test", "QA", [{ id: "saved", authorAgentId: "lead" }], "lead",
    { id: "review", identifier: "QA-2", title: "Saved review" }, Date.now() + 3000)).toBe(true);
  expect(visibleReads).toBe(4); expect(linkReads).toBe(2); expect(clicks).toBe(1); expect(reloads).toBe(1);
});
it("ends a missing saved result at the original deadline without a click or replay", async () => {
  const page = { locator() { return { async isVisible() { return false; } }; } };
  expect(await openSavedHireResult(page as any, "https://qa.example.test", "QA", [{ id: "saved", authorAgentId: "lead" }], "lead",
    { id: "review", identifier: "QA-2", title: "Saved review" }, Date.now() + 10)).toBe(false);
});

it.each(["stale", "foreign", "truncated", "late-reply", "wrong-author", "activity-linked", "foreign-run", "contradictory-run", "extra-run"])("re-reads %s callback task state while preserving strict scope and seven-run accounting", async snapshot => {
  const campaignId = "journey-1-deadbeef", names = hireDelegateNames(campaignId), binding = { connectionId: "approved" };
  const lead = { id: "lead", companyId: "company", name: `Lead ${campaignId}`, permissions: { canCreateAgents: true },
    adapterConfig: { model: "fixed-model" }, runtimeConfig: { aiConnection: binding } };
  const hired = { ...lead, id: "hired", name: names.hire, reportsTo: "lead", adapterType: "paperclip_runner" };
  const chat = { id: "chat", companyId: "company", title: `Chat with ${lead.name}`, assigneeAgentId: "lead", conversationAgentId: "lead",
    conversationUserId: "user", createdByUserId: "user", status: "in_review", conversationState: "waiting" };
  const runs: Row[] = [], tasks: Row[] = [], comments: Row[] = [], activity: Row[] = [], stages: number[] = [];
  let sent = 0, callbackPoll = 0;
  const replyPolls = new Map<string, number>(), nativeReads = new Map<string, number>();
  const run = (id: string, issueId: string, agentId: string, metadata: Row = {}) => {
    const value = { id, companyId: "company", agentId, issueId, status: "succeeded", runtimeMode: "native",
      contextSnapshot: { issueId, paperclipEnvironment: { id: "environment" }, aiConnection: binding, ...metadata },
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "fixed-model" } } } };
    runs.push(value); return value;
  };
  const audit = (action: string, entityId: string) => activity.push({ companyId: "company", actorType: "agent", actorId: "lead", agentId: "lead", runId: `lead-${sent}`, action, entityId, entityType: action.startsWith("agent.") ? "agent" : "issue" });
  vi.mocked(sendChatMessage).mockImplementation(async (_page, text) => {
    stages.push(runs.length); sent++; callbackPoll = 0;
    comments.push({ id: `user-${sent}`, companyId: "company", issueId: "chat", authorUserId: "user", body: text });
    run(`lead-${sent}`, "chat", "lead", { source: "issue.comment", wakeCommentId: `user-${sent}` });
    if (sent === 1) audit("agent.hire_created", "hired");
    else {
      const task = { id: `task-${sent}`, identifier: `QA-${sent - 1}`, companyId: "company", title: sent === 2 ? names.checklist : names.review,
        assigneeAgentId: "hired", projectId: "project", parentId: null, status: "done" };
      tasks.push(task); audit("issue.created", task.id); run(`child-${sent}`, task.id, "hired");
      if (snapshot === "extra-run" && sent === 3) run("extra-native", "chat", "lead", { source: "issue.comment", wakeCommentId: `user-${sent}` });
    }
  });
  const marker = `HIRE${campaignId.replace(/[^a-z0-9]/gi, "")}`;
  const document = (taskId: string) => ({ id: `doc-${taskId}`, issueId: taskId, companyId: "company", key: "result", updatedAt: "2020-01-01T00:00:00Z", latestRevisionId: `revision-${taskId}`,
    body: `Reference: ${taskId === "task-2" ? marker : `REVIEW${marker}`}` });
  vi.mocked(readChatOutputDocument).mockImplementation(async (_api, taskId) => document(taskId));
  const api = { origin: "https://qa.example.test", async get(route: string) {
    if (route === "/api/instance/settings/experimental") return { enableAgentChat: true };
    if (route === "/api/companies/company") return { requireBoardApprovalForNewAgents: false };
    if (route === "/api/agents/lead") return lead;
    if (route === "/api/companies/company/chats/lead") return sent ? chat : null;
    if (route === "/api/agents/hired") return hired;
    if (route === "/api/companies/company/agents") return sent ? [lead, hired] : [lead];
    if (route === "/api/companies/company/issues" && snapshot === "truncated") return Array.from({ length: 500 }, (_, i) => ({ id: `old-${i}`, companyId: "company", title: "Higher priority existing work", projectId: "other", status: "backlog" }));
    if (route === "/api/companies/company/issues") return tasks.map(task => ({ ...task,
      status: runs.some(row => row.id === `completion-${sent}`) && task.id === `task-${sent}` ? "in_progress" : task.status }));
    if (route === "/api/companies/company/activity?agentId=lead&limit=500") return activity;
    if (route === "/api/issues/chat/comments?order=asc") {
      if (["late-reply", "wrong-author"].includes(snapshot)) for (const callback of runs.filter(run => run.id.startsWith("completion-"))) {
        if (comments.some(comment => comment.createdByRunId === callback.id)) continue;
        const count = (replyPolls.get(callback.id) ?? 0) + 1; replyPolls.set(callback.id, count);
        if (snapshot === "wrong-author" || count > 1) comments.push({ id: `reply-${callback.id}`, companyId: "company", issueId: "chat",
          authorAgentId: snapshot === "wrong-author" ? "foreign" : "lead", createdByRunId: callback.id, body: "Saved result completed" });
      }
      return structuredClone(comments);
    }
    if (route === "/api/issues/chat/runs" && sent > 1 && !runs.some(row => row.id === `completion-${sent}`) && ++callbackPoll > 1) {
      const callback = run(`completion-${sent}`, "chat", "lead", { wakeReason: "chat_task_completed", wakeSource: "automation", wakeTriggerDetail: "system",
        chatCompletionDeliveryIds: [`delivery-${sent}`], chatCompletionUpdates: [{ id: `task-${sent}`, status: "done" }] });
      Object.assign(callback, { invocationSource: "automation", triggerDetail: "system" });
      if (!["late-reply", "wrong-author"].includes(snapshot)) comments.push({ id: `reply-${sent}`, companyId: "company", issueId: "chat", authorAgentId: "lead", createdByRunId: callback.id, body: "Saved result completed" });
    }
    const issueRuns = /^\/api\/issues\/([^/]+)\/runs$/.exec(route);
    if (issueRuns) return runs.filter(row => row.issueId === issueRuns[1]
      || activity.some(event => event.entityType === "issue" && event.entityId === issueRuns[1] && event.runId === row.id)).map(row => ({ runId: row.id }));
    if (route.startsWith("/api/heartbeat-runs/")) {
      const row = runs.find(row => route.endsWith(`/${row.id}`))!;
      const read = (nativeReads.get(row.id) ?? 0) + 1; nativeReads.set(row.id, read);
      if (snapshot === "foreign-run" && row.id === "child-2") return { ...row, companyId: "foreign" };
      if (snapshot === "contradictory-run" && row.id === "lead-2" && read === 2) return { ...row, agentId: "hired", issueId: "task-2",
        contextSnapshot: { ...row.contextSnapshot, issueId: "task-2" } };
      return row;
    }
    const output = /^\/api\/issues\/([^/]+)\/documents\/result(\/revisions)?$/.exec(route);
    if (output) return output[2] ? [{ id: document(output[1]!).latestRevisionId, body: document(output[1]!).body,
      createdByAgentId: "hired", createdByRunId: `child-${output[1]!.split("-")[1]}` }] : document(output[1]!);
    if (route.startsWith("/api/issues/")) {
      const task = tasks.find(row => route.endsWith(`/${row.id}`));
      return snapshot === "foreign" && task ? { ...task, projectId: "foreign" } : task;
    }
    throw new Error(route);
  }, async post() { return { id: "project", companyId: "company", name: names.project }; } };
  const reply = { async isVisible() { return true; }, locator(selector: string) { return selector === "a[href]"
    ? { async evaluateAll() { return ["/QA/issues/QA-2"]; } } : { first() { return { async click() {} }; } }; } };
  const page = { async goto() {}, async reload() {}, locator() { return reply; }, getByTestId() { return { getByRole() { return {}; } }; } };
  const context = { api, page, user: { id: "user" }, company: { id: "company", issuePrefix: "QA" },
    agent: { id: "lead", model: "fixed-model", provider: "opencode", runtimeMode: "native" }, environmentId: "environment" } as unknown as JourneyContext;
  const evidence = { checks: [] } as unknown as JourneyEvidence, owned: Row[] = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), "hire-completion-")); directories.push(directory);
  const execution = hireDelegateReuse(context, { async own(row: Row) { owned.push(row); } } as unknown as TargetSession, campaignId, evidence,
    { deadlineAt: Date.now() + 10_000, directory, capture: async () => {} });
  if (["foreign", "wrong-author", "foreign-run", "contradictory-run", "extra-run"].includes(snapshot)) {
    const code = snapshot === "foreign" ? "hire_resource_scope_mismatch" : snapshot === "wrong-author" ? "hire_completion_reply_mismatch"
      : snapshot === "extra-run" ? "hire_requested_turn_mismatch" : "hire_run_scope_mismatch";
    await expect(execution).rejects.toMatchObject({ code });
    expect(sendChatMessage).toHaveBeenCalledTimes(snapshot === "extra-run" ? 3 : 2);
    return;
  }
  await execution;
  expect(stages).toEqual([0, 1, 4]); expect(runs).toHaveLength(7); expect(sendChatMessage).toHaveBeenCalledTimes(3);
  expect(evidence.checks).toContainEqual({ id: "delegated-result-visible-after-reload", passed: true });
  expect(owned.find(row => row.id === "chat")?.freshChat).toEqual({ companyId: "company", userId: "user", leadAgentId: "lead", absent: true });
});
