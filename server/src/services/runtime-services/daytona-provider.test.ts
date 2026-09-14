import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createDaytonaRuntimeServiceProvider } from "./daytona-provider.js";
import type { RuntimeServiceProviderContext } from "./provider.js";
import { RuntimeServiceFault } from "./fault.js";

describe("Daytona service host bridge", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
  function context(): RuntimeServiceProviderContext {
    return { companyId: randomUUID(), serviceId: randomUUID(), allocationId: randomUUID(), environmentLeaseId: randomUUID(), allocationMetadata: {},
      spec: { cwd: "/workspace", command: "node server.cjs", env: {}, endpoints: [] }, env: {}, secrets: [], process: { generation: randomUUID() } };
  }
  it("preserves machine-readable identity loss through a JSON-RPC result", async () => {
    const provider = createDaytonaRuntimeServiceProvider({ operate: async () => ({ state: "missing", errorCode: "IDENTITY_LOST" }) });
    await expect(provider.inspect(context())).rejects.toBeInstanceOf(RuntimeServiceFault);
    await expect(provider.inspect(context())).rejects.toMatchObject({ code: "supervisor_lost" });
  });
  it("preserves a resource allocation failure as a bounded policy error", async () => {
    const provider = createDaytonaRuntimeServiceProvider({ operate: async () => ({ state: "running", errorCode: "RESOURCE_CONFIGURATION_MISMATCH" }) });
    await expect(provider.start(context())).rejects.toMatchObject({ code: "resource_configuration_mismatch" });
    await expect(provider.inspect(context())).rejects.toMatchObject({ code: "resource_configuration_mismatch" });
  });
  it("recovers receipt metadata and rejects a mismatched generation", async () => {
    const ctx = context();
    let generation = ctx.process.generation;
    const provider = createDaytonaRuntimeServiceProvider({ operate: async () => ({ state: "running", processRef: { generation, started: true, ports: { web: 5173 } } }) });
    expect(await provider.inspect(ctx)).toMatchObject({ processRef: { started: true, generation, ports: { web: 5173 } } });
    generation = randomUUID();
    await expect(provider.inspect(ctx)).rejects.toMatchObject({ code: "supervisor_lost" });
  });
  it("keeps saved logs readable after the sandbox sleeps, including concurrent log readers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-daytona-logs-")); roots.push(root);
    let asleep = false;
    const provider = createDaytonaRuntimeServiceProvider({ logRoot: root, operate: async () => {
      if (asleep) throw new Error("sandbox stopped");
      return { state: "running", logs: "redacted service output" };
    } });
    const ctx = context();
    expect(await Promise.all(Array.from({ length: 5 }, () => provider.logs(ctx, 4096)))).toEqual(Array(5).fill("redacted service output"));
    asleep = true;
    expect(await provider.logs(ctx, 4096)).toContain("redacted service output");
    expect(await provider.logs(ctx, 4096)).toContain("live logs are unavailable");
  });
});
