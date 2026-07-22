import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flipCurrentAtomic, initializeInstallStore, payloadPathFor, readInstallManifest, resolveInstallStorePaths, writeInstallManifestAtomic, type InstallManifest, type InstallRecord } from "../install-store.js";
import type { CommandRunner } from "../commands/install.js";
import { detectInstallMode, resolveUpdateRequest, rollbackManagedInstall, updateCommand } from "../commands/update.js";

let root: string;
let previousHome: string | undefined;
let previousPaperclipHome: string | undefined;

function record(payloadPath: string, version: string, channel: "latest" | "canary" | "pinned" = "latest"): InstallRecord {
  return { source: "npm", version, channel, payloadPath, installedAt: `2026-07-22T00:00:0${version}.000Z` };
}
function createPayload(payloadPath: string, version: string): string {
  const entrypoint = path.join(payloadPath, "node_modules", "paperclipai", "dist", "index.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, version);
  return entrypoint;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-update-"));
  previousHome = process.env.HOME;
  previousPaperclipHome = process.env.PAPERCLIP_HOME;
  process.env.HOME = path.join(root, "home");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip");
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousPaperclipHome;
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("update command", () => {
  it("detects managed, global npm, npx, and source modes", () => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const payload = payloadPathFor(paths, "npm", "1.0.0"); const entrypoint = createPayload(payload, "1.0.0");
    flipCurrentAtomic(payload, paths);
    writeInstallManifestAtomic({ schemaVersion: 1, ...record(payload, "1.0.0"), previous: [] }, paths);
    expect(detectInstallMode(entrypoint, paths)).toBe("managed");
    expect(detectInstallMode(path.join(root, "lib", "node_modules", "paperclipai", "dist", "index.js"), paths)).toBe("global-npm");
    expect(detectInstallMode(path.join(root, ".npm", "_npx", "abc", "node_modules", "paperclipai", "dist", "index.js"), paths)).toBe("npx");
    const source = path.join(root, "source"); fs.mkdirSync(path.join(source, ".git"), { recursive: true });
    expect(detectInstallMode(path.join(source, "cli", "src", "index.ts"), paths)).toBe("source");
  });

  it("resolves channels and keeps pinned installs pinned by default", () => {
    const manifest = { channel: "pinned", version: "1.2.3" } as InstallManifest;
    expect(resolveUpdateRequest(manifest, {})).toEqual({ spec: "1.2.3", channel: "pinned", explicit: false });
    expect(resolveUpdateRequest(manifest, { latest: true })).toEqual({ spec: "latest", channel: "latest", explicit: true });
    expect(() => resolveUpdateRequest(manifest, { latest: true, canary: true })).toThrow("only one");
  });

  it("re-resolves a moving git branch and activates the new SHA payload", async () => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const oldSha = "1".repeat(40); const newSha = "2".repeat(40);
    const oldPayload = payloadPathFor(paths, "git", oldSha.slice(0, 12));
    const executable = createPayload(oldPayload, "0.3.1");
    fs.writeFileSync(path.join(oldPayload, "node_modules", "paperclipai", "package.json"), JSON.stringify({ version: "0.3.1" }));
    const newPayload = payloadPathFor(paths, "git", newSha.slice(0, 12));
    createPayload(newPayload, "0.3.1");
    fs.writeFileSync(path.join(newPayload, "node_modules", "paperclipai", "package.json"), JSON.stringify({ version: "0.3.1" }));
    flipCurrentAtomic(oldPayload, paths);
    writeInstallManifestAtomic({ schemaVersion: 1, source: "git", version: "0.3.1", channel: "pinned", repo: "paperclipai/paperclip", ref: "master", sha: oldSha, payloadPath: oldPayload, installedAt: "2026-07-22T00:00:00.000Z", previous: [] }, paths);
    const backup = vi.fn(async () => undefined);
    const runCommand = vi.fn(async (file: string) => file === "curl" ? { stdout: JSON.stringify({ sha: newSha }), stderr: "" } : { stdout: "0.3.1\n", stderr: "" });
    await updateCommand({}, { paths, executablePath: executable, runCommand, backup, now: () => new Date("2026-07-22T12:00:00Z") });
    expect(backup).toHaveBeenCalledOnce();
    expect(readInstallManifest(paths)?.sha).toBe(newSha);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(newPayload));
  });

  it("reports SHA git installs as pinned without resolving again", async () => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const sha = "3".repeat(40); const payload = payloadPathFor(paths, "git", sha.slice(0, 12)); const executable = createPayload(payload, "0.3.1");
    flipCurrentAtomic(payload, paths);
    writeInstallManifestAtomic({ schemaVersion: 1, source: "git", version: "0.3.1", channel: "pinned", repo: "paperclipai/paperclip", ref: sha.slice(0, 12), sha, payloadPath: payload, installedAt: "2026-07-22T00:00:00.000Z", previous: [] }, paths);
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await updateCommand({}, { paths, executablePath: executable, runCommand });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before downgrading", async () => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const payload = payloadPathFor(paths, "npm", "2.0.0"); const entrypoint = createPayload(payload, "2.0.0"); flipCurrentAtomic(payload, paths);
    writeInstallManifestAtomic({ schemaVersion: 1, ...record(payload, "2.0.0"), previous: [] }, paths);
    const runCommand = vi.fn(async () => ({ stdout: '"1.0.0"\n', stderr: "" }));
    await expect(updateCommand({ version: "1.0.0", dryRun: true }, { paths, executablePath: entrypoint, runCommand, confirm: async () => false })).rejects.toThrow("Downgrade cancelled");
  });

  it("isolates global npm updates from hostile registry configuration", async () => {
    const paths = resolveInstallStorePaths();
    const executable = path.join(root, "lib", "node_modules", "paperclipai", "dist", "index.js");
    vi.stubEnv("NPM_CONFIG_REGISTRY", "http://attacker-registry.invalid");
    fs.mkdirSync(process.env.HOME!, { recursive: true });
    fs.writeFileSync(path.join(process.env.HOME!, ".npmrc"), "registry=http://attacker-registry.invalid\n");
    const runCommand = vi.fn<CommandRunner>(async (_file, args, commandOptions) => {
      if (args[0] === "view") return { stdout: '"2.0.0"\n', stderr: "" };
      expect(args).toContain("--registry=https://registry.npmjs.org");
      expect(args).toContain("--@paperclipai:registry=https://registry.npmjs.org");
      expect(commandOptions?.env?.NPM_CONFIG_REGISTRY).toBe("https://registry.npmjs.org");
      expect(commandOptions?.env?.npm_config_registry).toBe("https://registry.npmjs.org");
      expect(commandOptions?.env?.NPM_CONFIG_USERCONFIG).toBe(commandOptions?.env?.npm_config_userconfig);
      expect(fs.readFileSync(commandOptions!.env!.NPM_CONFIG_USERCONFIG!, "utf8")).toContain("registry=https://registry.npmjs.org");
      return { stdout: "", stderr: "" };
    });
    await updateCommand({}, { paths, executablePath: executable, runCommand });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("backs up, installs side-by-side, flips, and rolls back instantly", async () => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const oldPayload = payloadPathFor(paths, "npm", "1.0.0"); const executable = createPayload(oldPayload, "1.0.0"); flipCurrentAtomic(oldPayload, paths);
    writeInstallManifestAtomic({ schemaVersion: 1, ...record(oldPayload, "1.0.0"), previous: [] }, paths);
    const backup = vi.fn(async () => undefined);
    const runCommand = vi.fn(async (file: string, args: string[]) => {
      if (args[0] === "view") return { stdout: '"2.0.0"\n', stderr: "" };
      if (file === "npm" && args[0] === "install") { const prefix = args[args.indexOf("--prefix") + 1]; createPayload(prefix, "2.0.0"); return { stdout: "", stderr: "" }; }
      return { stdout: "2.0.0\n", stderr: "" };
    });
    await updateCommand({}, { paths, executablePath: executable, runCommand, backup, now: () => new Date("2026-07-22T12:00:00Z") });
    expect(backup).toHaveBeenCalledOnce();
    expect(readInstallManifest(paths)?.version).toBe("2.0.0");
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(payloadPathFor(paths, "npm", "2.0.0")));
    const rolledBack = rollbackManagedInstall(paths);
    expect(rolledBack.version).toBe("1.0.0");
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(oldPayload));
  });
});
