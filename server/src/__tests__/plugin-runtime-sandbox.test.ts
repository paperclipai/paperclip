import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginModuleInSandbox } from "../services/plugin-runtime-sandbox.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePlugin(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "plugin-sandbox-"));
  dirs.push(dir);
  const entrypoint = path.join(dir, "index.cjs");
  writeFileSync(entrypoint, source);
  return entrypoint;
}

describe("plugin runtime sandbox dynamic import", () => {
  it("rejects a plugin that uses import() at load time instead of crashing the host later", async () => {
    const entrypointPath = writePlugin("setTimeout(() => import('node:fs'), 0);\nmodule.exports = {};\n");
    await expect(loadPluginModuleInSandbox({ entrypointPath })).rejects.toMatchObject({
      name: "PluginSandboxError",
      message: expect.stringContaining("uses dynamic import()"),
    });
  });

  it("blocks runtime code generation that could bypass the import() check", async () => {
    const entrypointPath = writePlugin("module.exports = { run: () => new Function('return 1')() };\n");
    const { namespace } = await loadPluginModuleInSandbox({ entrypointPath });
    expect(() => (namespace.run as () => unknown)()).toThrow(/Code generation from strings disallowed/);
  });

  it("still loads plain CommonJS plugins", async () => {
    const entrypointPath = writePlugin("module.exports = { important: 1, reimport: 'x' };\n");
    const { namespace } = await loadPluginModuleInSandbox({ entrypointPath });
    expect(namespace).toMatchObject({ important: 1, reimport: "x" });
  });
});
