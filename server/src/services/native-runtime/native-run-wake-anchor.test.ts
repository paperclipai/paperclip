import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";

import { readNativeRunWakeRequestedAtMs } from "./native-run-wake-anchor.js";

function fakeDb(result: () => Promise<unknown[]>): Db {
  const chain = {
    select: () => chain, from: () => chain, innerJoin: () => chain, where: () => chain,
    limit: () => result(),
  };
  return chain as unknown as Db;
}

describe("readNativeRunWakeRequestedAtMs", () => {
  it("returns the wake request acceptance time", async () => {
    const at = new Date("2026-11-07T10:00:00.000Z");
    await expect(readNativeRunWakeRequestedAtMs(fakeDb(async () => [{ requestedAt: at }]), "run")).resolves.toBe(at.getTime());
  });

  it("returns null when the run has no wake request", async () => {
    await expect(readNativeRunWakeRequestedAtMs(fakeDb(async () => []), "run")).resolves.toBeNull();
  });

  it("returns null when the read stays pending past the timeout", async () => {
    const pending = new Promise<unknown[]>(() => {});
    const startedAt = Date.now();
    await expect(readNativeRunWakeRequestedAtMs(fakeDb(() => pending), "run", 20)).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("never throws: a read failure only drops the diagnostic anchor", async () => {
    await expect(readNativeRunWakeRequestedAtMs(fakeDb(async () => { throw new Error("db down"); }), "run")).resolves.toBeNull();
  });
});
