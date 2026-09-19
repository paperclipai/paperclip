import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafePluginSpec,
  commandOnPath,
  DEFAULT_NPMRC_MODE,
  ensureIgnoreScriptsNpmrc,
  mergeIgnoreScriptsNpmrc,
  planPluginInstall,
  pluginInstallChildEnv,
  resolvePluginPackageManager,
  writeFileAtomic,
} from "../services/plugin-installer.js";

function fileMode(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

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

describe("writeFileAtomic", () => {
  it("replaces the target via a sibling temp file then rename", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-npmrc-atomic-"));
    try {
      const target = path.join(dir, ".npmrc");
      writeFileSync(target, "registry=https://npm.example/\n_authToken=old-secret\n");

      await writeFileAtomic(target, "registry=https://npm.example/\n_authToken=old-secret\nignore-scripts=true\n");

      expect(readFileSync(target, "utf8")).toBe(
        "registry=https://npm.example/\n_authToken=old-secret\nignore-scripts=true\n",
      );
      expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the live file intact when the sibling temp cannot be created", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-npmrc-crash-"));
    const target = path.join(dir, ".npmrc");
    const original = "@scope:registry=https://npm.example/\n//npm.example/:_authToken=secret\n";
    writeFileSync(target, original);
    chmodSync(dir, 0o555);
    try {
      await expect(writeFileAtomic(target, "ignore-scripts=true\n")).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readFileSync(target, "utf8")).toBe(original);
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves an existing 0600 mode so registry credentials stay owner-only", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-npmrc-mode-"));
    try {
      const target = path.join(dir, ".npmrc");
      writeFileSync(target, "registry=https://npm.example/\n_authToken=secret\n", { mode: 0o600 });
      chmodSync(target, 0o600);
      expect(fileMode(target)).toBe(0o600);

      await writeFileAtomic(target, "registry=https://npm.example/\n_authToken=secret\nignore-scripts=true\n");

      expect(fileMode(target)).toBe(0o600);
      expect(readFileSync(target, "utf8")).toContain("ignore-scripts=true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a non-default existing mode instead of forcing 0600", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-npmrc-mode-640-"));
    try {
      const target = path.join(dir, ".npmrc");
      writeFileSync(target, "registry=https://npm.example/\n", { mode: 0o640 });
      chmodSync(target, 0o640);

      await writeFileAtomic(target, "registry=https://npm.example/\nignore-scripts=true\n");

      expect(fileMode(target)).toBe(0o640);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a missing file with owner-only 0600", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-npmrc-new-mode-"));
    try {
      const target = path.join(dir, ".npmrc");
      await writeFileAtomic(target, "ignore-scripts=true\n");
      expect(fileMode(target)).toBe(DEFAULT_NPMRC_MODE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureIgnoreScriptsNpmrc", () => {
  it("creates prefix .npmrc with ignore-scripts when missing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-npmrc-missing-"));
    try {
      await ensureIgnoreScriptsNpmrc(dir);
      const npmrcPath = path.join(dir, ".npmrc");
      expect(readFileSync(npmrcPath, "utf8")).toBe("ignore-scripts=true\n");
      expect(fileMode(npmrcPath)).toBe(DEFAULT_NPMRC_MODE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges ignore-scripts without dropping registry or auth keys", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-npmrc-merge-"));
    try {
      const npmrcPath = path.join(dir, ".npmrc");
      writeFileSync(
        npmrcPath,
        "@scope:registry=https://npm.example/\n//npm.example/:_authToken=secret\n",
        { mode: 0o600 },
      );
      chmodSync(npmrcPath, 0o600);
      await ensureIgnoreScriptsNpmrc(dir);
      const out = readFileSync(npmrcPath, "utf8");
      expect(out).toContain("@scope:registry=https://npm.example/");
      expect(out).toContain("//npm.example/:_authToken=secret");
      expect(out).toContain("ignore-scripts=true");
      expect(fileMode(npmrcPath)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates non-ENOENT read failures instead of wiping the prefix config", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-npmrc-eisdir-"));
    try {
      mkdirSync(path.join(dir, ".npmrc"));
      await expect(ensureIgnoreScriptsNpmrc(dir)).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
