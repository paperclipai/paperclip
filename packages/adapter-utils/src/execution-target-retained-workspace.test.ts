import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAdapterExecutionTargetRuntime, type AdapterSandboxExecutionTarget } from "./execution-target.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); vi.unstubAllEnvs(); });

function filesystemRunner(): CommandManagedRuntimeRunner {
  return { execute: async (input) => new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const child = spawn(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, timedOut: false, stdout, stderr, startedAt, pid: child.pid ?? null }));
    child.stdin.on("error", reject);
    child.stdin.end(input.stdin);
  }) };
}

async function workspaceFixture(adapterKey = "codex") {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-retained-workspace-"));
  roots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "retained-workspace-test");
  const local = path.join(root, "host"), remote = path.join(root, "sandbox");
  await mkdir(local); await mkdir(remote);
  await writeFile(path.join(local, "app.txt"), "initial source");
  const recordWorkspaceSync = vi.fn(async (_baseline: { sha256: string; exclude: string[] }) => {});
  const runner = filesystemRunner();
  const execute = vi.spyOn(runner, "execute");
  const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", remoteCwd: remote, providerKey: "daytona", runner, recordWorkspaceSync };
  const input = { runId: "first-run", adapterKey, target, workspaceLocalDir: local };
  const first = await prepareAdapterExecutionTargetRuntime(input);
  await writeFile(path.join(remote, "app.txt"), "agent's uncommitted source");
  await writeFile(path.join(remote, "database.json"), '{"visits":1}');
  await first.restoreWorkspace();
  const baseline = recordWorkspaceSync.mock.calls[0]![0];
  expect(baseline.sha256).toMatch(/^[a-f0-9]{64}$/);
  execute.mockClear();
  return { input, target, local, remote, baseline, execute, recordWorkspaceSync };
}

describe("retained workspace synchronization through the adapter entry point", () => {
  it.each(["codex", "paperclip-runner"])("imports independent service files into an authorized empty %s mirror", async (adapterKey) => {
    const f = await workspaceFixture(adapterKey);
    await rm(f.local, { recursive: true }); await mkdir(f.local);
    await mkdir(path.join(f.remote, "node_modules"));
    await writeFile(path.join(f.remote, "node_modules", "installed.txt"), "original dependencies");
    const imported = await prepareAdapterExecutionTargetRuntime({ ...f.input,
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: null, initialImport: { hostCwd: f.local } } },
      ...(adapterKey === "paperclip-runner" ? { workspaceDurableSeed: { workspaceArchivePath: path.join(path.dirname(f.local), "seed.tar") } } : {}),
    });
    expect(await readFile(path.join(f.remote, "app.txt"), "utf8")).toBe("agent's uncommitted source");
    expect(await readFile(path.join(f.remote, "node_modules", "installed.txt"), "utf8")).toBe("original dependencies");
    await writeFile(path.join(f.remote, "app.txt"), "first attached agent edit");
    await imported.restoreWorkspace();
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("first attached agent edit");
    expect(await readFile(path.join(f.local, "database.json"), "utf8")).toBe('{"visits":1}');
    const baseline = f.recordWorkspaceSync.mock.calls.at(-1)![0];
    await writeFile(path.join(f.remote, "database.json"), '{"visits":2}');
    const next = await prepareAdapterExecutionTargetRuntime({ ...f.input, target: { ...f.target, retainedServiceWorkspace: { hostBaseline: baseline } } });
    expect(await readFile(path.join(f.remote, "database.json"), "utf8")).toBe('{"visits":2}');
    await next.restoreWorkspace();
    expect(await readFile(path.join(f.local, "database.json"), "utf8")).toBe('{"visits":2}');
  });

  it("refuses an initial import over hidden files even with caller exclusions", async () => {
    const f = await workspaceFixture();
    await rm(f.local, { recursive: true }); await mkdir(f.local);
    await writeFile(path.join(f.local, ".env"), "operator data");
    await expect(prepareAdapterExecutionTargetRuntime({ ...f.input,
      workspaceBaseline: { exclude: [".env"], entries: new Map() },
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: null, initialImport: { hostCwd: f.local } } },
    })).rejects.toThrow(/empty host mirror/);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.local, ".env"), "utf8")).toBe("operator data");
  });

  it("binds the first import to its authorized mirror and preserves edits made after admission", async () => {
    const f = await workspaceFixture();
    await rm(f.local, { recursive: true }); await mkdir(f.local);
    await expect(prepareAdapterExecutionTargetRuntime({ ...f.input,
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: null, initialImport: { hostCwd: f.remote } } },
    })).rejects.toThrow(/authorized host mirror/);
    expect(f.execute).not.toHaveBeenCalled();
    const imported = await prepareAdapterExecutionTargetRuntime({ ...f.input,
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: null, initialImport: { hostCwd: f.local } } },
      runtimeSpan: async (name, work) => {
        if (name === "snapshot.git") await writeFile(path.join(f.local, "app.txt"), "concurrent operator file");
        return work();
      },
    });
    await expect(imported.restoreWorkspace()).rejects.toThrow(/host working tree changed during/);
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("concurrent operator file");
    expect(await readFile(path.join(f.remote, "app.txt"), "utf8")).toBe("agent's uncommitted source");
  });

  it.each(["codex", "paperclip-runner"])("preserves %s service data and dependencies across runs with real archive transfers", async (adapterKey) => {
    const f = await workspaceFixture(adapterKey);
    // The app keeps writing after the first run completed. These bytes are newer
    // than both its host mirror and the next run's initial workspace snapshot.
    await writeFile(path.join(f.remote, "database.json"), '{"visits":2}');
    await mkdir(path.join(f.remote, "node_modules"));
    await writeFile(path.join(f.remote, "node_modules", "installed.txt"), "keep installed dependencies");
    const second = await prepareAdapterExecutionTargetRuntime({ ...f.input, runId: "next-agent-run",
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: f.baseline } },
      // A legacy/default call and native's explicit mode must both honor the
      // host-owned retained-workspace rule.
      ...(adapterKey === "paperclip-runner" ? { workspaceInboundMode: "host_current" as const } : {}),
    });
    expect(await readFile(path.join(f.remote, "app.txt"), "utf8")).toBe("agent's uncommitted source");
    expect(await readFile(path.join(f.remote, "database.json"), "utf8")).toBe('{"visits":2}');
    expect(await readFile(path.join(f.remote, "node_modules", "installed.txt"), "utf8")).toBe("keep installed dependencies");
    await writeFile(path.join(f.remote, "app.txt"), "next agent's hot reload edit");
    await second.restoreWorkspace();
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("next agent's hot reload edit");
    expect(await readFile(path.join(f.local, "database.json"), "utf8")).toBe('{"visits":2}');
    expect(f.recordWorkspaceSync).toHaveBeenCalledTimes(2);
  });

  it("refuses concurrent host edits before running a remote command or uploading files", async () => {
    const f = await workspaceFixture();
    await writeFile(path.join(f.local, "app.txt"), "host user edit");
    await writeFile(path.join(f.remote, "app.txt"), "service edit");
    await expect(prepareAdapterExecutionTargetRuntime({ ...f.input, target: { ...f.target, retainedServiceWorkspace: { hostBaseline: f.baseline } } })).rejects.toThrow(/host working tree changed/);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("host user edit");
    expect(await readFile(path.join(f.remote, "app.txt"), "utf8")).toBe("service edit");
  });

  it("does not infer permission to overwrite when the previous sync receipt is missing", async () => {
    const f = await workspaceFixture();
    await expect(prepareAdapterExecutionTargetRuntime({ ...f.input, target: { ...f.target, retainedServiceWorkspace: { hostBaseline: null } } })).rejects.toThrow(/no completed file-sync receipt/);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.remote, "app.txt"), "utf8")).toBe("agent's uncommitted source");
  });

  it("checks the service receipt even when recovery supplies its own baseline", async () => {
    const f = await workspaceFixture("paperclip-runner");
    await writeFile(path.join(f.local, "app.txt"), "operator changed the mirror during downtime");
    const recoveryBaseline = await captureDirectorySnapshot(f.local, { exclude: f.baseline.exclude });
    await expect(prepareAdapterExecutionTargetRuntime({ ...f.input,
      workspaceBaseline: recoveryBaseline,
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: f.baseline } },
    })).rejects.toThrow(/host working tree changed/);
    expect(f.execute).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("operator changed the mirror during downtime");
    expect(await readFile(path.join(f.remote, "app.txt"), "utf8")).toBe("agent's uncommitted source");
    expect(f.recordWorkspaceSync).toHaveBeenCalledTimes(1);
  });

  it("does not accept a recovery baseline in place of a missing service receipt", async () => {
    const f = await workspaceFixture("paperclip-runner");
    const recoveryBaseline = await captureDirectorySnapshot(f.local, { exclude: f.baseline.exclude });
    await expect(prepareAdapterExecutionTargetRuntime({ ...f.input,
      workspaceBaseline: recoveryBaseline,
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: null } },
    })).rejects.toThrow(/no completed file-sync receipt/);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.recordWorkspaceSync).toHaveBeenCalledTimes(1);
  });

  it("recovers with the verified mirror instead of an obsolete caller snapshot", async () => {
    const f = await workspaceFixture("paperclip-runner");
    await writeFile(path.join(f.remote, "database.json"), '{"visits":3}');
    const recovered = await prepareAdapterExecutionTargetRuntime({ ...f.input,
      // A completed sync can be persisted before the native descriptor is
      // finalized. Replaying the old descriptor must retain the newer receipt.
      workspaceBaseline: { entries: new Map(), exclude: ["app.txt", "database.json"] },
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: f.baseline } },
    });
    expect(recovered.workspaceSyncSnapshot?.baseline.exclude).toEqual(f.baseline.exclude);
    expect(recovered.workspaceSyncSnapshot?.baseline.entries.has("app.txt")).toBe(true);
    expect(await readFile(path.join(f.remote, "database.json"), "utf8")).toBe('{"visits":3}');
    await writeFile(path.join(f.remote, "app.txt"), "recovered agent edit");
    await recovered.restoreWorkspace();
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("recovered agent edit");
    expect(await readFile(path.join(f.local, "database.json"), "utf8")).toBe('{"visits":3}');
    expect(f.recordWorkspaceSync).toHaveBeenCalledTimes(2);
  });

  it("does not let recovery exclusions hide a host edit made after admission", async () => {
    const f = await workspaceFixture("paperclip-runner");
    const recovered = await prepareAdapterExecutionTargetRuntime({ ...f.input,
      workspaceBaseline: { entries: new Map(), exclude: ["app.txt"] },
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: f.baseline } },
      runtimeSpan: async (name, work) => {
        if (name === "snapshot.git") await writeFile(path.join(f.local, "app.txt"), "operator edit during recovery");
        return work();
      },
    });
    await writeFile(path.join(f.remote, "app.txt"), "remote edit during recovery");
    await expect(recovered.restoreWorkspace()).rejects.toThrow(/host working tree changed during/);
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("operator edit during recovery");
    expect(await readFile(path.join(f.remote, "app.txt"), "utf8")).toBe("remote edit during recovery");
    expect(f.recordWorkspaceSync).toHaveBeenCalledTimes(1);
  });

  it("preserves host edits made after admission, before the runtime prepares its baseline", async () => {
    const f = await workspaceFixture();
    await writeFile(path.join(f.remote, "app.txt"), "service change after the previous run");
    const second = await prepareAdapterExecutionTargetRuntime({ ...f.input,
      target: { ...f.target, retainedServiceWorkspace: { hostBaseline: f.baseline } },
      runtimeSpan: async (name, work) => {
        if (name === "snapshot.git") await writeFile(path.join(f.local, "app.txt"), "concurrent host edit");
        return work();
      },
    });
    await expect(second.restoreWorkspace()).rejects.toThrow(/host working tree changed during/);
    expect(await readFile(path.join(f.local, "app.txt"), "utf8")).toBe("concurrent host edit");
    expect(await readFile(path.join(f.remote, "app.txt"), "utf8")).toBe("service change after the previous run");
    expect(f.recordWorkspaceSync).toHaveBeenCalledTimes(1);
  });
});
