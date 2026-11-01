import { createServer, request } from "node:http";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMaintenanceArtifacts, maintenanceDatabaseSupport } from "./helpers/maintenance/environment.js";
import { startMaintenanceServer, withMaintenanceProvider } from "./helpers/maintenance/server-harness.js";

const embeddedSupport = vi.hoisted(() => vi.fn());
vi.mock("./helpers/embedded-postgres.js", () => ({ getEmbeddedPostgresTestSupport: embeddedSupport }));

let root: string | undefined;
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS", ""); });
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
async function ownedRoot() {
  return root = await mkdtemp(path.join(tmpdir(), "maintenance-environment-test-"));
}

describe("maintenance database support", () => {
  it("does not probe or skip an explicitly configured acceptance database", async () => {
    embeddedSupport.mockRejectedValue(new Error("Embedded PostgreSQL must not be launched"));
    expect(await maintenanceDatabaseSupport("postgresql://fixture/owned_test")).toEqual({ supported: true });
    expect(embeddedSupport).not.toHaveBeenCalled();
  });
  it("allows a supported default embedded environment", async () => {
    embeddedSupport.mockResolvedValue({ supported: true });
    expect(await maintenanceDatabaseSupport()).toEqual({ supported: true });
    expect(embeddedSupport).toHaveBeenCalledOnce();
  });
  it("returns the standard unsupported reason to the suite gate", async () => {
    embeddedSupport.mockResolvedValue({ supported: false, reason: "No usable initdb" });
    expect(await maintenanceDatabaseSupport()).toEqual({ supported: false, reason: "No usable initdb" });
    expect(embeddedSupport).toHaveBeenCalledOnce();
  });
});

describe("owned maintenance artifacts", () => {
  it("removes owned config and receipt files by default, including repeated disposal", async () => {
    const artifacts = await createMaintenanceArtifacts(await ownedRoot());
    await writeFile(path.join(artifacts.directory, "measurement.json"), "{}");
    expect(artifacts.retainedDirectory).toBeUndefined();
    await artifacts.dispose(); await artifacts.dispose();
    await expect(access(artifacts.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root!)).toEqual([]);
  });
  it("retains receipts only with explicit opt-in and exposes their path once", async () => {
    vi.stubEnv("PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS", "1");
    const print = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const artifacts = await createMaintenanceArtifacts(await ownedRoot());
    const receipt = path.join(artifacts.directory, "measurement.json");
    await writeFile(receipt, "{}");
    await artifacts.dispose(); await artifacts.dispose();
    await access(receipt);
    expect(artifacts.retainedDirectory).toBe(artifacts.directory);
    expect(print).toHaveBeenCalledExactlyOnceWith(`[maintenance-test] retained artifacts: ${artifacts.directory}\n`);
  });
  it("cleans the owned directory when setup fails before the child starts", async () => {
    const parent = await ownedRoot();
    await expect(startMaintenanceServer("not-a-database-url", { artifactRoot: parent })).rejects.toThrow("Invalid URL");
    expect(await readdir(parent)).toEqual([]);
  });
  it("prints retained diagnostics when failed startup was explicitly opted in", async () => {
    vi.stubEnv("PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS", "1");
    const print = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const parent = await ownedRoot();
    await expect(startMaintenanceServer("not-a-database-url", { artifactRoot: parent })).rejects.toThrow("Invalid URL");
    const [name] = await readdir(parent);
    expect(name).toMatch(/^paperclip-maintenance-/);
    expect(print).toHaveBeenCalledExactlyOnceWith(`[maintenance-test] retained artifacts: ${path.join(parent, name!)}\n`);
  });
});


describe("owned maintenance providers", () => {
  it("closes all six real listeners when actual server setup rejects", async () => {
    const parent = await ownedRoot();
    const providers = Array.from({ length: 6 }, () => createServer((_req, res) => res.end()));
    let bound = 0;
    try {
      const results = await Promise.allSettled(providers.map(provider => withMaintenanceProvider(provider, async () => {
        expect(provider.listening).toBe(true); bound++;
        return startMaintenanceServer("not-a-database-url", { artifactRoot: parent });
      })));
      expect(bound).toBe(6);
      for (const result of results) expect(result).toMatchObject({ status: "rejected", reason: { message: "Invalid URL" } });
      expect(providers.map(provider => provider.listening)).toEqual(Array(6).fill(false));
      expect(providers.map(provider => provider.address())).toEqual(Array(6).fill(null));
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await Promise.all(providers.map(async provider => {
        provider.closeAllConnections();
        if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve()));
      }));
    }
  });

  it("closes an active provider connection and preserves an inner cleanup rejection", async () => {
    let arrived!: () => void, activeClosed = false;
    const active = new Promise<void>(resolve => { arrived = resolve; });
    const provider = createServer((_req, res) => { res.once("close", () => { activeClosed = true; }); arrived(); });
    const failure = new Error("Controlled runtime cleanup failure");
    let client: ReturnType<typeof request> | undefined, closed: Promise<void> | undefined;
    try {
      await expect(withMaintenanceProvider(provider, async origin => {
        try {
          closed = new Promise<void>(resolve => {
            client = request(origin, { agent: false });
            client.once("error", () => {}); client.once("close", () => resolve()); client.end();
          });
          await active;
        } finally { throw failure; }
      })).rejects.toBe(failure);
      await closed;
      expect(activeClosed).toBe(true);
      expect(provider.listening).toBe(false);
      expect(provider.address()).toBeNull();
    } finally {
      client?.destroy();
      const closing = provider.listening ? new Promise<void>(resolve => provider.close(() => resolve())) : Promise.resolve();
      provider.closeAllConnections(); await closing;
    }
  });
});
