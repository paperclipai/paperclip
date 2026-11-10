import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { readPluginLoginCredential } from "./plugin-login-credential.js";
const getById = vi.hoisted(() => vi.fn());
vi.mock("./plugin-registry.js", () => ({ pluginRegistryService: () => ({ getById }) }));
const environment = { id: "environment", driver: "plugin" } as Environment;
const lease = { environmentId: "environment", companyId: "company", providerLeaseId: "login", metadata: { purpose: "login", loginCommandKey: "codex", pluginId: "plugin", driverKey: "computer" } } as unknown as EnvironmentLease;
const call = vi.fn();
const methods = ["loginPtyReadCredential"];
const workerManager = { call, getWorker: () => ({ supportedMethods: methods }) } as unknown as PluginWorkerManager;
beforeEach(() => { call.mockReset(); call.mockResolvedValue({ kind: "codex-auth-json", authJson: '{"fixture":true}' }); methods.splice(0, methods.length, "loginPtyReadCredential"); getById.mockResolvedValue({ id: "plugin", status: "ready", manifestJson: { environmentDrivers: [{ driverKey: "computer", supportsLoginPty: true }] } }); });
describe("plugin login fixed credential result", () => {
  it("reads the exact bound lease through the optional RPC", async () => {
    const bytes = await readPluginLoginCredential({ db: {} as Db, workerManager, environment, lease });
    expect(bytes.toString()).toBe('{"fixture":true}');
    expect(call).toHaveBeenCalledWith("plugin", "loginPtyReadCredential", { driverKey: "computer", companyId: "company", environmentId: "environment", providerLeaseId: "login", loginCommandKey: "codex" });
  });
  it("fails before calling a worker that lacks the optional read", async () => { methods.length = 0; await expect(readPluginLoginCredential({ db: {} as Db, workerManager, environment, lease })).rejects.toThrow("Login credential result unavailable"); expect(call).not.toHaveBeenCalled(); });
  it.each([{ kind: "other", authJson: "private-provider-output" }, { kind: "codex-auth-json", authJson: "x".repeat(65537) }, { kind: "codex-auth-json", authJson: "" }])("rejects malformed or oversized private results", async result => { call.mockResolvedValue(result); await expect(readPluginLoginCredential({ db: {} as Db, workerManager, environment, lease })).rejects.toThrow(/^Login credential result unavailable$/); });
  it("rejects a mismatched allocation scope before exporting", async () => { await expect(readPluginLoginCredential({ db: {} as Db, workerManager, environment: { ...environment, id: "other" }, lease })).rejects.toThrow(); expect(call).not.toHaveBeenCalled(); });
});
