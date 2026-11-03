import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sendHireHandoffMessage } from "./hire-delegate-composer.js";
import { completionDeliveryJourney } from "./completion-delivery-flow.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";

vi.mock("./hire-delegate-composer.js", () => ({ sendHireHandoffMessage: vi.fn() }));
vi.mock("./task-document-flow.js", () => ({ openDocumentAuthoring: vi.fn() }));
vi.mock("@playwright/test", () => ({ expect: () => ({ toBeVisible: async () => {}, toContainText: async () => {} }) }));
type Row = Record<string, any>;
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.mocked(sendHireHandoffMessage).mockReset();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(mode: "healthy" | "extra-run" | "journey-deadline") {
  const base = 1_000_000, deadlineAt = base + 300_000, campaignId = "journey-1-window";
  let now = base, sent = false, request = "", batches = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(1000);
    // The next batch is admitted just before the unchanged 120-second cutoff.
    now = base + 119_999; callback(); return {};
  }) as typeof setTimeout);
  const lead = { id: "lead", name: "Owned lead", provider: "opencode", model: "configured-model", runtimeMode: "native" };
  const worker = { ...lead, id: "worker", name: "Owned worker" };
  const project = { id: "project", companyId: "company", name: `Journey QA completion-delivery ${campaignId}` };
  const chat = { id: "source", companyId: "company", title: `Chat with ${lead.name}`,
    assigneeAgentId: lead.id, conversationAgentId: lead.id, conversationUserId: "user", createdByUserId: "user" };
  const marker = `COMPLETION${campaignId.replace(/[^a-z0-9]/gi, "")}`;
  const body = `Reference: ${marker}\nVerify the release with the smoke suite.\nRoll back the release if the smoke suite fails.`;
  const task = { id: "task", identifier: "QA-1", companyId: "company", title: `Completion brief ${campaignId}`, projectId: project.id,
    assigneeAgentId: worker.id, createdByAgentId: lead.id, status: "done", completedAt: "2020-01-01T00:00:01Z" };
  const native = { companyId: "company", status: "succeeded", runtimeMode: "native",
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: lead.provider, model: lead.model } } } };
  const environment = { paperclipEnvironment: { id: "environment" } };
  const requestRun = { ...native, id: "request-run", agentId: lead.id, issueId: chat.id,
    contextSnapshot: { ...environment, source: "issue.comment", issueId: chat.id, wakeCommentId: "request" } };
  const workerRun = { ...native, id: "worker-run", agentId: worker.id, issueId: task.id, contextSnapshot: { ...environment, issueId: task.id } };
  const callbackRun = { ...native, id: "callback-run", agentId: lead.id, issueId: chat.id, invocationSource: "automation", triggerDetail: "system",
    contextSnapshot: { ...environment, issueId: chat.id, wakeReason: "chat_task_completed", wakeSource: "automation", wakeTriggerDetail: "system",
      chatCompletionDeliveryIds: ["delivery"], chatCompletionUpdates: [{ id: task.id, status: "done" }] } };
  const document = { id: "document", companyId: "company", issueId: task.id, key: "completion-brief", body, latestRevisionId: "revision" };
  const events = [{ id: "creation", companyId: "company", actorType: "agent", actorId: lead.id, agentId: lead.id, entityType: "issue",
    entityId: task.id, action: "issue.created", runId: requestRun.id, details: { assigneeAgentId: worker.id, assigneeUserId: null } }];
  const api = { origin: "https://qa.example.test", async post(route: string) { expect(route).toBe("/api/companies/company/projects"); return project; },
    async get(route: string) {
      const agent = [lead, worker].find(row => route === `/api/agents/${row.id}`);
      if (agent) return { ...agent, companyId: "company", adapterType: "paperclip_runner", adapterConfig: { model: lead.model },
        defaultEnvironmentId: "environment", ...(agent.id === worker.id ? { reportsTo: lead.id } : {}) };
      if (route === "/api/instance/settings/experimental") return { enableAgentChat: true };
      if (route === "/api/companies/company/chats/lead") {
        if (!sent) return null;
        batches += 1;
        // This healthy read finishes after the admission cutoff. Later reads
        // belong to this batch and must still obey the overall journey deadline.
        if (batches === 2) now = mode === "journey-deadline" ? deadlineAt + 1 : base + 120_001;
        if (batches > 2) throw new Error("A new observation batch started after the cutoff");
        return chat;
      }
      const extra = mode === "extra-run" && batches === 2;
      if (route === "/api/issues/source/runs") return [requestRun, callbackRun, ...(extra ? [{ ...callbackRun, id: "extra-run" }] : [])].map(row => ({ runId: row.id }));
      if (route === "/api/issues/task/runs") return [{ runId: workerRun.id }];
      const run = [requestRun, callbackRun, workerRun, { ...callbackRun, id: "extra-run" }].find(row => route === `/api/heartbeat-runs/${row.id}`);
      if (run) return run;
      if (route === "/api/companies/company/activity?agentId=lead&limit=500") return events;
      if (route === "/api/issues/task") return task;
      if (route === "/api/issues/task/documents") return [{ key: document.key }];
      if (route === "/api/issues/task/documents/completion-brief") return document;
      if (route === "/api/issues/task/documents/completion-brief/revisions") return [{ id: "revision", body, createdByAgentId: worker.id, createdByRunId: workerRun.id }];
      if (route === "/api/issues/source/comments?order=asc") return [
        { id: "request", companyId: "company", issueId: chat.id, authorUserId: "user", body: request },
        { id: "reply", companyId: "company", issueId: chat.id, authorAgentId: lead.id, createdByRunId: callbackRun.id,
          createdAt: "2020-01-01T00:00:02Z", body: "The brief is ready: [saved brief](/QA/issues/QA-1)." }];
      throw new Error(`Unexpected fixture read ${route}`);
    } };
  vi.mocked(sendHireHandoffMessage).mockImplementation(async (_page, value) => { sent = true; request = value; });
  const locator: any = { locator: () => locator, first: () => locator, getByRole: () => locator, click: async () => {},
    evaluateAll: async () => ["/QA/issues/QA-1"] };
  const page = { goto: async () => {}, reload: async () => {}, locator: () => locator, getByTestId: () => locator };
  const context = { api, page, agent: lead, fixtures: { completionWorker: worker }, company: { id: "company", issuePrefix: "QA" },
    user: { id: "user" }, environmentId: "environment" } as unknown as JourneyContext;
  const directory = await mkdtemp(path.join(os.tmpdir(), "completion-window-")); directories.push(directory);
  const evidence = { checks: [] } as unknown as JourneyEvidence, capture = vi.fn(async () => {});
  return { batches: () => batches, now: () => now, deadlineAt, directory, evidence, capture,
    run: () => completionDeliveryJourney(context, { async own() {} } as unknown as TargetSession, campaignId, evidence,
      { directory, deadlineAt, capture }) };
}

it("finishes a healthy batch admitted before the full completion window ends, without admitting another batch", async () => {
  const f = await fixture("healthy");
  await f.run();
  expect(f.batches()).toBe(2); expect(f.now()).toBe(1_120_001);
  expect(f.evidence.checks.length).toBeGreaterThan(0); expect(f.evidence.checks.every(row => row.passed)).toBe(true);
  const retained = JSON.parse(await readFile(path.join(f.directory, "completion-delivery.json"), "utf8"));
  expect(retained.observation.runs).toHaveLength(3); expect(retained.checks.every((row: Row) => row.passed)).toBe(true);
  expect(retained.events).toEqual([expect.objectContaining({ id: "creation", runId: "request-run", entityId: "task" })]);
  expect(f.capture).toHaveBeenCalledTimes(1); expect(sendHireHandoffMessage).toHaveBeenCalledTimes(1);
});
it("rejects a fourth native run discovered in the admitted boundary batch", async () => {
  const f = await fixture("extra-run");
  await expect(f.run()).rejects.toMatchObject({ code: "completion_run_binding_mismatch" });
  expect(f.batches()).toBe(2); expect(f.capture).not.toHaveBeenCalled();
});
it("still fails closed when the admitted batch crosses the original journey deadline", async () => {
  const f = await fixture("journey-deadline");
  await expect(f.run()).rejects.toMatchObject({ code: "observation_read_deadline" });
  expect(f.now()).toBeGreaterThan(f.deadlineAt); expect(f.capture).not.toHaveBeenCalled();
});
