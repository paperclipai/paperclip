import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_BUILD_STAMP, pluginBuildInputHash, pluginBuildState } from "./plugin-build.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function plugin(): Promise<{ root: string; sdk: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "chaos-plugin-"));
  roots.push(base);
  const root = path.join(base, "daytona");
  const sdk = path.join(base, "sdk-src");
  for (const [file, content] of Object.entries({
    "package.json": "{\"name\":\"@paperclipai/plugin-daytona\"}", "pnpm-lock.yaml": "lock: 1\n", "tsconfig.json": "{}",
    "src/plugin.ts": "export const v = 1;\n", "src/nested/worker.ts": "export {};\n",
    "dist/manifest.js": "", "dist/worker.js": "", "node_modules/@daytonaio/sdk/package.json": "{}",
    "node_modules/ignored/index.js": "ignored",
  })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  await mkdir(sdk, { recursive: true });
  await writeFile(path.join(sdk, "index.ts"), "export const sdk = 1;\n");
  return { root, sdk };
}

const stamp = (root: string, hash: string) => writeFile(path.join(root, PLUGIN_BUILD_STAMP), `${hash}\n`);

describe("Daytona plugin build staleness", () => {
  it("rebuilds an unstamped build, then reports up to date once stamped with its inputs", async () => {
    const { root, sdk } = await plugin();
    const first = pluginBuildState(root, [sdk]);
    expect(first).toMatchObject({ needsBuild: true, needsInstall: false, reason: "build was not stamped with its inputs" });
    await stamp(root, first.inputHash);
    expect(pluginBuildState(root, [sdk])).toMatchObject({ needsBuild: false, reason: "up to date" });
  });

  it("detects a changed plugin source, lockfile or plugin SDK source after a build", async () => {
    const { root, sdk } = await plugin();
    await stamp(root, pluginBuildInputHash(root, [sdk]));
    await writeFile(path.join(root, "src/plugin.ts"), "export const v = 2;\n");
    expect(pluginBuildState(root, [sdk])).toMatchObject({ needsBuild: true, reason: "plugin sources changed since the last build" });

    await stamp(root, pluginBuildInputHash(root, [sdk]));
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lock: 2\n");
    expect(pluginBuildState(root, [sdk]).needsBuild).toBe(true);

    await stamp(root, pluginBuildInputHash(root, [sdk]));
    await writeFile(path.join(sdk, "index.ts"), "export const sdk = 2;\n");
    expect(pluginBuildState(root, [sdk]).needsBuild).toBe(true);
  });

  it("detects a change to an inherited tsconfig passed as a single-file extra input", async () => {
    const { root, sdk } = await plugin();
    const baseConfig = path.join(path.dirname(root), "tsconfig.base.json");
    await writeFile(baseConfig, "{\"compilerOptions\":{\"target\":\"ES2022\"}}");
    await stamp(root, pluginBuildInputHash(root, [sdk, baseConfig]));
    expect(pluginBuildState(root, [sdk, baseConfig]).needsBuild).toBe(false);
    await writeFile(baseConfig, "{\"compilerOptions\":{\"target\":\"ES2024\"}}");
    expect(pluginBuildState(root, [sdk, baseConfig])).toMatchObject({ needsBuild: true, reason: "plugin sources changed since the last build" });
  });

  it("ignores node_modules and build output, and requires dependencies and outputs", async () => {
    const { root, sdk } = await plugin();
    const hash = pluginBuildInputHash(root, [sdk]);
    await writeFile(path.join(root, "node_modules/ignored/index.js"), "changed");
    await writeFile(path.join(root, "dist/worker.js"), "changed");
    expect(pluginBuildInputHash(root, [sdk])).toBe(hash);
    await stamp(root, hash);
    await rm(path.join(root, "dist/manifest.js"));
    expect(pluginBuildState(root, [sdk])).toMatchObject({ needsBuild: true, reason: "build output missing" });
    await rm(path.join(root, "node_modules/@daytonaio"), { recursive: true });
    expect(pluginBuildState(root, [sdk])).toMatchObject({ needsInstall: true, reason: "dependencies missing" });
  });
});
