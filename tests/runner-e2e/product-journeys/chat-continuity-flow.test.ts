import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";
import { chatContinuityFixture, compactChatContinuityFixture } from "./chat-continuity.test-fixture.js";

const mocks = vi.hoisted(() => ({ send: vi.fn(), reply: vi.fn(), capture: vi.fn() }));
vi.mock("../chat-flow.js", () => ({ sendChatMessage: mocks.send }));
vi.mock("../native-task-reply.js", async importOriginal => ({
  ...await importOriginal<typeof import("../native-task-reply.js")>(), readBoundTaskFinalReply: mocks.reply,
}));
vi.mock("./product-screenshot.js", () => ({ captureProductScreenshot: mocks.capture }));
vi.mock("@playwright/test", () => ({ expect: (locator: { isVisible(): Promise<boolean> }) => ({
  async toBeVisible() { expect(await locator.isVisible()).toBe(true); },
}) }));
import { runChatContinuity } from "./chat-continuity-flow.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture(options: { preexisting?: boolean; intentFails?: boolean; sendFails?: boolean; foreignRun?: boolean;
  compactRuns?: boolean; unrelatedActivity?: number; ignoreActivityScope?: boolean; priorAgentStatus?: string; mixedAgentHistory?: boolean;
  provisioningActor?: "board" | "owned-agent" } = {}) {
  const f = options.compactRuns ? compactChatContinuityFixture() : chatContinuityFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "chat-continuity-flow-"));
  directories.push(directory);
  let stage = options.preexisting ? 0 : -1;
  const messages: string[] = [], actions: string[] = [];
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realTimeout(callback, delay === 1000 ? 0 : delay, ...args)) as typeof setTimeout);
  const current = () => f.points[stage]!;
  const companyActivity = [
    ...Array.from({ length: options.unrelatedActivity ?? 0 }, (_, index) => ({ id: `unrelated-${index}`,
      companyId: f.scope.companyId, agentId: "other-agent", runId: "other-run", action: "project.created", entityType: "project", entityId: `other-project-${index}` })),
    ...(options.provisioningActor ? [{ id: "provisioned-agent", companyId: f.scope.companyId,
      agentId: options.provisioningActor === "board" ? null : f.scope.agentId, runId: null,
      action: "agent.created", entityType: "agent", entityId: f.scope.agentId }] : []),
  ];
  const companyRuns = Array.from({ length: options.unrelatedActivity ?? 0 }, (_, index) => ({ id: `unrelated-run-${index}`,
    companyId: f.scope.companyId, agentId: "other-agent", status: "succeeded" }));
  if (options.priorAgentStatus) companyRuns.push({ id: "prior-owned-run", companyId: f.scope.companyId, agentId: f.scope.agentId, status: options.priorAgentStatus });
  const get = vi.fn(async (route: string) => {
    if (route === "/api/instance/settings/experimental") return { enableAgentChat: true };
    if (route === "/api/companies/company/heartbeat-runs?agentId=agent&limit=1&summary=true") {
      actions.push("history");
      if (options.mixedAgentHistory) return [{ id: "foreign-run", companyId: "foreign-company", agentId: "other-agent", status: "running" }];
      return companyRuns.filter(run => run.agentId === f.scope.agentId).slice(0, 1);
    }
    if (route === "/api/companies/company/chats/agent") return stage < 0 ? null : structuredClone(current().chat);
    if (route === "/api/issues/chat/runs") return current().runs.map(run => ({ runId: run.id, agentId: run.agentId, status: run.status,
      contextIssueId: run.contextSnapshot.issueId, wakeCommentId: run.contextSnapshot.wakeCommentId,
      resultJson: run.contextSnapshot.conversationReset ? { conversationReset: true } : {} }));
    if (route === "/api/issues/chat/comments?order=asc") return structuredClone(current().comments);
    if (route === "/api/companies/company/issues?view=index&assigneeAgentId=agent&includeAgentCreatedTasks=true&limit=2") return [];
    if (route === "/api/companies/company/activity?agentId=agent&limit=500") {
      return (options.ignoreActivityScope ? companyActivity : companyActivity.filter(row => row.agentId === f.scope.agentId)).slice(0, 500);
    }
    if (/\/api\/heartbeat-runs\/run-\d\/events\?/.test(route)) return structuredClone(current().events ?? []);
    const id = route.match(/^\/api\/heartbeat-runs\/(run-\d)$/)?.[1];
    if (id) {
      const run = structuredClone(current().runs.find(row => row.id === id)!);
      if (options.foreignRun) run.nativeIssueId = "foreign";
      return run;
    }
    throw new Error(`unexpected GET ${route}`);
  });
  const page = { goto: vi.fn(async (_url: string) => { actions.push("navigate"); }), reload: vi.fn(async () => { actions.push("reload"); }),
    getByTestId: vi.fn(() => ({ isVisible: async () => true })) };
  const own = vi.fn(async (resource: { id?: string }) => {
    actions.push(resource.id ? "receipt" : "intent");
    if (options.intentFails && !resource.id) throw new Error("ownership intent failed");
  });
  const context = { page, api: { get, origin: "https://qa.example.test" },
    company: { id: f.scope.companyId, issuePrefix: "QA" }, user: { id: f.scope.userId, name: "QA" },
    environmentId: f.scope.environmentId, agent: { id: f.scope.agentId, name: f.scope.agentName,
      provider: f.scope.provider, model: f.scope.model, runtimeMode: "native" } } as unknown as JourneyContext;
  const evidence: JourneyEvidence = { outcome: "passed", startingState: "recipe", phases: [], checks: [], resourceDisposition: "released", privacy: "private" };
  mocks.send.mockImplementation(async (_page, message: string) => {
    actions.push("send"); messages.push(message);
    if (options.sendFails) throw new Error("uncertain send response");
    const index = [f.scenario.remember, f.scenario.recall, f.scenario.reset, f.scenario.fresh].indexOf(message);
    expect(index).toBe(messages.length - 1);
    stage = [0, 2, 3, 4][index]!;
  });
  mocks.reply.mockImplementation(async input => {
    await input.page.reload();
    const data = await input.load();
    expect(data.run.id).toBe(input.runId);
    const point = f.points.find(point => point.reply?.runId === input.runId)!;
    return structuredClone(point.reply!);
  });
  mocks.capture.mockResolvedValue(undefined);
  return { ...f, context, evidence, own, directory, messages, actions, page, get, companyActivity,
    run: () => runChatContinuity(context, { own } as unknown as TargetSession, f.scope.campaignId, evidence,
      { directory, deadlineAt: Date.now() + 10_000 }) };
}
describe("chat continuity journey controls", () => {
  it("uses ordinary user messages once, owns the fresh chat before dispatch, and retains the independently graded result", async () => {
    const f = await fixture();
    await f.run();
    expect(f.messages).toEqual([f.scenario.remember, f.scenario.recall, "/new", f.scenario.fresh]);
    expect(f.actions.indexOf("intent")).toBeLessThan(f.actions.indexOf("send"));
    expect(f.actions.indexOf("history")).toBeLessThan(f.actions.indexOf("intent"));
    expect(f.own).toHaveBeenCalledTimes(2);
    expect(f.own.mock.calls[0]![0]).toMatchObject({ journeyId: "chat-continuity", freshChat: { absent: true, userId: f.scope.userId } });
    expect(f.own.mock.calls[1]![0]).toMatchObject({ id: "chat", journeyId: "chat-continuity" });
    expect(f.evidence.checks).toHaveLength(9);
    expect(f.evidence.checks.every(check => check.passed)).toBe(true);
    expect(mocks.reply).toHaveBeenCalledTimes(5);
    expect(mocks.capture).toHaveBeenCalledTimes(6);
    expect(f.page.goto.mock.calls.flat().every(url => typeof url !== "string" || url.startsWith("https://qa.example.test/"))).toBe(true);
    const saved = JSON.parse(await readFile(path.join(f.directory, "chat-continuity.json"), "utf8"));
    expect(saved.points.map((point: { phase: string }) => point.phase)).toEqual(["initial", "returned", "recalled", "reset", "fresh", "reopened"]);
    expect(saved.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
  });
  it("accepts compact details with original reset summaries despite more than 500 unrelated company events", async () => {
    const f = await fixture({ compactRuns: true, unrelatedActivity: 750 });
    await f.run();
    expect(f.evidence.checks.every(check => check.passed)).toBe(true);
    const saved = JSON.parse(await readFile(path.join(f.directory, "chat-continuity.json"), "utf8"));
    expect(saved.points.every((point: { activity: unknown[] }) => point.activity.length === 0)).toBe(true);
    expect(saved.points[5].resetReceipts[0]).toMatchObject({ source: "issue-runs", runId: "run-2", agentId: f.scope.agentId,
      contextIssueId: "chat", wakeCommentId: "user-2", resultJson: { conversationReset: true } });
    expect(saved.points[5].runs[2].resultJson).toBeNull();
  });
  it.each([1, 750])("rejects an ignored agent filter instead of filtering %s unrelated global activity rows", async unrelatedActivity => {
    const f = await fixture({ unrelatedActivity, ignoreActivityScope: true });
    await expect(f.run()).rejects.toThrow("chat_continuity_observation_incomplete");
    expect(f.messages).toEqual([f.scenario.remember]);
  });
  it("accepts board provisioning whose created entity is the owned agent, rather than treating its entity id as the actor", async () => {
    const f = await fixture({ provisioningActor: "board", unrelatedActivity: 750 });
    expect(f.companyActivity.at(-1)).toMatchObject({ action: "agent.created", agentId: null, entityId: f.scope.agentId });
    await f.run();
    expect(f.evidence.checks.every(check => check.passed)).toBe(true);
    const saved = JSON.parse(await readFile(path.join(f.directory, "chat-continuity.json"), "utf8"));
    expect(saved.points.every((point: { activity: unknown[] }) => point.activity.length === 0)).toBe(true);
  });
  it("rejects creation attributed to the fresh owned agent even if that activity predates the first send", async () => {
    const f = await fixture({ provisioningActor: "owned-agent" });
    await expect(f.run()).rejects.toThrow("chat_continuity_evidence_failed");
    expect(f.evidence.checks.find(check => check.id === "chat-no-unrequested-work")?.passed).toBe(false);
  });
  it.each(["succeeded", "running", "queued", "failed"])("rejects prior %s work on a reused agent before any send", async priorAgentStatus => {
    const f = await fixture({ priorAgentStatus, unrelatedActivity: 750 });
    await expect(f.run()).rejects.toThrow("fresh_chat_agent_required");
    expect(f.messages).toEqual([]);
    expect(f.own).not.toHaveBeenCalled();
  });
  it("rejects mixed or foreign agent history before any send", async () => {
    const f = await fixture({ mixedAgentHistory: true });
    await expect(f.run()).rejects.toThrow("chat_continuity_agent_history_scope_mismatch");
    expect(f.messages).toEqual([]);
    expect(f.own).not.toHaveBeenCalled();
  });
  it.each(["preexisting", "intentFails"] as const)("does not dispatch model work when %s rejects ownership", async option => {
    const f = await fixture({ [option]: true });
    await expect(f.run()).rejects.toThrow();
    expect(f.messages).toEqual([]);
    expect(f.evidence.checks.every(check => !check.passed)).toBe(true);
  });
  it("never replays an uncertain send", async () => {
    const f = await fixture({ sendFails: true });
    await expect(f.run()).rejects.toThrow("uncertain send response");
    expect(f.messages).toEqual([f.scenario.remember]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(f.evidence.checks.some(check => !check.passed)).toBe(true);
  });
  it("rejects a foreign native run before sending another message", async () => {
    const f = await fixture({ foreignRun: true });
    await expect(f.run()).rejects.toThrow("chat_continuity_run_mismatch");
    expect(f.messages).toEqual([f.scenario.remember]);
    expect(f.evidence.checks.some(check => !check.passed)).toBe(true);
  });
});
