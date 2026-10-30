import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../adapters/registry.js", () => ({ listServerAdapters: () => [{ type: "codex_local" }, { type: "claude_local" }] }));
import { adapterSettingsService } from "./adapter-settings.js";
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
});
