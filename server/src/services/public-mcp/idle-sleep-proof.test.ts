import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { readIdleMcpSleepProof } from "./idle-sleep-proof.js";

const context = { stackId: "stack", ownerId: "00000000-0000-4000-8000-000000000001",
  capabilityGeneration: "a".repeat(64), challenge: "c".repeat(64), now: 1234 };
function emptyReadOnlyTransaction() {
  const mutation = vi.fn(() => { throw new Error("read-only inspection mutated state"); });
  const select = vi.fn(() => {
    const chain: unknown = new Proxy({}, { get(_target, name) {
      if (name === "then") return Promise.resolve([]).then.bind(Promise.resolve([]));
      return () => chain;
    } });
    return chain;
  });
  return { tx: { select, insert: mutation, update: mutation, delete: mutation, execute: mutation } as unknown as Db, select, mutation };
}
describe("MCP owner read-only inspection", () => {
  it("inspects missing settings and absent owners without creating configuration or secrets", async () => {
    const fixture = emptyReadOnlyTransaction(), beforeRead = vi.fn(async () => {}), check = vi.fn();
    const proof = await readIdleMcpSleepProof(fixture.tx, {}, { ...context, budget: { beforeRead, check } });
    expect(proof.ingress.grantIds).toEqual([]);
    expect(proof.subscriptions).toMatchObject({ blocked: false, subscriptionIds: [] });
    expect(proof.retries).toMatchObject({ blocked: false, deliveryIds: [], deadlines: [] });
    expect(fixture.mutation).not.toHaveBeenCalled();
    expect(fixture.select).toHaveBeenCalledTimes(8);
    expect(beforeRead).toHaveBeenCalledTimes(fixture.select.mock.calls.length);
    expect(check).toHaveBeenCalled();
  });
  it("stops before issuing the read that exhausts the shared query budget", async () => {
    const fixture = emptyReadOnlyTransaction(); let remainingReads = 2;
    await expect(readIdleMcpSleepProof(fixture.tx, {}, { ...context, budget: {
      beforeRead: async () => { if (remainingReads-- <= 0) throw new Error("query budget exhausted"); }, check: () => {},
    } })).rejects.toThrow("query budget exhausted");
    expect(fixture.select).toHaveBeenCalledTimes(2);
    expect(fixture.mutation).not.toHaveBeenCalled();
  });
  it("checks elapsed time after a completed read before more owner work", async () => {
    const fixture = emptyReadOnlyTransaction();
    await expect(readIdleMcpSleepProof(fixture.tx, {}, { ...context, budget: {
      beforeRead: async () => {}, check: () => { throw new Error("inspection deadline exhausted"); },
    } })).rejects.toThrow("inspection deadline exhausted");
    expect(fixture.select).toHaveBeenCalledTimes(2);
    expect(fixture.mutation).not.toHaveBeenCalled();
  });
});
