import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeServiceControllerOwnership } from "./controller-ownership.js";

describe("runtime service controller ownership", () => {
  const host = "a".repeat(64);
  const id = (pid: number) => `runtime-controller-v1:${host}:${pid}:${randomUUID()}`;

  it("recovers only an absent process in the same boot, namespace and user scope", async () => {
    const absent = vi.fn(() => true);
    const ownership = createRuntimeServiceControllerOwnership({ hostIdentity: async () => host, processAbsent: absent });
    expect(await ownership.isDead(id(420))).toBe(true);
    expect(absent).toHaveBeenCalledExactlyOnceWith(420);
    const foreign = createRuntimeServiceControllerOwnership({ hostIdentity: async () => "b".repeat(64), processAbsent: absent });
    expect(await foreign.isDead(id(420))).toBe(false);
    expect(absent).toHaveBeenCalledTimes(1);
    expect(await ownership.claimId()).toMatch(new RegExp(`^runtime-controller-v1:${host}:${process.pid}:`));
  });

  it.each(["legacy", "", `runtime-controller-v1:${host}:0:${randomUUID()}`, `runtime-controller-v1:${host}:-12:${randomUUID()}`,
    `runtime-controller-v1:${host}:2147483648:${randomUUID()}`, `runtime-controller-v1:${host}:12:invalid`,
    `runtime-controller-v1:${host}:12:${randomUUID()}:extra`])("does not probe malformed or legacy claim %s", async (claim) => {
    const absent = vi.fn(() => true);
    const ownership = createRuntimeServiceControllerOwnership({ hostIdentity: async () => host, processAbsent: absent });
    expect(await ownership.isDead(claim)).toBe(false);
    expect(absent).not.toHaveBeenCalled();
  });

  it("keeps live or recycled PIDs and uncertain probes under the existing lease", async () => {
    const live = createRuntimeServiceControllerOwnership({ hostIdentity: async () => host, processAbsent: () => false });
    const uncertain = createRuntimeServiceControllerOwnership({ hostIdentity: async () => host, processAbsent: () => { throw Error("probe unavailable"); } });
    expect(await live.isDead(id(420))).toBe(false);
    expect(await uncertain.isDead(id(420))).toBe(false);
  });

  it.each([null, "", "unknown"])("uses ordinary lease expiry when host scope is %s", async (identity) => {
    const absent = vi.fn(() => true);
    const ownership = createRuntimeServiceControllerOwnership({ hostIdentity: async () => identity, processAbsent: absent });
    expect(await ownership.prefix()).toBeNull();
    expect(await ownership.claimId()).toMatch(/^[a-f0-9-]{36}$/);
    expect(await ownership.isDead(id(420))).toBe(false);
    expect(absent).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")("distinguishes a live local process from its confirmed exit", async () => {
    const ownership = createRuntimeServiceControllerOwnership();
    const prefix = await ownership.prefix();
    expect(prefix).not.toBeNull();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const exit = once(child, "exit");
    try {
      await once(child, "spawn");
      const claim = `${prefix}${child.pid}:${randomUUID()}`;
      expect(await ownership.isDead(claim)).toBe(false);
      child.kill("SIGKILL");
      await exit;
      expect(await ownership.isDead(claim)).toBe(true);
      expect(await ownership.isDead(await ownership.claimId())).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    }
  });
});
