import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { refreshCompanySubscriptions, refreshSubscriptionConnection } from "../services/subscription-refresh.js";
import type { SubscriptionConnection } from "../services/subscriptions.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const mocks = vi.hoisted(() => ({ accounts: vi.fn(), credential: vi.fn(), register: vi.fn(), probe: vi.fn() }));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ subscriptionAccounts: mocks.accounts, credential: mocks.credential }) }));
vi.mock("../services/subscriptions.js", () => ({ subscriptionService: () => ({ register: mocks.register }), subscriptionSession: async () => null }));
vi.mock("../services/subscription-identity.js", () => ({ probeSubscriptionIdentity: mocks.probe }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function database() {
  return {
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "claimed" }] }) }) }),
    select: () => ({ from: () => ({ where: async () => [{ credentialKey: "fixture-key" }] }) }),
  } as unknown as Db;
}
const input = (id: string): SubscriptionConnection => ({ companyId: id, connectionId: id, grantId: id, provider: "openai", name: id, ownerUserId: "alice", credential: "fixture" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.credential.mockResolvedValue("fixture");
  mocks.register.mockImplementation(async (connection: SubscriptionConnection) => connection.grantId);
});

describe("subscription discovery capacity", () => {
  it("tracks detached provider refresh through its final database write", async () => {
    const db = database(), probe = deferred<{ credentialKey: string }>(), save = deferred<string>();
    const before = idleWorkSnapshot();
    mocks.probe.mockReturnValue(probe.promise);
    mocks.register.mockReturnValue(save.promise);
    const task = refreshSubscriptionConnection(db, input("tracked"), "tracked");
    try {
      await vi.waitFor(() => expect(mocks.probe).toHaveBeenCalledOnce());
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
      expect(refreshSubscriptionConnection(db, input("tracked"), "tracked")).toBe(task);
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
      probe.resolve({ credentialKey: "fixture-key" });
      await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledOnce());
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
    } finally {
      probe.resolve({ credentialKey: "fixture-key" }); save.resolve("tracked"); await task;
    }
    expect(idleWorkSnapshot().active).toBe(before.active);
    expect(idleWorkSnapshot().generation).toBe(before.generation + 2);
  });

  it("tracks detached discovery while it waits for account credentials", async () => {
    const db = database(), accounts = deferred<[]>();
    const before = idleWorkSnapshot();
    mocks.accounts.mockReturnValue(accounts.promise);
    const task = refreshCompanySubscriptions(db, "tracked-company", "alice");
    try {
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
      expect(refreshCompanySubscriptions(db, "tracked-company", "alice")).toBe(task);
      expect(idleWorkSnapshot().active).toBe(before.active + 1);
    } finally { accounts.resolve([]); await task; }
    expect(idleWorkSnapshot().active).toBe(before.active);
  });

  it.each([false, true])("waits for a provider slot without dropping accepted discovery (provider fails: %s)", async (fails) => {
    const db = database();
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    let started = 0, active = 0, peak = 0;
    mocks.probe.mockImplementation(async () => {
      const index = started++;
      peak = Math.max(peak, ++active);
      await gates[index].promise;
      active--;
      if (index === 0 && fails) throw new Error("fixture provider failure");
      return { credentialKey: "fixture-key" };
    });
    mocks.accounts.mockResolvedValue([{ summary: { status: "connected", provider: "openai" },
      connection: { id: "fifth", name: "Fifth account" }, grant: { id: "fifth", subjectUserId: "alice" } }]);
    const running = Array.from({ length: 4 }, (_, i) => refreshSubscriptionConnection(db, input(`busy-${i}`), `busy-${i}`));
    let discovery: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(started).toBe(4));
      let completed = false;
      discovery = refreshCompanySubscriptions(db, "fifth", "alice").then(() => { completed = true; });
      await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ grantId: "fifth" })));
      expect(started).toBe(4);
      expect(completed).toBe(false);
      gates[0].resolve();
      await vi.waitFor(() => expect(started).toBe(5));
      expect(peak).toBe(4);
      gates[4].resolve();
      await discovery;
      expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ grantId: "fifth" }), { credentialKey: "fixture-key" });
    } finally {
      gates.forEach(gate => gate.resolve());
      await Promise.all([...running, discovery]);
    }
  });

  it("rejects excess discovery with a retryable error, deduplicates accepted work, and releases capacity", async () => {
    const db = database(), gate = deferred<[]>();
    mocks.accounts.mockReturnValue(gate.promise);
    const accepted = Array.from({ length: 20 }, (_, i) => refreshCompanySubscriptions(db, "company", `user-${i}`));
    try {
      expect(refreshCompanySubscriptions(db, "company", "user-0")).toBe(accepted[0]);
      expect(mocks.accounts).toHaveBeenCalledTimes(20);
      expect(() => refreshCompanySubscriptions(db, "company", "overflow")).toThrow(expect.objectContaining({ status: 429 }));
    } finally {
      gate.resolve([]);
      await Promise.all(accepted);
    }
    await refreshCompanySubscriptions(db, "company", "overflow");
    expect(mocks.accounts).toHaveBeenCalledTimes(21);
  });
});
