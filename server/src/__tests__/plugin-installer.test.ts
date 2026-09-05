import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafePluginSpec,
  commandOnPath,
  mergeIgnoreScriptsNpmrc,
  planPluginInstall,
  pluginInstallChildEnv,
  resolvePluginPackageManager,
} from "../services/plugin-installer.js";

describe("plugin installer package manager", () => {
  it("prefers bun when bun is on PATH", () => {
    expect(resolvePluginPackageManager({}, () => true)).toBe("bun");
    const plan = planPluginInstall("@scope/plug@1.0.0", "/tmp/plugins", {}, () => true);
    expect(plan.command).toBe("bun");
    expect(plan.args).toEqual([
      "add",
      "--cwd",
      "/tmp/plugins",
      "--ignore-scripts",
      "--",
      "@scope/plug@1.0.0",
    ]);
  });

  it("honors PAPERCLIP_PLUGIN_PACKAGE_MANAGER=npm even if bun exists", () => {
    const env = { PAPERCLIP_PLUGIN_PACKAGE_MANAGER: "npm" };
    expect(resolvePluginPackageManager(env, () => true)).toBe("npm");
    const plan = planPluginInstall("paperclip-plugin-x", "/tmp/plugins", env, () => true);
    expect(plan.args).toEqual([
      "install",
      "--prefix",
      "/tmp/plugins",
      "--save",
      "--",
      "paperclip-plugin-x",
    ]);
    expect(plan.args).not.toContain("--ignore-scripts");
    expect(plan.args.indexOf("--")).toBeLessThan(plan.args.indexOf("paperclip-plugin-x"));
  });

  it("uses bun when env forces bun", () => {
    expect(
      resolvePluginPackageManager({ PAPERCLIP_PLUGIN_PACKAGE_MANAGER: "bun" }, () => false),
    ).toBe("bun");
  });

  it("rejects leading-dash plugin specs before they reach argv", () => {
    expect(() => planPluginInstall("--ignore-scripts=false", "/tmp/plugins", {}, () => false)).toThrow(
      /invalid plugin spec/,
    );
    expect(() => assertSafePluginSpec("-evil")).toThrow(/invalid plugin spec/);
  });
});

describe("commandOnPath", () => {
  it("ignores directories that share a binary name", () => {
    const dir = path.join(os.tmpdir(), `paperclip-which-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, "bun"), { recursive: true });
    expect(commandOnPath("bun", { PATH: dir })).toBe(false);
  });

  it("requires a regular executable file", () => {
    const dir = path.join(os.tmpdir(), `paperclip-which-file-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "bun");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o644);
    expect(commandOnPath("bun", { PATH: dir })).toBe(false);
    chmodSync(bin, 0o755);
    expect(commandOnPath("bun", { PATH: dir })).toBe(true);
  });
});

describe("pluginInstallChildEnv", () => {
  it("strips inherited npm_config_ignore_scripts so prefix .npmrc wins", () => {
    const out = pluginInstallChildEnv({
      PATH: "/usr/bin",
      npm_config_ignore_scripts: "false",
      NPM_CONFIG_IGNORE_SCRIPTS: "0",
    });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.npm_config_ignore_scripts).toBeUndefined();
    expect(out.NPM_CONFIG_IGNORE_SCRIPTS).toBeUndefined();
  });
});

describe("mergeIgnoreScriptsNpmrc", () => {
  it("writes ignore-scripts into an empty file", () => {
    expect(mergeIgnoreScriptsNpmrc("")).toBe("ignore-scripts=true\n");
  });

  it("keeps registry and auth keys", () => {
    const out = mergeIgnoreScriptsNpmrc("@scope:registry=https://npm.example/\n//npm.example/:_authToken=secret\n");
    expect(out).toContain("@scope:registry=https://npm.example/");
    expect(out).toContain("//npm.example/:_authToken=secret");
    expect(out).toContain("ignore-scripts=true");
  });

  it("forces ignore-scripts=true when already present", () => {
    expect(mergeIgnoreScriptsNpmrc("ignore-scripts=false\nregistry=https://registry.npmjs.org/\n")).toBe(
      "registry=https://registry.npmjs.org/\nignore-scripts=true\n",
    );
  });

  it("rewrites a trailing ignore-scripts=false so the last npm assignment stays true", () => {
    expect(
      mergeIgnoreScriptsNpmrc("ignore-scripts=true\nregistry=https://registry.npmjs.org/\nignore-scripts=false\n"),
    ).toBe("registry=https://registry.npmjs.org/\nignore-scripts=true\n");
  });
});
