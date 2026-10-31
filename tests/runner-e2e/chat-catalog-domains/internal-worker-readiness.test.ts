import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { fixtureWorker } from "./internal-definition.js";

afterEach(() => vi.useRealTimers());
const selected = "chat-features.runner-opencode.local.projects.project-defaults";
function fixture(state: (now: number) => Record<string, unknown>, executionId = selected, deadlineAt = 120_000) {
  const worker = { id: "worker", companyId: "company", name: "Morgan" };
  const get = vi.fn(async () => ({ ...worker, ...state(Date.now()) }));
  const evidence = vi.fn(async () => {});
  const ctx = { observationDeadlineAt: deadlineAt, input: {
    execution: { id: executionId, environment: { id: "local" }, profile: { buildAgent: () => ({}), credential: "OPENROUTER_API_KEY" } },
    fixtures: { company: { id: "company" }, agent: { id: "lead" }, environment: { id: "environment" }, secretRefs: {} },
    workspacePath: "/fixture", nonce: "fixture", api: { get, post: async () => worker }, evidence,
  } } as unknown as ChatCatalogContext;
  return { ctx, get, evidence, worker };
}
function outcome(ctx: ChatCatalogContext) {
  return fixtureWorker(ctx).then(value => ({ value, error: undefined, settledAt: Date.now() }),
    error => ({ value: undefined, error, settledAt: Date.now() }));
}

it("allows a valid readiness result after the unrelated 45-second cap within the original case clock", async () => {
  vi.useFakeTimers({ now: 0 });
  const f = fixture(now => ({ lifecycleState: now >= 50_000 ? "ready" : "verifying" }));
  const result = outcome(f.ctx);
  await vi.advanceTimersByTimeAsync(50_000);
  expect(await result).toEqual({ value: f.worker, error: undefined, settledAt: 50_000 });
});

it("waits for the lifecycle owner's automatic verification recovery", async () => {
  vi.useFakeTimers({ now: 0 });
  const f = fixture(now => now >= 50_000 ? { lifecycleState: "ready", lifecycleError: null }
    : { lifecycleState: "verifying", lifecycleError: "Execution test timed out; automatic recovery is pending.",
      lifecycleOperation: { id: "verification", attempts: 1, retryRequired: false, retryAt: new Date(20_000).toISOString() } });
  const result = outcome(f.ctx);
  await vi.advanceTimersByTimeAsync(50_000);
  expect(await result).toEqual({ value: f.worker, error: undefined, settledAt: 50_000 });
});

it.each(["verifying", "ready"])("rejects %s verification that requires configuration repair", async lifecycleState => {
  vi.useFakeTimers({ now: 0 });
  const f = fixture(() => ({ lifecycleState, lifecycleError: lifecycleState === "ready" ? null : "Authentication failed.", lifecycleOperation: { id: "verification", retryRequired: true } }));
  await expect(fixtureWorker(f.ctx)).rejects.toThrow(/setup|verification/i);
  expect(f.get).toHaveBeenCalledOnce();
});

it("cannot extend the original case clock while automatic recovery remains pending", async () => {
  vi.useFakeTimers({ now: 0 });
  const f = fixture(() => ({ lifecycleState: "verifying", lifecycleError: "Retry pending.", lifecycleOperation: { id: "verification", retryRequired: false } }), selected, 2_000);
  let settledAt: number | undefined;
  const result = outcome(f.ctx).then(value => { settledAt = value.settledAt; return value; });
  await vi.advanceTimersByTimeAsync(2_000);
  const atDeadline = settledAt;
  await vi.advanceTimersByTimeAsync(45_000);
  expect((await result).error).toBeInstanceOf(Error);
  expect(atDeadline).toBe(2_000);
});

it("retains the authored setup cap in lanes that have not opted into the original clock", async () => {
  vi.useFakeTimers({ now: 0 });
  const f = fixture(now => ({ lifecycleState: now >= 50_000 ? "ready" : "verifying" }), "chat-features.runner-codex-subscription.local.delegate-announcement");
  const result = outcome(f.ctx);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await result).toMatchObject({ error: expect.any(Error), settledAt: 46_000 });
});
