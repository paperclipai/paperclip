import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import {
  createCapabilityScopedInvoker,
  loadPluginModuleInSandbox,
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
    id: "acme.integration-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Integration Plugin",
    description: "test",
    author: "Acme",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "worker.js" },
  };
}

function writePluginFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-sandbox-integration-"));
  tempDirs.push(dir);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(dir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, "utf8");
  }

  return path.join(dir, "worker.js");
}

describe("plugin runtime sandbox integration", () => {
  it("allows declared runtime operation invoked by plugin-loaded code", async () => {
    const entrypointPath = writePluginFixture({
      "worker.js": `
const host = require("paperclip:host");
module.exports = {
  run: async () => host.execute("issues.list", async () => "ok"),
};
`,
    });

    const invoker = createCapabilityScopedInvoker(
      makeManifest(["issues.read"]),
      pluginCapabilityValidator(),
    );

    const loaded = await loadPluginModuleInSandbox({
      entrypointPath,
      allowedModuleSpecifiers: new Set(["paperclip:host"]),
      allowedModules: {
        "paperclip:host": {
          execute: invoker.invoke.bind(invoker),
        },
      },
    });

    const run = loaded.namespace.run as (() => Promise<string>) | undefined;
    expect(run).toBeTypeOf("function");
    await expect(run?.()).resolves.toBe("ok");
  });

  it("denies undeclared runtime operation and does not execute host action", async () => {
    const entrypointPath = writePluginFixture({
      "worker.js": `
const host = require("paperclip:host");
module.exports = {
  run: async () => host.execute("issues.create", async () => "created"),
};
`,
    });

    const sideEffect = vi.fn(async () => "created");
    const invoker = createCapabilityScopedInvoker(
      makeManifest(["issues.read"]),
      pluginCapabilityValidator(),
    );

    const loaded = await loadPluginModuleInSandbox({
      entrypointPath,
      allowedModuleSpecifiers: new Set(["paperclip:host"]),
      allowedModules: {
        "paperclip:host": {
          execute: (operation: string, fn: () => Promise<string>) =>
            invoker.invoke(operation, async () => {
              await sideEffect();
              return fn();
            }),
        },
      },
    });

    const run = loaded.namespace.run as (() => Promise<string>) | undefined;
    expect(run).toBeTypeOf("function");
    await expect(run?.()).rejects.toMatchObject({ status: 403 });
    expect(sideEffect).toHaveBeenCalledTimes(0);
  });
});
