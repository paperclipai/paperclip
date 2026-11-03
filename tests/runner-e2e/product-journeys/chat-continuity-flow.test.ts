import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";
import { chatContinuityFixture } from "./chat-continuity.test-fixture.js";

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
async function fixture(options: { preexisting?: boolean; intentFails?: boolean; sendFails?: boolean; foreignRun?: boolean } = {}) {
  const f = chatContinuityFixture(), directory = await mkdtemp(path.join(os.tmpdir(), "chat-continuity-flow-"));
  directories.push(directory);
  let stage = options.preexisting ? 0 : -1;
  const messages: string[] = [], actions: string[] = [];
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realTimeout(callback, delay === 1000 ? 0 : delay, ...args)) as typeof setTimeout);
  const current = () => f.points[stage]!;
  const get = vi.fn(async (route: string) => {
    if (route === "/api/instance/settings/experimental") return { enableAgentChat: true };
    if (route === "/api/companies/company/chats/agent") return stage < 0 ? null : structuredClone(current().chat);
    if (route === "/api/issues/chat/runs") return current().runs.map(run => ({ runId: run.id }));
    if (route === "/api/issues/chat/comments?order=asc") return structuredClone(current().comments);
    if (route === "/api/companies/company/issues?view=index&assigneeAgentId=agent&includeAgentCreatedTasks=true&limit=2") return [];
    if (route === "/api/companies/company/activity?agentId=agent&limit=500") return [];
    if (/\/api\/heartbeat-runs\/run-\d\/events\?/.test(route)) return [];
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
  return { ...f, context, evidence, own, directory, messages, actions, page, get,
    run: () => runChatContinuity(context, { own } as unknown as TargetSession, f.scope.campaignId, evidence,
      { directory, deadlineAt: Date.now() + 10_000 }) };
}
describe("chat continuity journey controls", () => {
  it("uses ordinary user messages once, owns the fresh chat before dispatch, and retains the independently graded result", async () => {
    const f = await fixture();
    await f.run();
    expect(f.messages).toEqual([f.scenario.remember, f.scenario.recall, "/new", f.scenario.fresh]);
    expect(f.actions.indexOf("intent")).toBeLessThan(f.actions.indexOf("send"));
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
