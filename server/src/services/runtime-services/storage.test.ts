import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, runtimeServiceAllocations, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema } from "@paperclipai/shared";
import { createRuntimeServiceManager } from "./manager.js";
import { createLocalRuntimeServiceProvider } from "./local-provider.js";
import { createLocalServiceSandboxLauncher } from "./local-sandbox.js";
import type { RuntimeServiceProvider } from "./provider.js";

const sandboxSupported = process.platform === "darwin" || await promisify(execFile)(process.env.PAPERCLIP_SERVICE_SANDBOX_COMMAND ?? "codex", ["sandbox", "--help"], { timeout: 10_000 })
  .then(({ stdout }) => stdout.includes("--permission-profile")).catch(() => false);

describe("retained allocation storage measurements", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-service-storage-"); db = createDb(database.connectionString); root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-storage-")); }, 30_000);
  afterAll(async () => { await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });
  async function fixture(mode: "stub" | "host" | "sandbox" = "stub") {
    const companyId = randomUUID(), cwd = path.join(root, companyId), actor = { type: "board" as const, id: "storage-operator" };
    await fs.mkdir(cwd); await db.insert(companies).values({ id: companyId, name: "Storage", issuePrefix: `S${companyId.slice(0, 6)}` });
    let clock = new Date();
    const measure = vi.fn<NonNullable<RuntimeServiceProvider["storageUsage"]>>(async () => ({ bytes: 4096 }));
    const provider: RuntimeServiceProvider = mode !== "stub" ? createLocalRuntimeServiceProvider({ root: path.join(root, "supervisors"),
      ...(mode === "sandbox" ? { prepareLaunch: createLocalServiceSandboxLauncher({ root: path.join(root, "sandbox") }) } : {}),
    }) : {
      key: "local", capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
      async start(ctx) { return ctx.process; }, async inspect() { return { state: "running", endpoints: [] }; }, async stop() {}, async logs() { return ""; }, storageUsage: measure,
    };
    const make = () => createRuntimeServiceManager(db, { providers: [provider], clock: () => clock });
    const manager = make();
    const create = async () => manager.create(companyId, actor, createRuntimeServiceSchema.parse({ name: "Storage app", command: "node app.cjs", requestId: randomUUID(), start: false }),
      { provider: "local", cwd, reuseKey: cwd, metadata: { localBoundary: { kind: "workspace", workspaceRoot: cwd, network: "disabled" } } });
    const service = await create();
    const refresh = () => manager.refreshStorage(companyId, service.id);
    return { companyId, cwd, actor, manager, service, create, refresh, make, measure, advance: (milliseconds = 3000) => { clock = new Date(clock.getTime() + milliseconds); } };
  }
  it("periodically measures stale allocations and skips recent or released storage", async () => {
    const f = await fixture();
    await f.manager.storageTick();
    expect((await f.manager.storage(f.companyId, f.service.id)).usage).toMatchObject({ status: "ready", bytes: 4096 });
    expect(f.measure).toHaveBeenCalledTimes(1);
    await f.manager.storageTick(); expect(f.measure).toHaveBeenCalledTimes(1);
    f.advance(301_000); await f.manager.storageTick(); expect(f.measure).toHaveBeenCalledTimes(2);
    await db.update(runtimeServiceAllocations).set({ metadata: { retentionReleased: true } }).where(eq(runtimeServiceAllocations.id, f.service.allocationId));
    f.advance(301_000); await f.manager.storageTick(); expect(f.measure).toHaveBeenCalledTimes(2);
  });
  it("stores one measurement for shared services and preserves it across manager replacement", async () => {
    const f = await fixture(), other = await f.create();
    expect(other.allocationId).toBe(f.service.allocationId);
    expect(await f.refresh()).toMatchObject({ serviceCount: 2, usage: { status: "ready", bytes: 4096 } });
    expect((await f.make().get(f.companyId, other.id)).storageUsage).toMatchObject({ status: "ready", bytes: 4096 });
    expect(f.measure.mock.calls[0]![0]).toMatchObject({ spec: { cwd: f.cwd, command: "", env: {}, endpoints: [] }, env: {}, secrets: [] });
    await expect(f.manager.refreshStorage(randomUUID(), f.service.id)).rejects.toThrow("not found");
    expect(f.measure).toHaveBeenCalledTimes(1);
  });
  it("preserves the last known size for stopped compute, invalid results and failed scans", async () => {
    const f = await fixture(), first = await f.refresh(); f.advance();
    f.measure.mockResolvedValueOnce({ unavailable: "compute_stopped" });
    expect((await f.refresh()).usage).toMatchObject({ status: "unavailable", reason: "compute_stopped", bytes: 4096, measuredAt: first.usage.measuredAt });
    f.advance(); f.measure.mockResolvedValueOnce({ bytes: -1 });
    expect((await f.refresh()).usage).toMatchObject({ status: "unavailable", reason: "measurement_failed", bytes: 4096 });
    f.advance(); f.measure.mockRejectedValueOnce(new Error("private file path and credential"));
    expect(JSON.stringify(await f.refresh())).not.toContain("private file");
  });
  it("coalesces scans without blocking Stop or restoring stale lifecycle state", async () => {
    const f = await fixture();
    await f.manager.control(f.companyId, f.service.id, f.actor, { requestId: randomUUID(), expectedRevision: f.service.revision, action: "start" });
    await f.manager.reconcile(f.companyId, f.service.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.measure.mockImplementationOnce(async () => { await gate; return { bytes: 8192 }; });
    const pending = f.refresh();
    try {
      await vi.waitFor(() => expect(f.measure).toHaveBeenCalledTimes(1));
      expect((await f.refresh()).usage.status).toBe("unmeasured");
      const current = await f.manager.get(f.companyId, f.service.id);
      const stop = f.manager.control(f.companyId, current.id, f.actor, { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" });
      expect(await Promise.race([stop, delay(1000).then(() => null)])).toMatchObject({ desiredState: "stopped" });
    } finally { release(); await pending; }
    await f.manager.reconcile(f.companyId, f.service.id);
    expect(await f.manager.get(f.companyId, f.service.id)).toMatchObject({ state: "stopped", desiredState: "stopped", storageUsage: { bytes: 8192 } });
    expect(f.measure).toHaveBeenCalledTimes(1);
  });
  it("does not provision a saved workspace just to measure it", async () => {
    const f = await fixture();
    await db.update(runtimeServiceAllocations).set({ metadata: { allocationRequest: { pending: true } } }).where(eq(runtimeServiceAllocations.id, f.service.allocationId));
    expect((await f.refresh()).usage).toMatchObject({ status: "unavailable", bytes: null, reason: "not_provisioned" });
    expect(f.measure).not.toHaveBeenCalled();
  });
  for (const mode of ["host", "sandbox"] as const) it.skipIf(mode === "sandbox" && !sandboxSupported)(`measures actual files with the ${mode} scanner without following an outside symlink`, async () => {
    const f = await fixture(mode);
    const outside = path.join(root, "outside.bin"); await fs.writeFile(outside, Buffer.alloc(4 * 1024 * 1024, 1));
    await fs.symlink(outside, path.join(f.cwd, "outside-link"));
    const first = await f.refresh(); expect(first.usage.status).toBe("ready"); expect(first.usage.bytes!).toBeLessThan(1024 * 1024);
    await fs.mkdir(path.join(f.cwd, "node_modules"));
    await fs.writeFile(path.join(f.cwd, "node_modules/dependency.bin"), Buffer.alloc(2 * 1024 * 1024, 1));
    await fs.mkdir(path.join(f.cwd, ".git")); await fs.writeFile(path.join(f.cwd, ".git/dirty-note"), "retained source");
    f.advance(); const larger = await f.refresh();
    expect(larger.usage.status).toBe("ready"); expect(larger.usage.bytes! - first.usage.bytes!).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    await fs.link(path.join(f.cwd, "node_modules/dependency.bin"), path.join(f.cwd, "same-inode.bin")); f.advance();
    expect((await f.refresh()).usage.bytes! - larger.usage.bytes!).toBeLessThan(1024 * 1024);
    expect((await f.manager.get(f.companyId, f.service.id)).state).toBe("stopped");
  });
});
