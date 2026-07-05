import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareManagedCodexHome, resolveManagedCodexHomeDir } from "./codex-home.js";

/**
 * Seeding symlinks auth.json; on hosts without symlink privilege (Windows
 * without Developer Mode) `fs.symlink` throws EPERM. Detect capability so the
 * seeding assertions run on POSIX/CI and are skipped (not failed) elsewhere.
 */
async function symlinkSupported(): Promise<boolean> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-symlink-probe-"));
  try {
    await fs.symlink(dir, path.join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("resolveManagedCodexHomeDir", () => {
  const base = { PAPERCLIP_HOME: "/srv/pc", PAPERCLIP_INSTANCE_ID: "inst" } as NodeJS.ProcessEnv;

  it("returns a per-agent home when agentId is set", () => {
    const home = resolveManagedCodexHomeDir(base, "company-1", "agent-1");
    expect(home).toBe(
      path.resolve("/srv/pc", "instances", "inst", "companies", "company-1", "agents", "agent-1", "codex-home"),
    );
  });

  it("returns the company-level home when agentId is omitted", () => {
    const home = resolveManagedCodexHomeDir(base, "company-1");
    expect(home).toBe(path.resolve("/srv/pc", "instances", "inst", "companies", "company-1", "codex-home"));
  });
});

describe("prepareManagedCodexHome with a stable per-agent home (Fix 5)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("seeds a per-agent home (auth.json symlink + copied config) for a no-MCP agent", async ({ skip }) => {
    if (!(await symlinkSupported())) {
      // Seeding symlinks auth.json — unavailable on this host (no symlink priv).
      skip();
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-seed-"));
    cleanupDirs.push(root);
    // Shared source home the per-agent home should be seeded from.
    const sharedHome = path.join(root, "shared-codex");
    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(path.join(sharedHome, "auth.json"), JSON.stringify({ tokens: "x" }), "utf8");
    await fs.writeFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const env = {
      CODEX_HOME: sharedHome,
      PAPERCLIP_HOME: path.join(root, "pc-home"),
      PAPERCLIP_INSTANCE_ID: "inst",
    } as NodeJS.ProcessEnv;

    // agentId always set (Fix 5) even though this agent has no MCP servers.
    const home = await prepareManagedCodexHome(env, async () => {}, "company-1", { agentId: "agent-1" });
    expect(home).toBe(resolveManagedCodexHomeDir(env, "company-1", "agent-1"));

    // auth.json is symlinked back to the shared source (refreshed auth propagates).
    const authStat = await fs.lstat(path.join(home, "auth.json"));
    expect(authStat.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(home, "auth.json"))).toBe(path.join(sharedHome, "auth.json"));

    // config.toml is copied (independent per-agent file).
    const copiedConfigStat = await fs.lstat(path.join(home, "config.toml"));
    expect(copiedConfigStat.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe('model = "gpt-5.4"\n');
  });
});
