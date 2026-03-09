import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import {
  createCapabilityScopedInvoker,
  loadPluginModuleInSandbox,
  PluginSandboxError,
} from "../services/plugin-runtime-sandbox.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // no-op; cleanup is best-effort in tests.
    }
  }
  tempDirs.length = 0;
});

function makeManifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "acme.plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Acme Plugin",
    description: "test",
    author: "Acme",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "worker.js" },
  };
}

function writeTempModule(filename: string, contents: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-sandbox-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

describe("createCapabilityScopedInvoker", () => {
  it("allows declared operations", async () => {
    const invoker = createCapabilityScopedInvoker(
      makeManifest(["issues.read"]),
      pluginCapabilityValidator(),
    );

    await expect(
      invoker.invoke("issues.list", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("denies undeclared operations", async () => {
    const invoker = createCapabilityScopedInvoker(
      makeManifest([]),
      pluginCapabilityValidator(),
    );

    await expect(
      invoker.invoke("issues.create", async () => "nope"),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("loadPluginModuleInSandbox", () => {
  it("loads a simple plugin module in an isolated VM context", async () => {
    const modulePath = writeTempModule(
      "worker.js",
      "module.exports = { meaning: 42, default: { setup: async () => {} } };",
    );

    const loaded = await loadPluginModuleInSandbox({
      entrypointPath: modulePath,
    });

    expect(loaded.namespace.meaning).toBe(42);
    expect(loaded.namespace.default).toBeDefined();
  });

  it("blocks imports for undeclared module specifiers", async () => {
    const modulePath = writeTempModule(
      "worker.js",
      "const { readFileSync } = require('node:fs'); module.exports = { readFileSync };",
    );

    await expect(
      loadPluginModuleInSandbox({ entrypointPath: modulePath }),
    ).rejects.toBeInstanceOf(PluginSandboxError);
  });

  it("rejects ESM syntax because sandboxed loader is CommonJS-only", async () => {
    const modulePath = writeTempModule(
      "worker.js",
      "export const answer = 42;",
    );

    await expect(
      loadPluginModuleInSandbox({ entrypointPath: modulePath }),
    ).rejects.toMatchObject({
      name: "PluginSandboxError",
      message: expect.stringContaining("CommonJS"),
    });
  });

  it("does not expose process to the sandbox by default", async () => {
    const modulePath = writeTempModule(
      "worker.js",
      "module.exports = { processType: typeof process };",
    );

    const loaded = await loadPluginModuleInSandbox({ entrypointPath: modulePath });

    expect(loaded.namespace.processType).toBe("undefined");
  });

  it("allows explicit host bindings for allow-listed module specifiers", async () => {
    const modulePath = writeTempModule(
      "worker.js",
      "const host = require('paperclip:host'); module.exports = { value: host.answer };",
    );

    const loaded = await loadPluginModuleInSandbox({
      entrypointPath: modulePath,
      allowedModuleSpecifiers: new Set(["paperclip:host"]),
      allowedModules: {
        "paperclip:host": { answer: 42 },
      },
    });

    expect(loaded.namespace.value).toBe(42);
  });

  it("blocks allow-listed bare imports that have no host binding", async () => {
    const modulePath = writeTempModule(
      "worker.js",
      "const host = require('paperclip:host'); module.exports = host;",
    );

    await expect(
      loadPluginModuleInSandbox({
        entrypointPath: modulePath,
        allowedModuleSpecifiers: new Set(["paperclip:host"]),
      }),
    ).rejects.toBeInstanceOf(PluginSandboxError);
  });

  it("blocks relative imports that escape the plugin root", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-sandbox-"));
    tempDirs.push(dir);
    const pluginDir = path.join(dir, "plugin");
    const outsideDir = path.join(dir, "outside");
    const pluginWorkerPath = path.join(pluginDir, "worker.js");
    const outsideModulePath = path.join(outsideDir, "secret.js");

    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    writeFileSync(outsideModulePath, "module.exports = { secret: true };", "utf8");
    writeFileSync(
      pluginWorkerPath,
      "module.exports = require('../outside/secret.js');",
      "utf8",
    );

    await expect(
      loadPluginModuleInSandbox({ entrypointPath: pluginWorkerPath }),
    ).rejects.toBeInstanceOf(PluginSandboxError);
  });

  it("times out for synchronously non-terminating module evaluation", async () => {
    const modulePath = writeTempModule(
      "worker.js",
      "while (true) {}\nmodule.exports = { ok: true };",
    );

    await expect(
      loadPluginModuleInSandbox({ entrypointPath: modulePath, timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/i);
  });
});
