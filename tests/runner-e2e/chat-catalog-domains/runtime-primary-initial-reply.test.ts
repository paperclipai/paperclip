import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";

const port = vi.hoisted(() => ({ now: 45_000, deadlines: [] as number[] }));
vi.mock("../codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: (value: unknown) => value }));
vi.mock("../api.js", () => ({ pollUntil: async (options: {
  deadlineAt: number; load(): Promise<unknown>; accept(value: unknown): boolean; reject?(value: unknown): string | undefined;
}) => {
  port.deadlines.push(options.deadlineAt);
  while (Date.now() < options.deadlineAt) {
    const value = await options.load();
    const rejected = options.reject?.(value);
    if (rejected) throw Error(rejected);
    if (options.accept(value)) return value;
    port.now += 10_000;
  }
  throw Error("Synthetic observer deadline reached");
} }));
import { runtimePrimaryCases } from "./runtime-primary.js";
afterEach(() => vi.restoreAllMocks());

type Options = { deadline?: number | "missing"; terminal?: "succeeded" | "running" | "failed" | "cancelled";
  readyAt?: number; lateLoad?: boolean; noWork?: boolean; extraRun?: boolean };
function fixture(options: Options = {}) {
  port.now = 45_000; port.deadlines.splice(0);
  vi.spyOn(Date, "now").mockImplementation(() => port.now);
  const deadline = options.deadline === undefined ? 300_000 : options.deadline;
  const readyAt = options.readyAt ?? 215_000;
  const get = vi.fn(async () => { throw Error("Reached human preference step"); });
  const ctx = {
    ...(deadline === "missing" ? {} : { observationDeadlineAt: deadline }),
    input: { api: { get }, fixtures: { company: { id: "company" }, agent: { id: "ceo" } } },
    issue: () => ({ id: "source", conversationState: port.now >= readyAt ? "waiting" : "active" }),
    refreshIssue: vi.fn(async () => {}),
    allRuns: vi.fn(async () => {
      if (options.lateLoad) port.now = 300_001;
      if (options.noWork) return [];
      return [{ id: "native", companyId: "company", agentId: "ceo",
        status: port.now >= readyAt ? options.terminal ?? "succeeded" : "running" },
        ...(options.extraRun ? [{ id: "unexpected", status: "succeeded" }] : [])];
    }),
  } as unknown as ChatCatalogContext;
  return { ctx, get };
}
it("owning act observes a delayed real completion only within the remaining original300s before the first human preference action", async () => {
  const f = fixture();
  await expect(runtimePrimaryCases[0]!.act!(f.ctx, {})).rejects.toThrow("Reached human preference step");
  expect(port.deadlines).toEqual([300_000]);
  expect(port.now).toBeGreaterThan(195_000); // old150s allowance from45s setup boundary
  expect(port.now).toBeLessThan(300_000);
  expect(f.get).toHaveBeenCalledExactlyOnceWith("/api/companies/company/primary-agent/me");
});
it.each([{ deadline: "missing" }, { deadline: NaN }, { deadline: Infinity }, { deadline: 44_999 }])("owning act refuses unavailable or expired originalclock before native reads %j", async options => {
  const f = fixture(options as Options);
  await expect(runtimePrimaryCases[0]!.act!(f.ctx, {})).rejects.toThrow();
  expect(f.ctx.allRuns).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
});
it.each([{ terminal: "running" }, { terminal: "failed" }, { terminal: "cancelled" }, { noWork: true }, { extraRun: true }, { lateLoad: true }, { readyAt: 300_001 }])("owning act rejects unfinished, invalid or late work before human state changes %j", async options => {
  const f = fixture(options as Options);
  await expect(runtimePrimaryCases[0]!.act!(f.ctx, {})).rejects.toThrow();
  expect(f.get).not.toHaveBeenCalled();
  expect(port.deadlines).toEqual([300_000]);
});
