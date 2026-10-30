import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../adapters/registry.js", () => ({ listServerAdapters: () => [{ type: "codex_local" }, { type: "claude_local" }] }));
import { adapterSettingsService, type AdapterSettingsDb } from "./adapter-settings.js";
import { getDisabledAdapterTypes, setAdapterDisabled } from "./adapter-plugin-store.js";
import { parseAdapterRegistryEnv } from "./adapter-registry-config.js";

describe("local adapter settings compatibility", () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-settings-local-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    vi.stubEnv("PAPERCLIP_ADAPTERS", undefined);
    vi.stubEnv("PAPERCLIP_ADAPTERS_FILE", undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reads and writes the existing file without a database", async () => {
    fs.writeFileSync(path.join(directory, "adapter-settings.json"), JSON.stringify({ disabledTypes: ["claude_local"] }));
    const service = adapterSettingsService(undefined);
    expect(await service.getDisabledTypes()).toEqual(["claude_local"]);
    expect(await service.setDisabled("codex_local", true)).toBe(true);
    expect(getDisabledAdapterTypes()).toEqual(["claude_local", "codex_local"]);
    expect(setAdapterDisabled("claude_local", false)).toBe(true);
    expect(await service.getDisabledTypes()).toEqual(["codex_local"]);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "adapter-settings.json"), "utf8"))).toEqual({ disabledTypes: ["codex_local"] });
  });

  it("loads an operator file once and leaves the saved file intact", async () => {
    setAdapterDisabled("codex_local", true);
    const file = path.join(directory, "operator-adapters.json");
    fs.writeFileSync(file, JSON.stringify([{ adapterType: "codex_local", enabled: true }]));
    const env = { PAPERCLIP_ADAPTERS_FILE: file };
    parseAdapterRegistryEnv(env);
    const read = vi.spyOn(fs, "readFileSync");
    const service = adapterSettingsService(undefined, { runtimeEnv: env });
    expect(await service.getDisabledTypes()).toEqual(["claude_local"]);
    expect(await service.getDisabledTypes()).toEqual(["claude_local"]);
    expect(read).not.toHaveBeenCalled();
    expect(getDisabledAdapterTypes()).toEqual(["codex_local"]);
  });

  it("restores the saved choice when its audit fails and audits a later retry", async () => {
    const transaction = vi.fn(async (callback: (tx: AdapterSettingsDb) => Promise<unknown>) => callback(db));
    const db = { transaction } as unknown as AdapterSettingsDb;
    const service = adapterSettingsService(db);
    const audit = vi.fn().mockRejectedValueOnce(new Error("audit unavailable")).mockResolvedValue(undefined);

    await expect(service.setDisabled("codex_local", true, audit)).rejects.toThrow("audit unavailable");
    expect(await service.getDisabledTypes()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "adapter-settings.json"), "utf8"))).toEqual({ disabledTypes: [] });
    expect(await service.setDisabled("codex_local", true, audit)).toBe(true);
    expect(await service.getDisabledTypes()).toEqual(["codex_local"]);
    expect(audit).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed audit rollback from overwriting a concurrent save", async () => {
    const db = { transaction: async (callback: (tx: AdapterSettingsDb) => Promise<unknown>) => callback(db) } as unknown as AdapterSettingsDb;
    const first = adapterSettingsService(db);
    const second = adapterSettingsService(db);
    let failAudit!: (reason: Error) => void;
    const auditWait = new Promise<void>((_resolve, reject) => { failAudit = reject; });
    const audit = vi.fn(() => auditWait);
    const rejected = expect(first.setDisabled("codex_local", true, audit)).rejects.toThrow("audit unavailable");
    await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce());
    const nextAudit = vi.fn(async () => undefined);
    const next = second.setDisabled("codex_local", true, nextAudit);
    await Promise.resolve();
    expect(nextAudit).not.toHaveBeenCalled();

    failAudit(new Error("audit unavailable"));
    await rejected;
    expect(await next).toBe(true);
    expect(await first.getDisabledTypes()).toEqual(["codex_local"]);
    expect(nextAudit).toHaveBeenCalledOnce();
  });
});
