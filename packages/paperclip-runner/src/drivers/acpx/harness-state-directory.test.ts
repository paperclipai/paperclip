import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { confirmAntigravityProbeNativeRetirement } from "./antigravity-probe-retirement.js";
import { acquireAcpxProviderLifetimeLease } from "./codex-credentials.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { acpxRuntimeSessionDirectoryName, createAcpxRecoveryBinding } from "./recovery-identity.js";
import { prepareAcpxRuntimeSandbox } from "./runtime-sandbox.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-harness-state-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  const runtimeDirectory = join(root, "runtime");
  const harnessStateDirectory = join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(runtimeDirectory), mkdir(harnessStateDirectory)]);
  const bind = (session: string, state?: string) => createAcpxRecoveryBinding({
    runtimeDirectory,
    ...(state === undefined ? {} : { harnessStateDirectory: state }),
    normalizedSessionId: session,
    workingDirectory: workspace,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
    requestedModel: "claude-sonnet-5",
    permissionMode: "approve-reads",
  });
  return { root, workspace, runtimeDirectory, harnessStateDirectory, bind };
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("ACPX harness state directory", () => {
  it("keeps the whole session tree in the runtime root when unset", async () => {
    const { runtimeDirectory, harnessStateDirectory, bind } = await fixture();
    const binding = await bind("default-session");
    expect(binding).not.toHaveProperty("harnessStateRoot");
    const root = join(runtimeDirectory, "acpx", acpxRuntimeSessionDirectoryName("default-session"));
    const sandbox = await prepareAcpxRuntimeSandbox({ binding, agent: "claude" });
    expect(sandbox).toMatchObject({
      root,
      stateDirectory: join(root, "acpx-state"),
      homeDirectory: join(root, "home"),
      configDirectory: join(root, "config"),
      dataDirectory: join(root, "data"),
      cacheDirectory: join(root, "cache"),
      agentHomeDirectory: join(root, "claude-home"),
      workspaceRecordPath: join(root, "workspace"),
    });
    expect(sandbox).not.toHaveProperty("harnessStateRoot");
    expect(sandbox.protectedPaths).toEqual([runtimeDirectory]);
    await expect(stat(join(harnessStateDirectory, "acpx"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps session records, data and the agent home in the harness state directory", async () => {
    const { runtimeDirectory, harnessStateDirectory, bind } = await fixture();
    const name = acpxRuntimeSessionDirectoryName("state-session");
    const root = join(runtimeDirectory, "acpx", name);
    const stateRoot = join(harnessStateDirectory, "acpx", name);
    const binding = await bind("state-session", harnessStateDirectory);
    expect(binding).toMatchObject({ runtimeRoot: root, harnessStateRoot: stateRoot });
    const sandbox = await prepareAcpxRuntimeSandbox({ binding, agent: "claude" });
    expect(sandbox).toMatchObject({
      root,
      harnessStateRoot: stateRoot,
      stateDirectory: join(stateRoot, "acpx-state"),
      dataDirectory: join(stateRoot, "data"),
      agentHomeDirectory: join(stateRoot, "claude-home"),
      homeDirectory: join(root, "home"),
      configDirectory: join(root, "config"),
      cacheDirectory: join(root, "cache"),
      workspaceRecordPath: join(root, "workspace"),
    });
    expect(sandbox.launchEnvironment).toMatchObject({
      CLAUDE_CONFIG_DIR: join(stateRoot, "claude-home"),
      XDG_DATA_HOME: join(stateRoot, "data"),
      HOME: join(root, "home"),
    });
    expect(sandbox.protectedPaths).toEqual([runtimeDirectory, harnessStateDirectory]);
    for (const path of [join(harnessStateDirectory, "acpx"), stateRoot, sandbox.stateDirectory, sandbox.agentHomeDirectory]) {
      expect(await mode(path)).toBe(0o700);
    }
    for (const moved of ["acpx-state", "data", "claude-home"]) {
      await expect(stat(join(root, moved))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reopens a session from the state it left in the harness state directory", async () => {
    const { runtimeDirectory, harnessStateDirectory, bind } = await fixture();
    const first = await prepareAcpxRuntimeSandbox({ binding: await bind("resumed", harnessStateDirectory), agent: "claude" });
    await mkdir(join(first.stateDirectory, "sessions"));
    await writeFile(join(first.stateDirectory, "sessions", "record.json"), "{}\n");
    await writeFile(join(first.agentHomeDirectory, "history.jsonl"), "turn\n");
    await rm(join(runtimeDirectory, "acpx"), { recursive: true });

    const reopened = await prepareAcpxRuntimeSandbox({ binding: await bind("resumed", harnessStateDirectory), agent: "claude" });
    expect(reopened.stateDirectory).toBe(first.stateDirectory);
    expect(await readFile(join(reopened.stateDirectory, "sessions", "record.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(reopened.agentHomeDirectory, "history.jsonl"), "utf8")).toBe("turn\n");
    expect(await mode(reopened.root)).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("confirms Antigravity probe retirement against the home in the harness state directory", async () => {
    const { runtimeDirectory, harnessStateDirectory } = await fixture();
    const home = join(harnessStateDirectory, "acpx", acpxRuntimeSessionDirectoryName("probe"), "antigravity-home", "antigravity-acp");
    await mkdir(home, { recursive: true, mode: 0o700 });
    const lease = await acquireAcpxProviderLifetimeLease({ agentHomeDirectory: home });
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
      detached: true, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore", ...lease.lifetimeFenceFds],
    });
    const closed = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); });
      await lease.close();
      let retired = false;
      const retirement = confirmAntigravityProbeNativeRetirement(runtimeDirectory, "probe", harnessStateDirectory)
        .then(() => { retired = true; });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(retired).toBe(false);
      child.kill("SIGKILL");
      await closed;
      await retirement;
      expect(retired).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await closed;
      await lease.close();
    }
  }, 10_000);

  it("refuses a relative, non-normalized, missing or root directory", async () => {
    const { harnessStateDirectory, bind } = await fixture();
    for (const value of ["state", "", `${harnessStateDirectory}/`, `${harnessStateDirectory}/../state`]) {
      await expect(bind("invalid", value)).rejects.toThrow("absolute normalized path");
    }
    await expect(bind("invalid", join(harnessStateDirectory, "missing"))).rejects.toThrow("unavailable");
    await expect(bind("invalid", "/")).rejects.toThrow("filesystem root");
  });

  it.skipIf(process.platform === "win32")("refuses a symbolic link on the path and a link inside it", async () => {
    const { root, harnessStateDirectory, bind } = await fixture();
    await symlink(harnessStateDirectory, join(root, "linked"));
    await expect(bind("linked", join(root, "linked"))).rejects.toThrow("physical path");
    await mkdir(join(harnessStateDirectory, "nested"));
    await expect(bind("ancestor", join(root, "linked", "nested"))).rejects.toThrow("physical path");

    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(harnessStateDirectory, "acpx"));
    const binding = await bind("namespace", harnessStateDirectory);
    await expect(prepareAcpxRuntimeSandbox({ binding, agent: "claude" })).rejects.toThrow(/real directory|escaped/);
  });

  it("refuses a harness state directory that overlaps the workspace", async () => {
    const { workspace, root, bind } = await fixture();
    for (const value of [workspace, root]) {
      const binding = await bind("overlap", value);
      await expect(prepareAcpxRuntimeSandbox({ binding, agent: "claude" })).rejects.toThrow("overlap");
    }
  });
});
