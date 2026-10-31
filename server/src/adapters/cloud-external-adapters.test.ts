import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let localPackage: string;
let npmPackage: string;
let storePath: string;
let sentinel: string;
const parserSource = "export function parseStdoutLine() { return { message: 'external parser' }; }";
const managedError = { status: 403, details: { code: "adapter_install_platform_managed" } };

function writePackage(packageDir: string, type: string): void {
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: `fixture-${type}`,
    type: "module",
    exports: { ".": "./index.mjs", "./ui-parser": "./ui-parser.mjs" },
    paperclip: { adapterUiParser: "1.0.0" },
  }));
  fs.writeFileSync(path.join(packageDir, "index.mjs"), `
    import fs from "node:fs";
    fs.appendFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(type + "\n")});
    export function createServerAdapter() {
      return {
        type: ${JSON.stringify(type)},
        agentConfigurationDoc: "External fixture",
        models: [],
        execute: async () => ({ exitCode: 41, signal: null, timedOut: false }),
        testEnvironment: async () => ({ status: "pass", checks: [] }),
      };
    }
  `);
  fs.writeFileSync(path.join(packageDir, "ui-parser.mjs"), parserSource);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
  vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
  home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cloud-adapters-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  sentinel = path.join(home, "external-code-executed");
  localPackage = path.join(home, "local-package");
  npmPackage = path.join(home, "adapter-plugins", "node_modules", "fixture-npm");
  storePath = path.join(home, "adapter-plugins.json");
  writePackage(localPackage, "codex_local");
  writePackage(npmPackage, "fixture_npm");
  fs.writeFileSync(storePath, JSON.stringify([
    { packageName: "fixture-local", localPath: localPackage, type: "codex_local", installedAt: "2026-01-01" },
    { packageName: "fixture-npm", type: "fixture_npm", installedAt: "2026-01-01" },
  ]));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Cloud image adapter boundary", () => {
  it.each(["PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "PAPERCLIP_MANAGED_CONFIG"])(
    "cold boots built-ins without reading or executing persisted packages with %s",
    async (signal) => {
      vi.stubEnv(signal, signal === "PAPERCLIP_MANAGED_CONFIG" ? "" : "test-token");
      const registrationBefore = fs.readFileSync(storePath, "utf8");
      const reads = vi.spyOn(fs, "readFileSync");
      const registry = await import("./registry.js");
      await registry.waitForExternalAdapters();
      const loader = await import("./plugin-loader.js");
      const store = await import("../services/adapter-plugin-store.js");

      expect(registry.requireServerAdapter("codex_local").agentConfigurationDoc).not.toBe("External fixture");
      expect(registry.requireServerAdapter("process").execute).toBeTypeOf("function");
      expect(registry.findServerAdapter("fixture_npm")).toBeNull();
      expect(registry.hasActiveAdapterOverride("codex_local")).toBe(false);
      expect(await loader.buildExternalAdapters()).toEqual([]);
      expect(store.listAdapterPlugins()).toEqual([]);
      expect(store.getAdapterPluginByType("codex_local")).toBeUndefined();
      expect(loader.getUiParserSource("codex_local")).toBeUndefined();
      expect(loader.getOrExtractUiParserSource("codex_local")).toBeUndefined();
      await expect(loader.loadExternalAdapterPackage("fixture-local", localPackage)).rejects.toMatchObject(managedError);
      await expect(loader.loadExternalAdapterPackage("fixture-npm")).rejects.toMatchObject(managedError);
      await expect(loader.reloadExternalAdapter("codex_local")).rejects.toMatchObject(managedError);
      expect(() => registry.registerServerAdapter(registry.requireServerAdapter("codex_local"))).toThrow();
      expect(() => registry.unregisterServerAdapter("codex_local")).toThrow();
      expect(() => registry.setOverridePaused("codex_local", false)).toThrow();
      expect(() => store.addAdapterPlugin({ packageName: "fixture", type: "fixture", installedAt: "2026-01-01" })).toThrow();
      expect(() => store.removeAdapterPlugin("codex_local")).toThrow();
      expect(() => store.getAdapterPluginsDir()).toThrow();
      expect(store.getAdapterPluginStorePath()).toBe(storePath);
      expect(reads.mock.calls.map(([file]) => String(file)).filter(file =>
        file === storePath || file.startsWith(localPackage + path.sep) || file.startsWith(npmPackage + path.sep),
      )).toEqual([]);
      reads.mockRestore();
      expect(fs.existsSync(sentinel)).toBe(false);
      expect(fs.readFileSync(storePath, "utf8")).toBe(registrationBefore);
    },
  );

  it("preserves local and npm package loading, overrides, reload, and lazy UI parsing on self-hosted instances", async () => {
    const loader = await import("./plugin-loader.js");
    expect(loader.getOrExtractUiParserSource("codex_local")).toBe(parserSource);
    const registry = await import("./registry.js");
    await registry.waitForExternalAdapters();

    const override = registry.requireServerAdapter("codex_local");
    expect(override.agentConfigurationDoc).toBe("External fixture");
    expect(registry.hasActiveAdapterOverride("codex_local")).toBe(true);
    expect(registry.requireServerAdapter("fixture_npm").agentConfigurationDoc).toBe("External fixture");
    expect(await override.execute({} as never)).toMatchObject({ exitCode: 41 });
    expect(fs.readFileSync(sentinel, "utf8").trim().split("\n")).toEqual(["codex_local", "fixture_npm"]);
    expect(loader.getUiParserSource("fixture_npm")).toBe(parserSource);
    const reloaded = await loader.reloadExternalAdapter("codex_local");
    expect(reloaded?.type).toBe("codex_local");
    expect(await reloaded?.execute({} as never)).toMatchObject({ exitCode: 41 });
    expect(registry.setOverridePaused("codex_local", true)).toBe(true);
    expect(registry.findActiveServerAdapter("codex_local")?.agentConfigurationDoc).not.toBe("External fixture");
    expect(registry.setOverridePaused("codex_local", false)).toBe(true);
    registry.unregisterServerAdapter("codex_local");
    expect(registry.requireServerAdapter("codex_local").agentConfigurationDoc).not.toBe("External fixture");
  });

  it("does not expose a cached registration or parser after a managed signal becomes present", async () => {
    const loader = await import("./plugin-loader.js");
    const store = await import("../services/adapter-plugin-store.js");
    await loader.loadExternalAdapterPackage("fixture-local", localPackage);
    expect(loader.getUiParserSource("codex_local")).toBe(parserSource);
    expect(store.listAdapterPlugins()).toHaveLength(2);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", "{}");
    expect(store.listAdapterPlugins()).toEqual([]);
    expect(loader.getUiParserSource("codex_local")).toBeUndefined();
    expect(loader.getOrExtractUiParserSource("codex_local")).toBeUndefined();
  });
});
