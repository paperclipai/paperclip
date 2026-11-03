import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sendHireHandoffMessage } from "./hire-delegate-composer.js";
import { completionDeliveryJourney } from "./completion-delivery-flow.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";

vi.mock("./hire-delegate-composer.js", () => ({ sendHireHandoffMessage: vi.fn() }));
type Row = Record<string, any>;
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(sendHireHandoffMessage).mockReset();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(sendError?: Error, extraChild = false) {
  const campaignId = "journey-1-deadbeef", owned: Row[] = [], posts: string[] = [];
  const lead = { id: "lead", name: `Lead ${campaignId}`, provider: "opencode", model: "configured-model", runtimeMode: "native" };
  const worker = { ...lead, id: "worker", name: `Worker ${campaignId}` };
  const project = { id: "project", companyId: "company", name: `Journey QA completion-delivery ${campaignId}` };
  const chat = { id: "chat", companyId: "company", title: `Chat with ${lead.name}`,
    assigneeAgentId: lead.id, conversationAgentId: lead.id, conversationUserId: "user", createdByUserId: "user" };
  const task = { id: "actual-child", companyId: "company", title: `Completion brief ${campaignId.replace("-deadbeef", "deadbeef")}`,
    projectId: project.id, assigneeAgentId: worker.id, createdByAgentId: lead.id };
  const children = [task, ...(extraChild ? [{ ...task, id: "extra-child", title: "Extra audited task" }] : [])];
  const sourceRun = { id: "source-run", companyId: "company", agentId: lead.id, issueId: chat.id,
    runtimeMode: "native", contextSnapshot: { source: "issue.comment" } };
  let sent = false;
  vi.mocked(sendHireHandoffMessage).mockImplementation(async () => { sent = true; if (sendError) throw sendError; });
  const api = { origin: "https://qa.example.test", async get(route: string) {
    const agent = [lead, worker].find(row => route === `/api/agents/${row.id}`);
    if (agent) return { ...agent, companyId: "company", adapterType: "paperclip_runner", adapterConfig: { model: lead.model },
      defaultEnvironmentId: "environment", ...(agent.id === worker.id ? { reportsTo: lead.id } : {}) };
    if (route === "/api/instance/settings/experimental") return { enableAgentChat: true };
    if (route === `/api/companies/company/chats/${lead.id}`) return sent ? chat : null;
    if (route === `/api/issues/${chat.id}/runs`) return [{ runId: sourceRun.id }];
    if (route === `/api/heartbeat-runs/${sourceRun.id}`) return sourceRun;
    if (route === `/api/companies/company/activity?agentId=${lead.id}&limit=500`) return children.map(child => ({ id: `creation-${child.id}`, companyId: "company",
      actorType: "agent", actorId: lead.id, agentId: lead.id, entityType: "issue", entityId: child.id, action: "issue.created",
      runId: sourceRun.id, details: { assigneeAgentId: worker.id, assigneeUserId: null } }));
    const child = children.find(row => route === `/api/issues/${row.id}`);
    if (child) return child;
    throw new Error(`Unexpected fixture read ${route}`);
  }, async post(route: string) {
    posts.push(route);
    expect(route).toBe("/api/companies/company/projects");
    return project;
  } };
  const context = { api, page: { async goto() {} }, agent: lead, fixtures: { completionWorker: worker },
    company: { id: "company", issuePrefix: "QA" }, user: { id: "user" }, environmentId: "environment" } as unknown as JourneyContext;
  const session = { async own(row: Row) { owned.push(structuredClone(row)); } } as unknown as TargetSession;
  const directory = await mkdtemp(path.join(os.tmpdir(), "completion-ownership-")); directories.push(directory);
  const evidence = { checks: [] } as unknown as JourneyEvidence;
  return { owned, posts, task, children, run: () => completionDeliveryJourney(context, session, campaignId, evidence,
    { deadlineAt: Date.now() + 10_000, directory, capture: async () => {} }) };
}

it("keeps the fresh-chat creation intent on send failure without inventing a child creation request", async () => {
  const failure = new Error("send boundary failed"), f = await fixture(failure);
  await expect(f.run()).rejects.toBe(failure);
  expect(f.owned.filter(row => row.kind === "issue")).toEqual([{ kind: "issue", name: "Chat with Lead journey-1-deadbeef",
    journeyId: "completion-delivery", freshChat: { companyId: "company", userId: "user", leadAgentId: "lead", absent: true } }]);
  expect(f.posts).toEqual(["/api/companies/company/projects"]);
  expect(sendHireHandoffMessage).toHaveBeenCalledTimes(1);
});

it("owns an audited misnamed child before preserving the wrong-title failure, with no unissued name-only child intent", async () => {
  const f = await fixture();
  await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code: "completion_delegated_task_mismatch" });
  expect(f.owned).toContainEqual({ kind: "issue", id: f.task.id, name: f.task.title, journeyId: "completion-delivery" });
  expect(f.owned.filter(row => row.kind === "issue" && !row.id && !row.freshChat)).toEqual([]);
  expect(f.posts).toEqual(["/api/companies/company/projects"]);
  expect(sendHireHandoffMessage).toHaveBeenCalledTimes(1);
});

it("owns every audited native child before preserving the extra-task failure", async () => {
  const f = await fixture(undefined, true);
  await expect(f.run()).rejects.toMatchObject({ outcome: "failed", code: "completion_delegated_task_mismatch" });
  expect(f.owned.filter(row => row.kind === "issue" && row.id && !row.freshChat)).toEqual(f.children.map(child => ({
    kind: "issue", id: child.id, name: child.title, journeyId: "completion-delivery",
  })));
  expect(f.posts).toEqual(["/api/companies/company/projects"]);
  expect(sendHireHandoffMessage).toHaveBeenCalledTimes(1);
});
