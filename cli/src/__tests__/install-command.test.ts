import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  installCommand,
  installGitPayload,
  resolveGitHubRef,
  resolveGitInstallRequest,
  resolveGitInstallWorkspacePackages,
  resolveNpmInstallRequest,
  runCommandWithDiagnostics,
} from "../commands/install.js";
import { uninstallCommand } from "../commands/uninstall.js";
import { resolvePaperclipInstanceId } from "../config/home.js";
import {
  INSTALL_MANIFEST_VERSION,
  flipCurrentAtomic,
  initializeInstallStore,
  payloadPathFor,
  readInstallManifest,
  resolveInstallStorePaths,
  withInstallStoreLock,
  writeInstallManifestAtomic,
} from "../install-store.js";
import { resolveCliVersion } from "../version.js";
import { systemdServiceName } from "../services/service-manager.js";

const ORIGINAL_ENV = { ...process.env };
const SERVER_PACKAGE_FILES = (JSON.parse(fs.readFileSync(new URL("../../../server/package.json", import.meta.url), "utf8")) as { files: string[] }).files;

describe("managed install commands", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-command-"));
    process.env = {
      ...ORIGINAL_ENV,
      HOME: path.join(root, "home"),
      PAPERCLIP_HOME: path.join(root, "home", ".paperclip"),
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/bash",
    };
    fs.mkdirSync(process.env.HOME!, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("selects stable, canary, and exact-version npm sources", () => {
    expect(resolveNpmInstallRequest({})).toEqual({ spec: "latest", channel: "latest" });
    expect(resolveNpmInstallRequest({ canary: true })).toEqual({ spec: "canary", channel: "canary" });
    expect(resolveNpmInstallRequest({ version: "2026.720.0" })).toEqual({
      spec: "2026.720.0",
      channel: "pinned",
    });
    expect(() => resolveNpmInstallRequest({ canary: true, version: "1.2.3" })).toThrow();
    expect(() => resolveNpmInstallRequest({ version: "latest" })).toThrow();
  });

  it("resolves branch, tag, full SHA, and short SHA refs through GitHub", async () => {
    const sha = "a".repeat(40);
    const runCommand = vi.fn(async (_file: string, _args: string[]) => ({ stdout: JSON.stringify({ sha }), stderr: "" }));
    for (const ref of ["master", "v1.2.3", sha, sha.slice(0, 12)]) {
      await expect(resolveGitHubRef("paperclipai/paperclip", ref, runCommand)).resolves.toBe(sha);
    }
    expect(runCommand.mock.calls.map((call) => call[1].at(-1))).toEqual([
      "https://api.github.com/repos/paperclipai/paperclip/commits/master",
      "https://api.github.com/repos/paperclipai/paperclip/commits/v1.2.3",
      `https://api.github.com/repos/paperclipai/paperclip/commits/${sha}`,
      `https://api.github.com/repos/paperclipai/paperclip/commits/${sha.slice(0, 12)}`,
    ]);
  });

  it("supports fork overrides and classifies SHA refs as pinned", () => {
    expect(resolveGitInstallRequest({ ref: "feature/test", repo: "HenkDz/paperclip" })).toEqual({ repo: "HenkDz/paperclip", ref: "feature/test", pinned: false });
    expect(resolveGitInstallRequest({ ref: "abcdef1" })).toEqual({ repo: "paperclipai/paperclip", ref: "abcdef1", pinned: true });
    expect(() => resolveGitInstallRequest({ repo: "HenkDz/paperclip" })).toThrow("requires --ref");
  });

  it("requires explicit non-interactive consent before resolving git refs", async () => {
    const runCommand = vi.fn();

    await expect(installCommand({ ref: "master", repo: "HenkDz/paperclip" }, { runCommand }))
      .rejects.toThrow("Re-run with --yes");

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("reuses a SHA-keyed git payload without downloading or rebuilding", async () => {
    const sha = "b".repeat(40);
    const paths = resolveInstallStorePaths();
    const payloadPath = payloadPathFor(paths, "git", sha.slice(0, 12));
    const packageRoot = path.join(payloadPath, "node_modules", "paperclipai");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.3.1" }));
    fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "#!/usr/bin/env node\n");
    const runCommand = vi.fn(async (_file: string, _args: string[]) => ({ stdout: "0.3.1\n", stderr: "" }));
    await expect(installGitPayload("paperclipai/paperclip", sha, runCommand, paths)).resolves.toEqual({ payloadPath, reused: true, version: "0.3.1" });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0]?.[0]).toBe(process.execPath);
  });

  const createGitCheckoutRunCommand = (sha: string, { bundledServer = false }: { bundledServer?: boolean } = {}) =>
    vi.fn(async (file: string, args: string[], _options?: Parameters<CommandRunner>[2]) => {
      if (file === "curl" && !args.includes("--output")) return { stdout: JSON.stringify({ sha }), stderr: "" };
      if (file === "curl") { fs.writeFileSync(args[args.indexOf("--output") + 1], "archive"); return { stdout: "", stderr: "" }; }
      if (file === "tar") {
        const checkout = args[args.indexOf("-C") + 1];
        const packages = [
          { dir: "packages/shared", name: "@paperclipai/shared", packageJson: { name: "@paperclipai/shared", version: "0.3.1" } },
          { dir: "packages/db", name: "@paperclipai/db", packageJson: { name: "@paperclipai/db", version: "0.3.1", dependencies: { "@paperclipai/shared": "workspace:*" }, bundleDependencies: ["embedded-postgres"] } },
          { dir: "server", name: "@paperclipai/server", packageJson: { name: "@paperclipai/server", version: "0.3.1", dependencies: { "@paperclipai/db": "workspace:*" }, ...(bundledServer ? { bundleDependencies: ["acpx"], files: SERVER_PACKAGE_FILES } : {}) } },
        ];
        fs.mkdirSync(path.join(checkout, "cli"), { recursive: true });
        fs.writeFileSync(path.join(checkout, "cli", "package.json"), JSON.stringify({ version: "0.3.1" }));
        fs.writeFileSync(path.join(checkout, "pnpm-lock.yaml"), "source lockfile awaiting refresh\n");
        fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
        fs.writeFileSync(path.join(checkout, "scripts", "release-package-manifest.json"), JSON.stringify(packages.map(({ dir, name }) => ({ dir, name }))));
        for (const workspacePackage of packages) {
          fs.mkdirSync(path.join(checkout, workspacePackage.dir), { recursive: true });
          fs.writeFileSync(path.join(checkout, workspacePackage.dir, "package.json"), JSON.stringify(workspacePackage.packageJson));
        }
        const skill = path.join(checkout, "skills", "paperclip");
        fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
        fs.writeFileSync(path.join(skill, "SKILL.md"), "Skill from this Git checkout\n");
        fs.writeFileSync(path.join(skill, "scripts", "helper.mjs"), "export const sameCheckout = true;\n");
        for (const packageDir of ["server", "packages/adapters/claude-local", "packages/adapters/codex-local"]) {
          const stale = path.join(checkout, packageDir, "skills");
          fs.mkdirSync(stale, { recursive: true });
          fs.writeFileSync(path.join(stale, "stale.md"), "stale package-local skills\n");
        }
        return { stdout: "", stderr: "" };
      }
      if (file === "corepack") {
        if (args.includes("build")) {
          const dist = path.join(_options!.cwd as string, "server", "dist");
          fs.mkdirSync(dist, { recursive: true });
          fs.writeFileSync(path.join(dist, "index.js"), "export const builtServer = true;\n");
        }
        if (args.includes("prepare:ui-dist")) {
          const ui = path.join(_options!.cwd as string, "server", "ui-dist");
          fs.mkdirSync(ui, { recursive: true });
          fs.writeFileSync(path.join(ui, "index.html"), "<html>Built from this Git checkout</html>");
        }
        if (args.includes("--resolution-only")) {
          fs.writeFileSync(path.join(_options!.cwd as string, "pnpm-lock.yaml"), "resolved checkout lockfile\n");
        }
        if (args.includes("--frozen-lockfile")) {
          expect(fs.readFileSync(path.join(_options!.cwd as string, "pnpm-lock.yaml"), "utf8")).toBe("resolved checkout lockfile\n");
        }
        if (args.includes("pack")) {
          const destination = args[args.indexOf("--pack-destination") + 1];
          const packageDir = args[args.indexOf("--dir") + 1];
          const packageName = packageDir === "server" ? "paperclipai-server" : "paperclipai-shared";
          fs.writeFileSync(path.join(destination, `${packageName}-0.3.1.tgz`), "package");
        }
        return { stdout: "", stderr: "" };
      }
      if (file === "bash") return { stdout: "", stderr: "" };
      if (file === "npm" && args[0] === "pack") {
        const packageName = args[1]?.includes("workspace-package-")
          ? (JSON.parse(fs.readFileSync(path.join(args[1], "package.json"), "utf8")) as { name: string }).name.replace("@", "").replace("/", "-")
          : "paperclipai";
        if (packageName === "paperclipai-server") {
          expect(fs.readFileSync(path.join(args[1], "ui-dist", "index.html"), "utf8"))
            .toBe("<html>Built from this Git checkout</html>");
          expect(fs.readFileSync(path.join(args[1], "skills", "paperclip", "SKILL.md"), "utf8"))
            .toBe("Skill from this Git checkout\n");
          expect(fs.readFileSync(path.join(args[1], "dist", "index.js"), "utf8"))
            .toBe("export const builtServer = true;\n");
        }
        fs.writeFileSync(path.join(args[args.indexOf("--pack-destination") + 1], `${packageName}-0.3.1.tgz`), "package");
        return { stdout: "", stderr: "" };
      }
      if (file === "npm" && args[0] === "install") { const prefix = args[args.indexOf("--prefix") + 1]; const packageRoot = path.join(prefix, "node_modules", "paperclipai"); fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true }); fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.3.1" })); fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "#!/usr/bin/env node\n"); return { stdout: "", stderr: "" }; }
      if (file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs")) {
        const packageJson = JSON.parse(fs.readFileSync(path.join(args[1], "package.json"), "utf8")) as { name: string; version: string; files?: string[] };
        fs.mkdirSync(args[2], { recursive: true });
        if (packageJson.name === "@paperclipai/server") {
          // Match the real bundler's complete declared-file copy. Missing
          // runtime assets must fail before packing an incomplete payload.
          for (const entry of packageJson.files ?? []) {
            fs.cpSync(path.join(args[1], entry), path.join(args[2], entry), { recursive: true });
          }
        }
        fs.writeFileSync(path.join(args[2], "package.json"), JSON.stringify(packageJson));
        return { stdout: "", stderr: "" };
      }
      if (file === process.execPath) return { stdout: "0.3.1\n", stderr: "" };
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    });

  it("installs a GitHub branch through codeload and reuses the resolved SHA", async () => {
    const sha = "c".repeat(40);
    const runCommand = createGitCheckoutRunCommand(sha);
    await installCommand({ ref: "master", repo: "HenkDz/paperclip", yes: true }, { runCommand });
    await installCommand({ ref: "master", repo: "HenkDz/paperclip", yes: true }, { runCommand });
    const manifest = readInstallManifest(resolveInstallStorePaths());
    expect(manifest).toMatchObject({ source: "git", repo: "HenkDz/paperclip", ref: "master", sha });
    expect(manifest?.payloadPath).toContain(path.join("git", sha.slice(0, 12)));
    expect(runCommand.mock.calls.filter(([command, args]) => command === "curl" && args.includes("--output"))).toHaveLength(1);
    const pnpmInstallCalls = runCommand.mock.calls.filter(([command, args]) => command === "corepack" && args[1] === "install");
    expect(pnpmInstallCalls.map(([, args]) => args)).toEqual([
      ["pnpm", "install", "--resolution-only", "--ignore-scripts", "--no-frozen-lockfile"],
      ["pnpm", "install", "--frozen-lockfile"],
    ]);
    const checkoutPath = runCommand.mock.calls.find(([command]) => command === "tar")?.[1].at(-1);
    expect(checkoutPath).toContain(path.join("installs", "git", `.${sha.slice(0, 12)}.tmp-`));
    for (const [, , options] of pnpmInstallCalls) expect(options?.cwd).toBe(checkoutPath);
    expect(runCommand.mock.calls.indexOf(pnpmInstallCalls[1])).toBeLessThan(
      runCommand.mock.calls.findIndex(([command]) => command === "bash"),
    );
    expect(runCommand.mock.calls.filter(([command, args]) => command === "corepack" && args.includes("pack"))).toHaveLength(2);
    expect(runCommand.mock.calls.filter(([command, args]) => command === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs"))).toHaveLength(1);
    expect(runCommand.mock.calls.filter(([command, args]) => command === "npm" && args[0] === "pack")).toHaveLength(2);
    const installCall = runCommand.mock.calls.find(([command, args]) => command === "npm" && args[0] === "install");
    expect(installCall?.[1].filter((arg) => arg.endsWith(".tgz"))).toHaveLength(4);
  });

  it("cleans a failed Git checkout lockfile resolution and preserves the active install", async () => {
    const previousSha = "1".repeat(40);
    await installCommand({ ref: previousSha, yes: true }, { runCommand: createGitCheckoutRunCommand(previousSha) });
    const paths = resolveInstallStorePaths();
    const previousManifest = fs.readFileSync(paths.manifestPath, "utf8");
    const previousTarget = fs.readlinkSync(paths.currentPath);
    const previousShim = fs.readFileSync(paths.shimPath, "utf8");
    const sha = "2".repeat(40);
    const checkoutCommands = createGitCheckoutRunCommand(sha);
    let failedCheckout: string | undefined;
    const runCommand = vi.fn(async (file: string, args: string[], options?: Parameters<CommandRunner>[2]) => {
      if (file === "corepack" && args.includes("--resolution-only")) {
        failedCheckout = options?.cwd as string;
        expect(fs.existsSync(paths.lockPath)).toBe(true);
        fs.writeFileSync(path.join(failedCheckout, "pnpm-lock.yaml"), "partial failed resolution\n");
        throw new Error("dependency lockfile resolution failed");
      }
      return checkoutCommands(file, args, options);
    });

    await expect(installCommand({ ref: sha, yes: true }, { runCommand }))
      .rejects.toThrow("dependency lockfile resolution failed");

    expect(failedCheckout).toBeDefined();
    expect(fs.existsSync(path.dirname(failedCheckout!))).toBe(false);
    expect(fs.readdirSync(path.join(paths.installsRoot, "git"))).toEqual([previousSha.slice(0, 12)]);
    expect(runCommand.mock.calls.some(([, args]) => args.includes("--frozen-lockfile"))).toBe(false);
    expect(runCommand.mock.calls.some(([file]) => file === "bash" || file === "npm")).toBe(false);
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    expect(fs.readFileSync(paths.manifestPath, "utf8")).toBe(previousManifest);
    expect(fs.readlinkSync(paths.currentPath)).toBe(previousTarget);
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe(previousShim);
    expect(fs.existsSync(readInstallManifest(paths)!.payloadPath)).toBe(true);
  });

  it("builds bundled Git server UI from its checkout before staging the declared files", async () => {
    process.env.NODE_ENV = "production";
    const sha = "3".repeat(40);
    const runCommand = createGitCheckoutRunCommand(sha, { bundledServer: true });
    await expect(installGitPayload("paperclipai/paperclip", sha, runCommand, resolveInstallStorePaths()))
      .resolves.toMatchObject({ version: "0.3.1", reused: false });
    const uiCalls = runCommand.mock.calls.filter(([file, args]) => file === "corepack" && args.includes("prepare:ui-dist"));
    expect(uiCalls).toHaveLength(1);
    expect(uiCalls[0][1]).toEqual(["pnpm", "--dir", "server", "prepare:ui-dist"]);
    expect(uiCalls[0][2]?.env).not.toHaveProperty("NODE_ENV");
    const serverStage = runCommand.mock.calls.findIndex(([file, args]) =>
      file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs") && args[1]?.endsWith(path.sep + "server"));
    expect(serverStage).toBeGreaterThan(runCommand.mock.calls.indexOf(uiCalls[0]));
    expect(runCommand.mock.calls[serverStage][2]?.cwd).toBe(uiCalls[0][2]?.cwd);
  });

  it("packs the built Git stage without source-only hooks and preserves consumer install hooks", async () => {
    const sha = "9".repeat(40);
    const checkoutCommands = createGitCheckoutRunCommand(sha, { bundledServer: true });
    let packedFiles: string[] = [];
    let negativeControlPassed = false;
    const npmEnv = {
      ...process.env,
      PATH: ORIGINAL_ENV.PATH,
      npm_config_cache: path.join(root, "npm-cache"),
      npm_config_userconfig: path.join(root, ".npmrc"),
      npm_config_offline: "true",
      npm_config_ignore_scripts: "false",
    };
    fs.writeFileSync(npmEnv.npm_config_userconfig, "");
    const runCommand = vi.fn(async (file: string, args: string[], options?: Parameters<CommandRunner>[2]) => {
      if (file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs") && args[1]?.endsWith(path.sep + "server")) {
        const result = await checkoutCommands(file, args, options);
        const stagedManifest = path.join(args[2], "package.json");
        const packageJson = JSON.parse(fs.readFileSync(stagedManifest, "utf8"));
        // The real bundler preserves scripts but stages only declared runtime files.
        packageJson.scripts = {
          prepack: "node ../scripts/source-prepack.cjs",
          postpack: "node ../scripts/source-postpack.cjs",
          postinstall: "node dist/consumer-install.cjs",
        };
        packageJson.dependencies["@paperclipai/db"] = "0.3.1";
        fs.writeFileSync(stagedManifest, JSON.stringify(packageJson));
        fs.writeFileSync(path.join(args[2], "dist", "consumer-install.cjs"), "process.stdout.write('consumer hook retained');\n");
        for (const hook of ["source-prepack", "source-postpack"]) {
          fs.writeFileSync(path.join(options!.cwd as string, "scripts", `${hook}.cjs`), "process.stdout.write('source workspace hook');\n");
        }
        return result;
      }
      if (file === "npm" && args[0] === "pack" && args[1]?.includes("workspace-package-")) {
        const manifest = JSON.parse(fs.readFileSync(path.join(args[1], "package.json"), "utf8")) as { name: string };
        if (manifest.name === "@paperclipai/server") {
          const realOptions = { ...options, env: npmEnv, timeout: 20_000 };
          // Removing the lifecycle boundary must reproduce the actual staged
          // packaging failure, without any provider, build, or network access.
          await expect(runCommandWithDiagnostics("npm", [...args.filter((arg) => arg !== "--ignore-scripts"), "--json"], realOptions))
            .rejects.toThrow("source-prepack.cjs");
          negativeControlPassed = true;
          const result = await runCommandWithDiagnostics("npm", [...args, "--json"], realOptions);
          const packed = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
          packedFiles = packed[0].files.map((entry) => entry.path);
          expect(fs.existsSync(path.join(args[1], "ui-dist", "index.html"))).toBe(true);
          expect(JSON.parse(fs.readFileSync(path.join(args[1], "package.json"), "utf8")).scripts.postinstall)
            .toBe("node dist/consumer-install.cjs");
          return result;
        }
      }
      return checkoutCommands(file, args, options);
    });

    await expect(installGitPayload("paperclipai/paperclip", sha, runCommand, resolveInstallStorePaths()))
      .resolves.toMatchObject({ version: "0.3.1", reused: false });
    expect(negativeControlPassed).toBe(true);
    expect(packedFiles).toEqual(expect.arrayContaining([
      "dist/index.js", "dist/consumer-install.cjs", "ui-dist/index.html",
      "skills/paperclip/SKILL.md", "skills/paperclip/scripts/helper.mjs",
    ]));
    const consumerInstall = runCommand.mock.calls.find(([file, args]) => file === "npm" && args[0] === "install");
    expect(consumerInstall?.[1]).not.toContain("--ignore-scripts");
    expect(consumerInstall?.[2]?.env?.npm_config_ignore_scripts).toBeUndefined();
    const sourcePack = runCommand.mock.calls.find(([file, args]) => file === "npm" && args[0] === "pack" && args[1] === "--pack-destination");
    expect(sourcePack?.[1]).not.toContain("--ignore-scripts");
  });

  it("installs mixed-version Git packages offline with the dependency's own SDK version and consumer hooks", async () => {
    const sha = "f".repeat(40);
    const checkoutCommands = createGitCheckoutRunCommand(sha, { bundledServer: true });
    const { materializePublishManifest } = await import(new URL("../../../scripts/prepare-bundled-package.mjs", import.meta.url).href);
    const npmEnv = {
      ...process.env,
      PATH: ORIGINAL_ENV.PATH,
      npm_config_cache: path.join(root, "npm-cache"),
      npm_config_userconfig: path.join(root, ".npmrc"),
      npm_config_offline: "true",
      npm_config_ignore_scripts: "false",
    };
    fs.writeFileSync(npmEnv.npm_config_userconfig, "");
    let checkout: string;
    let consumerInstalled = false;
    let packedSdkReferences: Record<string, string> = {};
    const runCommand = vi.fn(async (file: string, args: string[], options?: Parameters<CommandRunner>[2]) => {
      if (file === "tar") {
        const result = await checkoutCommands(file, args, options);
        checkout = args[args.indexOf("-C") + 1];
        const sdk = path.join(checkout, "packages/plugins/sdk");
        fs.mkdirSync(path.join(sdk, "dist"), { recursive: true });
        fs.writeFileSync(path.join(sdk, "dist/index.cjs"), "module.exports.ownVersion = '1.0.0';\n");
        fs.writeFileSync(path.join(sdk, "prepare.cjs"), "require('node:fs').writeFileSync('source-pack-hook.txt', 'source hook ran');\n");
        fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({
          name: "@paperclipai/plugin-sdk", version: "1.0.0", main: "dist/index.cjs", files: ["dist"],
          dependencies: { "@paperclipai/shared": "0.3.1" }, scripts: { prepack: "node prepare.cjs" },
        }));
        const manifestPath = path.join(checkout, "scripts/release-package-manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.push({ dir: "packages/plugins/sdk", name: "@paperclipai/plugin-sdk" });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const serverManifestPath = path.join(checkout, "server/package.json");
        const serverManifest = JSON.parse(fs.readFileSync(serverManifestPath, "utf8"));
        serverManifest.dependencies["@paperclipai/plugin-sdk"] = "workspace:*";
        serverManifest.dependencies["@paperclipai/shared"] = "~0.3.0";
        serverManifest.optionalDependencies = { "@paperclipai/db": "workspace:~" };
        serverManifest.peerDependencies = { "@paperclipai/plugin-sdk": "workspace:^" };
        fs.writeFileSync(serverManifestPath, JSON.stringify(serverManifest));
        const dbManifestPath = path.join(checkout, "packages/db/package.json");
        const dbManifest = JSON.parse(fs.readFileSync(dbManifestPath, "utf8"));
        dbManifest.version = "0.2.0";
        fs.writeFileSync(dbManifestPath, JSON.stringify(dbManifest));
        fs.mkdirSync(path.join(checkout, "cli/dist"), { recursive: true });
        fs.writeFileSync(path.join(checkout, "cli/dist/index.js"), "console.log('0.3.1');\n");
        fs.writeFileSync(path.join(checkout, "cli/package.json"), JSON.stringify({
          name: "paperclipai", version: "0.3.1", files: ["dist"], dependencies: { "@paperclipai/server": "0.3.1" },
        }));
        return result;
      }
      if (file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs")) {
        const result = await checkoutCommands(file, args, options);
        const stagedManifestPath = path.join(args[2], "package.json");
        // Use the real release manifest translator, including its owning-package
        // workspace normalization. The installer must correct the Git-only case.
        const manifest = materializePublishManifest(JSON.parse(fs.readFileSync(stagedManifestPath, "utf8")));
        if (manifest.name === "@paperclipai/server") {
          manifest.scripts = {
            prepack: "node ../scripts/source-prepack-does-not-exist.cjs",
            postpack: "node ../scripts/source-postpack-does-not-exist.cjs",
            postinstall: "node dist/consumer-install.cjs",
          };
          fs.writeFileSync(path.join(args[2], "dist/consumer-install.cjs"),
            "require('node:fs').writeFileSync('consumer-hook.txt', require('@paperclipai/plugin-sdk').ownVersion);\n");
        }
        fs.writeFileSync(stagedManifestPath, JSON.stringify(manifest));
        return result;
      }
      if (file === "corepack" && args.includes("pack")) {
        const source = path.join(checkout, args[args.indexOf("--dir") + 1]);
        return runCommandWithDiagnostics("npm", ["pack", "--pack-destination", args[args.indexOf("--pack-destination") + 1], "--json"],
          { cwd: source, env: npmEnv, timeout: 20_000 });
      }
      if (file === "npm" && args[0] === "pack") {
        if (args[1]?.includes("workspace-package-")) {
          const manifest = JSON.parse(fs.readFileSync(path.join(args[1], "package.json"), "utf8"));
          if (manifest.name === "@paperclipai/server") {
            packedSdkReferences = Object.fromEntries(["dependencies", "optionalDependencies", "peerDependencies"]
              .map((section) => [section, manifest[section]["@paperclipai/plugin-sdk"]]));
          }
        }
        return runCommandWithDiagnostics(file, [...args, "--json"], { ...options, env: npmEnv, timeout: 20_000 });
      }
      if (file === "npm" && args[0] === "install") {
        expect(args).not.toContain("--ignore-scripts");
        expect(args.filter((arg) => arg.endsWith(".tgz"))).toHaveLength(5);
        expect(args.some((arg) => arg.endsWith("paperclipai-plugin-sdk-1.0.0.tgz"))).toBe(true);
        expect(fs.readFileSync(path.join(checkout, "packages/plugins/sdk/source-pack-hook.txt"), "utf8")).toBe("source hook ran");
        const sourceManifest = JSON.parse(fs.readFileSync(path.join(checkout, "server/package.json"), "utf8"));
        expect(sourceManifest.dependencies["@paperclipai/plugin-sdk"]).toBe("workspace:*");
        expect(sourceManifest.optionalDependencies["@paperclipai/db"]).toBe("workspace:~");
        expect(sourceManifest.peerDependencies["@paperclipai/plugin-sdk"]).toBe("workspace:^");
        let result;
        try {
          result = await runCommandWithDiagnostics(file, args, { ...options, env: npmEnv, timeout: 20_000 });
        } catch (error) {
          throw new Error(`Offline consumer failed with SDK 1.0.0 archive and packed SDK references ${JSON.stringify(packedSdkReferences)}: ${String(error)}`, { cause: error });
        }
        const installedServer = path.join(args[args.indexOf("--prefix") + 1], "node_modules/@paperclipai/server");
        const installed = JSON.parse(fs.readFileSync(path.join(installedServer, "package.json"), "utf8"));
        expect(installed.dependencies["@paperclipai/plugin-sdk"]).toBe("1.0.0");
        expect(installed.dependencies["@paperclipai/shared"]).toBe("~0.3.0");
        expect(installed.dependencies["@paperclipai/db"]).toBe("0.2.0");
        expect(installed.optionalDependencies["@paperclipai/db"]).toBe("~0.2.0");
        expect(installed.peerDependencies["@paperclipai/plugin-sdk"]).toBe("^1.0.0");
        expect(fs.readFileSync(path.join(installedServer, "consumer-hook.txt"), "utf8")).toBe("1.0.0");
        consumerInstalled = true;
        return result;
      }
      if (file === process.execPath && args.at(-1) === "--version") {
        return runCommandWithDiagnostics(file, args, { ...options, env: npmEnv, timeout: 20_000 });
      }
      return checkoutCommands(file, args, options);
    });

    await expect(installGitPayload("paperclipai/paperclip", sha, runCommand, resolveInstallStorePaths()))
      .resolves.toMatchObject({ version: "0.3.1", reused: false });
    expect(consumerInstalled).toBe(true);
  }, 30_000);

  it.each(["source build", "staged pack", "consumer install"])("preserves the active Git install after a failed %s", async (phase) => {
    const previousSha = "a".repeat(40);
    await installCommand({ ref: previousSha, yes: true }, { runCommand: createGitCheckoutRunCommand(previousSha) });
    const paths = resolveInstallStorePaths();
    const previousManifest = fs.readFileSync(paths.manifestPath, "utf8");
    const previousTarget = fs.readlinkSync(paths.currentPath);
    const previousShim = fs.readFileSync(paths.shimPath, "utf8");
    const sha = "e".repeat(40);
    const checkoutCommands = createGitCheckoutRunCommand(sha, { bundledServer: true });
    let failedCheckout: string | undefined;
    const runCommand = vi.fn(async (file: string, args: string[], options?: Parameters<CommandRunner>[2]) => {
      if (file === "tar") failedCheckout = args[args.indexOf("-C") + 1];
      const failedPhase = phase === "source build"
        ? file === "corepack" && args.includes("-r") && args.includes("build")
        : phase === "staged pack"
          ? file === "npm" && args[0] === "pack" && args[1]?.includes("workspace-package-")
          : file === "npm" && args[0] === "install";
      if (failedPhase) throw new Error(`${phase} failed`);
      return checkoutCommands(file, args, options);
    });

    await expect(installCommand({ ref: sha, yes: true }, { runCommand })).rejects.toThrow(`${phase} failed`);
    expect(failedCheckout).toBeDefined();
    expect(fs.existsSync(path.dirname(failedCheckout!))).toBe(false);
    expect(fs.readdirSync(path.join(paths.installsRoot, "git"))).toEqual([previousSha.slice(0, 12)]);
    if (phase === "source build") expect(runCommand.mock.calls.some(([file]) => file === "npm")).toBe(false);
    if (phase === "staged pack") expect(runCommand.mock.calls.some(([file, args]) => file === "npm" && args[0] === "install")).toBe(false);
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    expect(fs.readFileSync(paths.manifestPath, "utf8")).toBe(previousManifest);
    expect(fs.readlinkSync(paths.currentPath)).toBe(previousTarget);
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe(previousShim);
    expect(fs.existsSync(readInstallManifest(paths)!.payloadPath)).toBe(true);
  });

  it("stages same-checkout runtime skills in the release packages before bundled Git packaging", async () => {
    const sha = "6".repeat(40);
    const checkoutCommands = createGitCheckoutRunCommand(sha, { bundledServer: true });
    let checkedSkills = false;
    const runCommand = vi.fn(async (file: string, args: string[], options?: Parameters<CommandRunner>[2]) => {
      if (file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs")) {
        const checkout = options!.cwd as string;
        for (const packageDir of ["server", "packages/adapters/claude-local", "packages/adapters/codex-local"]) {
          const skills = path.join(checkout, packageDir, "skills");
          expect(fs.readdirSync(skills)).toEqual(["paperclip"]);
          for (const file of ["SKILL.md", "scripts/helper.mjs"]) {
            expect(fs.readFileSync(path.join(skills, "paperclip", file), "utf8"))
              .toBe(fs.readFileSync(path.join(checkout, "skills", "paperclip", file), "utf8"));
          }
        }
        // Other adapters' optional skills keep their established pack behavior.
        expect(fs.existsSync(path.join(checkout, "packages/adapters/cursor-local/skills"))).toBe(false);
        checkedSkills = true;
      }
      return checkoutCommands(file, args, options);
    });

    await expect(installGitPayload("paperclipai/paperclip", sha, runCommand, resolveInstallStorePaths()))
      .resolves.toMatchObject({ version: "0.3.1", reused: false });
    expect(checkedSkills).toBe(true);
  });

  it("cleans missing Git runtime skills and preserves the active installed payload", async () => {
    const previousSha = "7".repeat(40);
    await installCommand({ ref: previousSha, yes: true }, { runCommand: createGitCheckoutRunCommand(previousSha) });
    const paths = resolveInstallStorePaths();
    const previousManifest = fs.readFileSync(paths.manifestPath, "utf8");
    const previousTarget = fs.readlinkSync(paths.currentPath);
    const previousShim = fs.readFileSync(paths.shimPath, "utf8");
    const sha = "8".repeat(40);
    const checkoutCommands = createGitCheckoutRunCommand(sha, { bundledServer: true });
    let failedCheckout: string | undefined;
    const runCommand = vi.fn(async (file: string, args: string[], options?: Parameters<CommandRunner>[2]) => {
      const result = await checkoutCommands(file, args, options);
      if (file === "tar") {
        failedCheckout = args[args.indexOf("-C") + 1];
        fs.rmSync(path.join(failedCheckout, "skills"), { recursive: true });
      }
      return result;
    });

    await expect(installCommand({ ref: sha, yes: true }, { runCommand }))
      .rejects.toThrow(/ENOENT.*skills/);
    expect(failedCheckout).toBeDefined();
    expect(fs.existsSync(path.dirname(failedCheckout!))).toBe(false);
    expect(fs.readdirSync(path.join(paths.installsRoot, "git"))).toEqual([previousSha.slice(0, 12)]);
    expect(runCommand.mock.calls.some(([file, args]) => file === "npm" || (file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs")))).toBe(false);
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    expect(fs.readFileSync(paths.manifestPath, "utf8")).toBe(previousManifest);
    expect(fs.readlinkSync(paths.currentPath)).toBe(previousTarget);
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe(previousShim);
    expect(fs.existsSync(readInstallManifest(paths)!.payloadPath)).toBe(true);
  });

  it("cleans a failed Git UI build and preserves the active installed payload", async () => {
    const previousSha = "4".repeat(40);
    await installCommand({ ref: previousSha, yes: true }, { runCommand: createGitCheckoutRunCommand(previousSha) });
    const paths = resolveInstallStorePaths();
    const previousManifest = fs.readFileSync(paths.manifestPath, "utf8");
    const previousTarget = fs.readlinkSync(paths.currentPath);
    const previousShim = fs.readFileSync(paths.shimPath, "utf8");
    const sha = "5".repeat(40);
    const checkoutCommands = createGitCheckoutRunCommand(sha, { bundledServer: true });
    let failedCheckout: string | undefined;
    const runCommand = vi.fn(async (file: string, args: string[], options?: Parameters<CommandRunner>[2]) => {
      if (file === "corepack" && args.includes("prepare:ui-dist")) {
        failedCheckout = options?.cwd as string;
        throw new Error("UI build failed");
      }
      return checkoutCommands(file, args, options);
    });
    await expect(installCommand({ ref: sha, yes: true }, { runCommand })).rejects.toThrow("UI build failed");
    expect(failedCheckout).toBeDefined();
    expect(fs.existsSync(path.dirname(failedCheckout!))).toBe(false);
    expect(fs.readdirSync(path.join(paths.installsRoot, "git"))).toEqual([previousSha.slice(0, 12)]);
    expect(runCommand.mock.calls.some(([file]) => file === "npm")).toBe(false);
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    expect(fs.readFileSync(paths.manifestPath, "utf8")).toBe(previousManifest);
    expect(fs.readlinkSync(paths.currentPath)).toBe(previousTarget);
    expect(fs.readFileSync(paths.shimPath, "utf8")).toBe(previousShim);
    expect(fs.existsSync(readInstallManifest(paths)!.payloadPath)).toBe(true);
  });

  it("builds git checkouts with NODE_ENV cleared so ambient production mode keeps devDependencies", async () => {
    process.env.NODE_ENV = "production";
    const sha = "d".repeat(40);
    const runCommand = createGitCheckoutRunCommand(sha);
    await expect(installGitPayload("paperclipai/paperclip", sha, runCommand, resolveInstallStorePaths())).resolves.toMatchObject({ version: "0.3.1", reused: false });
    const buildCalls = runCommand.mock.calls.filter(([file, args]) =>
      file === "bash" ||
      file === "corepack" ||
      (file === "npm" && args[0] === "pack") ||
      (file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs")));
    expect(buildCalls).toHaveLength(11);
    for (const call of buildCalls) {
      const env = call[2]?.env;
      expect(env, `${call[0]} ${call[1].join(" ")} must run with an explicit env`).toBeDefined();
      expect(env, `${call[0]} ${call[1].join(" ")} must not inherit NODE_ENV`).not.toHaveProperty("NODE_ENV");
    }
    const uiPackCall = buildCalls.find(([file, , options]) => file === "corepack" && options?.env?.PAPERCLIP_RELEASE_REUSE_UI_DIST === "1");
    expect(uiPackCall).toBeDefined();
  });

  it("resolves the complete server workspace dependency closure in dependency order", () => {
    const checkout = path.join(root, "checkout");
    const packages = [
      { dir: "packages/shared", name: "@paperclipai/shared", dependencies: {} },
      { dir: "packages/db", name: "@paperclipai/db", dependencies: { "@paperclipai/shared": "workspace:*" } },
      { dir: "server", name: "@paperclipai/server", dependencies: { "@paperclipai/db": "workspace:*" } },
    ];
    fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "scripts", "release-package-manifest.json"), JSON.stringify(packages.map(({ dir, name }) => ({ dir, name }))));
    for (const workspacePackage of packages) {
      fs.mkdirSync(path.join(checkout, workspacePackage.dir), { recursive: true });
      fs.writeFileSync(path.join(checkout, workspacePackage.dir, "package.json"), JSON.stringify({ name: workspacePackage.name, dependencies: workspacePackage.dependencies }));
    }

    expect(resolveGitInstallWorkspacePackages(checkout).map(({ name }) => name)).toEqual([
      "@paperclipai/shared",
      "@paperclipai/db",
      "@paperclipai/server",
    ]);
  });

  it("includes child-process stderr in command failures", async () => {
    await expect(runCommandWithDiagnostics(process.execPath, ["-e", "process.stderr.write('unsupported workspace dependency\\n'); process.exit(1)"]))
      .rejects.toThrow("unsupported workspace dependency");
  });

  it("installs through the shim, reports provenance, and uninstalls without deleting user data", async () => {
    const version = "2026.720.0";
    const runCommand = vi.fn(async (file: string, args: string[], _options?: unknown) => {
      if (file === "npm" && args[0] === "view") return { stdout: JSON.stringify(version), stderr: "" };
      if (file === "npm" && args[0] === "install") {
        const prefix = args[args.indexOf("--prefix") + 1];
        const entrypoint = path.join(prefix, "node_modules", "paperclipai", "dist", "index.js");
        fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
        fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
        return { stdout: "", stderr: "" };
      }
      if (file === process.execPath && args.at(-1) === "--version") {
        return { stdout: `${version}\n`, stderr: "" };
      }
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    });

    await installCommand({}, { runCommand, now: () => new Date("2026-07-22T18:00:00.000Z") });

    const paths = resolveInstallStorePaths();
    const manifest = readInstallManifest(paths);
    expect(manifest?.version).toBe(version);
    expect(manifest?.channel).toBe("latest");
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(manifest!.payloadPath));
    expect(fs.existsSync(paths.shimPath)).toBe(true);
    const installCall = runCommand.mock.calls.find(
      ([file, args]) => file === "npm" && args[0] === "install",
    );
    expect(installCall?.[1]).toContain("--@paperclipai:registry=https://registry.npmjs.org");
    const installOptions = installCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(installOptions?.env?.npm_config_userconfig).toContain(".npmrc-");
    const entrypoint = path.join(manifest!.payloadPath, "node_modules", "paperclipai", "dist", "index.js");
    expect(resolveCliVersion(entrypoint)).toContain(`managed npm latest; payload ${manifest!.payloadPath}`);

    const userData = path.join(process.env.PAPERCLIP_HOME!, "instances", "default", "keep.txt");
    fs.mkdirSync(path.dirname(userData), { recursive: true });
    fs.writeFileSync(userData, "keep");
    const uninstallService = vi.fn(async () => {
      expect(fs.existsSync(paths.shimPath)).toBe(true);
    });
    await uninstallCommand({
      detectServiceManager: vi.fn(async () => ({
        supported: true as const,
        manager: {
          status: vi.fn(async () => ({ installed: true, active: true })),
          uninstall: uninstallService,
        } as never,
      })),
    });

    expect(uninstallService).toHaveBeenCalledOnce();
    expect(fs.existsSync(paths.cliRoot)).toBe(false);
    expect(fs.existsSync(paths.shimPath)).toBe(false);
    expect(fs.readFileSync(userData, "utf8")).toBe("keep");
  });

  it("refuses to remove the shared CLI while another instance service is installed", async () => {
    const paths = resolveInstallStorePaths();
    const otherUnitPath = path.join(process.env.HOME!, ".config", "systemd", "user", systemdServiceName("team-a"));
    fs.mkdirSync(path.dirname(otherUnitPath), { recursive: true });
    fs.writeFileSync(otherUnitPath, "unit");

    await expect(uninstallCommand({
      detectServiceManager: vi.fn(async () => ({
        supported: true as const,
        manager: { status: vi.fn(async () => ({ installed: false, active: false })) } as never,
      })),
      platform: "linux",
      userHomeDir: process.env.HOME!,
    })).rejects.toThrow("other instance services are installed");

    expect(fs.existsSync(paths.cliRoot)).toBe(false);
    expect(fs.existsSync(otherUnitPath)).toBe(true);
  });

  it("preserves the managed install when an existing systemd unit cannot be checked", async () => {
    const paths = resolveInstallStorePaths();
    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, "managed shim");
    const unitPath = path.join(
      process.env.HOME!,
      ".config",
      "systemd",
      "user",
      systemdServiceName(resolvePaperclipInstanceId()),
    );
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, "unit");

    await expect(uninstallCommand({
      detectServiceManager: vi.fn(async () => ({
        supported: false as const,
        reason: "No usable systemd user manager was detected",
      })),
      platform: "linux",
      userHomeDir: process.env.HOME!,
    })).rejects.toThrow("Cannot verify or remove the background service");

    expect(fs.existsSync(paths.shimPath)).toBe(true);
    expect(fs.existsSync(unitPath)).toBe(true);
  });

  it("rejects a symlinked installs root before npm writes outside the store", async () => {
    const paths = resolveInstallStorePaths();
    const outside = path.join(root, "outside");
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, paths.installsRoot, "dir");
    const runCommand = vi.fn(async () => ({ stdout: JSON.stringify("2026.720.0"), stderr: "" }));

    await expect(installCommand({}, { runCommand })).rejects.toThrow("non-directory install-store path");
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses to uninstall an unverified cli directory", async () => {
    const paths = resolveInstallStorePaths();
    const unrelatedFile = path.join(paths.cliRoot, "keep.txt");
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.writeFileSync(unrelatedFile, "keep");

    await expect(uninstallCommand()).rejects.toThrow("unverified install store");
    expect(fs.readFileSync(unrelatedFile, "utf8")).toBe("keep");
  });

  it("refuses to uninstall while another store mutation holds the lock", async () => {
    const paths = resolveInstallStorePaths();
    const payloadPath = payloadPathFor(paths, "npm", "2026.720.0");
    initializeInstallStore(paths);
    fs.mkdirSync(payloadPath, { recursive: true });
    flipCurrentAtomic(payloadPath, paths);
    writeInstallManifestAtomic({
      schemaVersion: INSTALL_MANIFEST_VERSION,
      source: "npm",
      version: "2026.720.0",
      channel: "latest",
      payloadPath,
      installedAt: "2026-07-22T18:00:00.000Z",
      previous: [],
    }, paths);

    await withInstallStoreLock(
      async () => {
        await expect(uninstallCommand()).rejects.toThrow("already running");
      },
      paths,
    );
    expect(fs.existsSync(paths.lockPath)).toBe(false);
  });

  it("refuses a symlinked git payload root before downloading", async () => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const outside = path.join(root, "outside-git"); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(paths.installsRoot, "git"));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(installGitPayload("paperclipai/paperclip", "4".repeat(40), runCommand, paths)).rejects.toThrow("unsafe payload root");
    expect(runCommand).not.toHaveBeenCalled();
  });

});
