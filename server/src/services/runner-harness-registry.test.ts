import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";
import { createRunnerHarnessRegistry, validateRunnerHarnessConfiguration } from "./runner-harness-registry.js";

const roots: string[] = [];
const script = "#!/usr/bin/env node\nprocess.stderr.write('synthetic harness');\n";
const digest = `sha256:${createHash("sha256").update(script).digest("hex")}`;

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-harness-package-")));
  roots.push(root);
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@example/plugin-harness", version: "1.2.3" }));
  await writeFile(path.join(root, "dist", "harness.js"), script);
  await chmod(path.join(root, "dist", "harness.js"), 0o755);
  const now = new Date(0);
  const plugin: PluginRecord = {
    id: "plugin-1", pluginKey: "example.harness", packageName: "@example/plugin-harness", version: "1.2.3",
    apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, packagePath: root,
    lastError: null, installedAt: now, updatedAt: now,
    manifestJson: {
      id: "example.harness", apiVersion: 1, version: "1.2.3", displayName: "Synthetic harness", description: "Synthetic test package",
      author: "Tests", categories: ["automation"], capabilities: ["runner.harnesses.register"], entrypoints: { worker: "dist/worker.js" },
      runnerHarnesses: [{ harnessKey: "synthetic", displayName: "Synthetic", configSchema: { type: "object" },
        platforms: ["linux-x64", "darwin-arm64"], capabilities: { resume: true, interruption: true },
        runtime: { entrypoint: "dist/harness.js", sha256: digest },
        credentials: [{ key: "SYNTHETIC_API_KEY", displayName: "API key", required: true }],
      }],
    },
  };
  return { root, plugin };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("external Runner harness registry", () => {
  it("discovers sanitized metadata without reading or executing the runtime", async () => {
    const { root, plugin } = await fixture();
    const source = vi.fn(async () => [{ plugin, enabled: null }]);
    const registry = createRunnerHarnessRegistry(source);
    await rm(path.join(root, "dist"), { recursive: true });
    const [harness] = await registry.list("company-1");
    expect(source).toHaveBeenCalledWith("company-1");
    expect(harness).toMatchObject({ harnessId: "example.harness/synthetic", displayName: "Synthetic", protocolVersion: 1 });
    expect(harness).not.toHaveProperty("packageRoot");
    expect(harness).not.toHaveProperty("entrypoint");
    expect(harness).not.toHaveProperty("runtime");
  });

  it("verifies real package bytes and binds all shipped assets to the release", async () => {
    const { root, plugin } = await fixture();
    const registry = createRunnerHarnessRegistry(async () => [{ plugin, enabled: true }]);
    const first = await registry.resolve("company-1", "example.harness/synthetic");
    const repeated = await registry.resolve("company-1", "example.harness/synthetic");
    expect(first.entrypoint).toBe(path.join(root, "dist", "harness.js"));
    expect(first.release).toEqual(repeated.release);
    expect(first.release).toMatchObject({ harnessId: "example.harness/synthetic", packageName: "@example/plugin-harness", version: "1.2.3", protocolVersion: 1 });
    expect(first.release.integrity).toMatch(/^sha256-/);
    await writeFile(path.join(root, "dist", "model-config.json"), "{}");
    const changed = await registry.resolve("company-1", "example.harness/synthetic");
    expect(changed.release.runtimeDigest).not.toBe(first.release.runtimeDigest);
    expect(changed.release.integrity).not.toBe(first.release.integrity);
  });

  it("uses current company eligibility for every resolve and never reuses another company's enablement", async () => {
    const { plugin } = await fixture();
    const registry = createRunnerHarnessRegistry(async companyId => [{ plugin, enabled: companyId === "allowed" }]);
    expect(await registry.list("foreign")).toEqual([]);
    await expect(registry.resolve("foreign", "example.harness/synthetic")).rejects.toMatchObject({ status: 422, details: { code: "runner_harness_unavailable" } });
    await expect(registry.resolve("allowed", "example.harness/synthetic")).resolves.toHaveProperty("entrypoint");
    plugin.status = "disabled";
    expect(await registry.list("allowed")).toEqual([]);
    await expect(registry.resolve("allowed", "example.harness/synthetic")).rejects.toMatchObject({ status: 422 });
  });

  it("rejects tampered executables, mismatched metadata, and symlinked assets", async () => {
    const { root, plugin } = await fixture();
    const registry = createRunnerHarnessRegistry(async () => [{ plugin, enabled: true }]);
    await writeFile(path.join(root, "dist", "harness.js"), `${script}modified`);
    await expect(registry.resolve("company-1", "example.harness/synthetic")).rejects.toMatchObject({ details: { code: "runner_harness_integrity_invalid" } });
    await writeFile(path.join(root, "dist", "harness.js"), script);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@example/plugin-harness", version: "9.0.0" }));
    await expect(registry.resolve("company-1", "example.harness/synthetic")).rejects.toMatchObject({ status: 422 });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@example/plugin-harness", version: "1.2.3" }));
    await symlink(path.join(root, "package.json"), path.join(root, "dist", "link.json"));
    await expect(registry.resolve("company-1", "example.harness/synthetic")).rejects.toMatchObject({ status: 422 });
  });

  it("requires the managed image's resolver and activation guard without npm fallback", async () => {
    const { root, plugin } = await fixture();
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", "{}");
    const source = async () => [{ plugin, enabled: true }];
    await expect(createRunnerHarnessRegistry(source).resolve("company-1", "example.harness/synthetic")).rejects.toMatchObject({ status: 422 });
    const assertPackageActivation = vi.fn(() => { throw new Error("Image no longer selects this package"); });
    const registry = createRunnerHarnessRegistry(source, { resolvePackageRoot: () => root, assertPackageActivation });
    await expect(registry.resolve("company-1", "example.harness/synthetic")).rejects.toMatchObject({ status: 422 });
    expect(assertPackageActivation).toHaveBeenCalledWith(expect.objectContaining({ pluginKey: plugin.pluginKey, packageRoot: root }));
  });

  it("does no filesystem work when no harness package is installed", async () => {
    const resolvePackageRoot = vi.fn(() => { throw new Error("must not resolve"); });
    const registry = createRunnerHarnessRegistry(async () => [], { resolvePackageRoot });
    expect(await registry.list("company-1")).toEqual([]);
    await expect(registry.resolve("company-1", "example.harness/missing")).rejects.toMatchObject({ status: 422 });
    expect(resolvePackageRoot).not.toHaveBeenCalled();
  });

  it("validates package-owned settings and limits credential bindings to declared keys", async () => {
    const { plugin } = await fixture();
    plugin.manifestJson.runnerHarnesses![0].configSchema = { type: "object", additionalProperties: false,
      properties: { mode: { type: "string", enum: ["coding", "review"] } }, required: ["mode"] };
    const registry = createRunnerHarnessRegistry(async () => [{ plugin, enabled: true }]);
    const resolved = await registry.resolve("company-1", "example.harness/synthetic");
    const config = { extensionConfig: { mode: "coding" }, env: { SYNTHETIC_API_KEY: { type: "secret_ref", secretId: "secret-1" } } };
    expect(() => validateRunnerHarnessConfiguration(resolved, config)).not.toThrow();
    expect(() => validateRunnerHarnessConfiguration(resolved, { ...config, extensionConfig: { mode: "unknown" } }))
      .toThrow("Check the harness settings");
    expect(() => validateRunnerHarnessConfiguration(resolved, { ...config, env: { NODE_OPTIONS: "unsafe" } }))
      .toThrow("declared credential bindings");
  });
});
