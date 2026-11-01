import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installedReleaseDaytonaPlugin, installedReleaseEnvironment, installedReleaseLaunch } from "./installed-release.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
describe("ordinary installed release smoke", () => {
  it("launches the public compiled CLI from its own consumer root", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "installed-paperclip-"))); roots.push(root);
    mkdirSync(path.join(root, "dist"));
    const cli = path.join(root, "dist", "index.js"); writeFileSync(cli, "");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "paperclipai", version: "0.0.0-verify" }));
    expect(installedReleaseLaunch(cli)).toMatchObject({ cwd: root, args: [cli, "onboard", "--yes", "--run"], version: "0.0.0-verify" });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "other-cli", version: "1.0.0" }));
    expect(() => installedReleaseLaunch(cli)).toThrow("public package");
    expect(() => installedReleaseLaunch("relative/index.js")).toThrow("absolute path");
  });
  it("uses the public compiled Daytona plugin beside the installed CLI", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "installed-daytona-"))); roots.push(root);
    const cliRoot = path.join(root, "node_modules/paperclipai"), plugin = path.join(root, "node_modules/@paperclipai/plugin-daytona");
    mkdirSync(path.join(cliRoot, "dist"), { recursive: true }); mkdirSync(path.join(plugin, "dist"), { recursive: true });
    const cli = path.join(cliRoot, "dist/index.js"); writeFileSync(cli, "");
    writeFileSync(path.join(cliRoot, "package.json"), JSON.stringify({ name: "paperclipai", version: "0.0.0-verify" }));
    const manifest = { name: "@paperclipai/plugin-daytona", version: "0.0.0-verify", paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" }, exports: { ".": { import: "./dist/index.js" } } };
    for (const file of ["manifest.js", "worker.js", "index.js"]) writeFileSync(path.join(plugin, "dist", file), "");
    writeFileSync(path.join(plugin, "package.json"), JSON.stringify(manifest));
    expect(installedReleaseDaytonaPlugin(cli)).toBe(plugin);
    expect(installedReleaseDaytonaPlugin(cli, plugin)).toBe(plugin);
    expect(() => installedReleaseDaytonaPlugin(cli, "relative/plugin")).toThrow("absolute");
    writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ ...manifest, version: "0.0.0-stale" }));
    expect(() => installedReleaseDaytonaPlugin(cli, plugin)).toThrow("qualified release version 0.0.0-verify");
    expect(installedReleaseDaytonaPlugin(cli, plugin, "0.0.0-stale")).toBe(plugin);
    writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ ...manifest, version: undefined }));
    expect(() => installedReleaseDaytonaPlugin(cli, plugin)).toThrow("qualified release version");
    writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ ...manifest, exports: { ".": "./src/index.ts" } }));
    expect(() => installedReleaseDaytonaPlugin(cli)).toThrow("public compiled Daytona");
    writeFileSync(path.join(plugin, "package.json"), JSON.stringify(manifest));
    rmSync(path.join(plugin, "dist/worker.js"));
    expect(() => installedReleaseDaytonaPlugin(cli)).toThrow();
  });

  it("removes repository executables, provider packs, native paths and loader injection", () => {
    const source = { PATH: "/repo/packages/node_modules/.bin:/tmp/provider-bin:/usr/bin:/tmp/node/bin", NODE_OPTIONS: "--import /repo/loader", NODE_PATH: "/repo/node_modules",
      PAPERCLIP_RUNNER_BINARY: "/repo/runner", PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT: "/private/pack",
      PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH: "/private/pack", PAPERCLIP_ACPX_BUILTIN_ROOT: "/repo/providers",
      PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH: "/repo/context", PAPERCLIP_RUNNER_E2E_PORT: "3100", PAPERCLIP_HOME: "/tmp/home" };
    expect(installedReleaseEnvironment(source, "/repo", "/tmp/provider-bin")).toEqual({ PATH: "/usr/bin:/tmp/node/bin", PAPERCLIP_RUNNER_E2E_PORT: "3100", PAPERCLIP_HOME: "/tmp/home" });
    expect(source.PAPERCLIP_RUNNER_BINARY).toBe("/repo/runner");
  });
  it("rejects qualification admission instead of silently relabeling it as production", () => {
    expect(() => installedReleaseEnvironment({ PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "cursor" }, "/repo", "/tmp/provider-bin")).toThrow("production admission");
  });
});
