import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeServer,
} from "./sandbox-callback-bridge.js";
import type { RunProcessResult } from "./server-utils.js";

const execFile = promisify(execFileCallback);

type RunnerInput = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

const result = (exitCode: number, stderr = ""): RunProcessResult => ({
  exitCode,
  signal: null,
  timedOut: false,
  stdout: exitCode === 0 ? '{"pid":4242}\n' : "",
  stderr,
  pid: null,
  startedAt: new Date().toISOString(),
});

const startInput = (runner: { execute: (input: RunnerInput) => Promise<RunProcessResult> }) => ({
  runner,
  remoteCwd: "/remote/workspace",
  assetRemoteDir: "/remote/assets",
  queueDir: "/remote/runtime/bridge",
  bridgeToken: "bridge-token",
  timeoutMs: 1_000,
});

const pidIdentityRecord = async (pid: number, procRoot = "/proc"): Promise<string> => {
  try {
    const stat = await readFile(`${procRoot}/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTime = fieldsAfterCommand[19];
    if (!startTime) throw new Error(`Missing process start time for PID ${pid}.`);
    return `${pid} ${startTime}\n`;
  } catch {
    const completed = await execFile("/bin/sh", [
      "-c",
      'started_at="$(LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | awk \'{$1=$1; print}\')"; [ -n "$started_at" ] || exit 1; printf \'%s\' "$started_at" | cksum | awk \'{print $1}\'',
      "sh",
      String(pid),
    ]);
    const startTime = completed.stdout.trim();
    if (!/^\d+$/.test(startTime)) throw new Error(`Missing process start time for PID ${pid}.`);
    return `${pid} ${startTime}\n`;
  }
};

const expectIdentityExitedOrZombie = async (pid: number, expectedIdentity: string): Promise<void> => {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    let currentIdentity: string;
    try {
      currentIdentity = await pidIdentityRecord(pid);
    } catch {
      return;
    }
    if (currentIdentity !== expectedIdentity) return;
    let completed: Awaited<ReturnType<typeof execFile>>;
    try {
      completed = await execFile("ps", ["-o", "state=", "-p", String(pid)]);
    } catch {
      return;
    }
    expect(String(completed.stdout).trim().slice(0, 1)).toBe("Z");
    return;
  }
  const commandEnd = stat.lastIndexOf(") ");
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const state = fields[0];
  const currentStartTime = fields[19];
  const expectedStartTime = expectedIdentity.trim().split(/\s+/)[1];
  if (currentStartTime !== expectedStartTime) return;
  expect(state).toBe("Z");
};

const createExecRunner = () => ({
  execute: async (input: RunnerInput): Promise<RunProcessResult> => {
    const startedAt = new Date().toISOString();
    const command = input.command === "sh" ? "/bin/sh" : input.command === "bash" ? "/bin/bash" : input.command;
    try {
      const completed = await execFile(command, input.args ?? [], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        timeout: input.timeoutMs,
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: completed.stdout,
        stderr: completed.stderr,
        pid: null,
        startedAt,
      };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: string | number | null;
        signal?: NodeJS.Signals | null;
        killed?: boolean;
      };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : null,
        signal: failure.signal ?? null,
        timedOut: Boolean(failure.killed && input.timeoutMs),
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        pid: null,
        startedAt,
      };
    }
  },
});

const withoutProcfs = (input: RunnerInput): RunnerInput => ({
  ...input,
  args: input.args?.map((arg) => arg.replaceAll("/proc/", "/definitely-missing-procfs/")),
});

describe("sandbox callback bridge startup cleanup", () => {
  const cleanupDirs: string[] = [];
  const cleanupProcesses: Array<ReturnType<typeof spawn>> = [];

  afterEach(async () => {
    for (const child of cleanupProcesses.splice(0)) {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }
    for (const directory of cleanupDirs.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records portable process identity when procfs is unavailable", async () => {
    const identity = await pidIdentityRecord(process.pid, "/definitely-missing-procfs");
    expect(identity).toMatch(new RegExp(`^${process.pid} \\d+\\n$`));
  });

  it("stops a launched callback bridge when readiness fails before a server handle is returned", async () => {
    const calls: RunnerInput[] = [];
    const runner = {
      execute: vi.fn(async (input: RunnerInput) => {
        calls.push(input);
        if (calls.length === 1) return result(0);
        if (calls.length === 2) return result(1, "ssh connection closed during readiness");
        return result(0);
      }),
    };

    await expect(startSandboxCallbackBridgeServer(startInput(runner))).rejects.toThrow(
      /wait for sandbox callback bridge readiness/i,
    );

    expect(runner.execute).toHaveBeenCalledTimes(3);
    const cleanupScript = calls[2]?.args?.[1] ?? "";
    expect(cleanupScript).toContain('kill "$pid"');
    expect(cleanupScript).toContain('kill -KILL "$pid"');
    expect(cleanupScript).toContain("expected_start_time");
    expect(cleanupScript).toContain('/proc/$pid/stat');
    expect(calls[0]?.args?.[1]).toContain("start_time");
    expect(calls[0]?.args?.[1]).toContain("Callback bridge process did not publish its identity.");
    expect(calls[0]?.args?.[1]).toContain('if [ -r "/proc/$pid/stat" ]; then');
    expect(calls[0]?.args?.[1]).toContain('IFS= read -r stat_line < "/proc/$pid/stat"');
    expect(calls[0]?.args?.[1]).toContain('ps -o lstart= -p "$pid"');
    expect(calls[0]?.args?.[1]).toContain("cksum");
    expect(cleanupScript).toContain('ps -o lstart= -p "$pid"');
    expect(cleanupScript).toContain('ps -ww -o command= -p "$pid"');
    expect(cleanupScript).toContain('*[!0-9]*');
    expect(calls[2]?.env?.PAPERCLIP_EXPECTED_BRIDGE_ENTRYPOINT).toContain("paperclip-bridge-server.mjs");
    expect(calls[2]?.env?.PAPERCLIP_EXPECTED_BRIDGE_LAUNCH_TOKEN).toContain("--paperclip-bridge-launch-token=");
    expect(cleanupScript).toContain("rm -f");
    expect(cleanupScript).toContain("server.pid");
    expect(cleanupScript).toContain("ready.json");
  });

  it("attempts cleanup when launch transport fails after the remote shell may have started the bridge", async () => {
    const calls: RunnerInput[] = [];
    const runner = {
      execute: vi.fn(async (input: RunnerInput) => {
        calls.push(input);
        if (calls.length === 1) return result(255, "ssh connection closed after launch");
        return result(0);
      }),
    };

    await expect(startSandboxCallbackBridgeServer(startInput(runner))).rejects.toThrow(
      /start sandbox callback bridge/i,
    );

    expect(runner.execute).toHaveBeenCalledTimes(2);
    const cleanupScript = calls[1]?.args?.[1] ?? "";
    expect(cleanupScript).toContain('kill "$pid"');
    expect(cleanupScript).toContain('kill -KILL "$pid"');
    expect(cleanupScript).toContain('*[!0-9]*');
    expect(calls[1]?.env?.PAPERCLIP_EXPECTED_BRIDGE_ENTRYPOINT).toContain("paperclip-bridge-server.mjs");
  });

  it("prevents a delayed remote launch from starting after ambiguous-transport cleanup", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-delayed-launch-"));
    cleanupDirs.push(rootDir);
    const assetRemoteDir = path.join(rootDir, "assets");
    const queueDir = path.join(rootDir, "bridge");
    await mkdir(assetRemoteDir, { recursive: true });
    await writeFile(
      path.join(assetRemoteDir, "paperclip-bridge-server.mjs"),
      "setInterval(() => {}, 1000);\n",
      "utf8",
    );

    const execRunner = createExecRunner();
    let delayedLaunch: RunnerInput | undefined;
    let call = 0;
    const runner = {
      execute: async (input: RunnerInput): Promise<RunProcessResult> => {
        call += 1;
        if (call === 1) {
          delayedLaunch = input;
          return result(255, "ambiguous launch transport failure");
        }
        return execRunner.execute(input);
      },
    };

    await expect(startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: rootDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: "bridge-token",
      nodeCommand: process.execPath,
      timeoutMs: 10_000,
    })).rejects.toThrow(/start sandbox callback bridge/i);

    expect(delayedLaunch).toBeDefined();
    const delayedResult = await execRunner.execute(delayedLaunch!);
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    let delayedPid: number | undefined;
    try {
      const record = await readFile(directories.pidFile, "utf8");
      delayedPid = Number(record.trim().split(/\s+/)[0]);
    } catch {
      // Expected: cancelled launch publishes no PID record.
    }
    if (delayedPid && delayedPid > 1) {
      try {
        process.kill(delayedPid, "SIGKILL");
      } catch {
        // Process already exited.
      }
    }

    expect(delayedResult.exitCode).not.toBe(0);
    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
    expect((await readdir(directories.rootDir)).filter((name) => name.includes(".launch-"))).toEqual([]);
  });

  it("cleans a bridge through portable identity when procfs is unavailable", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-post-spawn-"));
    cleanupDirs.push(rootDir);
    const assetRemoteDir = path.join(rootDir, "assets");
    const queueDir = path.join(rootDir, "bridge");
    const fakeNode = path.join(rootDir, "fake-node.sh");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(assetRemoteDir, { recursive: true });
    await writeFile(path.join(assetRemoteDir, "paperclip-bridge-server.mjs"), "// fixture\n", "utf8");
    await writeFile(
      fakeNode,
      "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n",
      "utf8",
    );
    await chmod(fakeNode, 0o755);

    const execRunner = createExecRunner();
    let call = 0;
    let spawnedPid = 0;
    let spawnedIdentity = "";
    const runner = {
      execute: async (input: RunnerInput): Promise<RunProcessResult> => {
        call += 1;
        if (call === 1) {
          const launched = await execRunner.execute(withoutProcfs(input));
          expect(launched.exitCode).toBe(0);
          spawnedIdentity = await readFile(directories.pidFile, "utf8");
          spawnedPid = Number(spawnedIdentity.trim().split(/\s+/)[0]);
          expect(spawnedIdentity).toBe(await pidIdentityRecord(spawnedPid, "/definitely-missing-procfs"));
          expect(spawnedPid).toBeGreaterThan(1);
          expect(() => process.kill(spawnedPid, 0)).not.toThrow();
          return result(255, "ambiguous transport result after remote spawn");
        }
        return execRunner.execute(withoutProcfs(input));
      },
    };

    await expect(startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: rootDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: "bridge-token",
      nodeCommand: fakeNode,
      timeoutMs: 10_000,
    })).rejects.toThrow(/start sandbox callback bridge/i);

    expect(spawnedPid).toBeGreaterThan(1);
    await expectIdentityExitedOrZombie(spawnedPid, spawnedIdentity);
    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
    expect((await readdir(directories.rootDir)).filter((name) => name.includes(".launch-"))).toEqual([]);
  }, 15_000);

  it("bounds unresolved cancellation tombstones without spawning another bridge", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-cancel-cap-"));
    cleanupDirs.push(rootDir);
    const assetRemoteDir = path.join(rootDir, "assets");
    const queueDir = path.join(rootDir, "bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    const fakeNode = path.join(rootDir, "must-not-run.sh");
    const marker = path.join(rootDir, "unexpected-spawn");
    await mkdir(assetRemoteDir, { recursive: true });
    await mkdir(directories.rootDir, { recursive: true });
    await writeFile(path.join(assetRemoteDir, "paperclip-bridge-server.mjs"), "// fixture\n", "utf8");
    await writeFile(fakeNode, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`, "utf8");
    await chmod(fakeNode, 0o755);
    for (let index = 0; index < 64; index += 1) {
      await writeFile(path.join(directories.rootDir, `.launch-old-${index}.cancel`), "", "utf8");
    }

    const runner = createExecRunner();
    await expect(startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: rootDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: "bridge-token",
      nodeCommand: fakeNode,
      timeoutMs: 10_000,
    })).rejects.toThrow(/too many unresolved callback bridge launches/i);

    await expect(readFile(marker, "utf8")).rejects.toThrow();
    expect((await readdir(directories.rootDir)).filter((name) => name.endsWith(".cancel"))).toHaveLength(64);
  });

  it("parses the start-time token after the final process-name delimiter", async () => {
    const fieldsAfterCommand = [
      "S",
      ...Array.from({ length: 18 }, (_, index) => String(index + 1)),
      "424242",
      "tail",
    ];
    const syntheticStat = `123 (bridge) embedded) name) ${fieldsAfterCommand.join(" ")}`;
    const parsed = await execFile("/bin/bash", [
      "-c",
      'stat_line="$1"; printf \'%s\\n\' "${stat_line##*) }" | awk \'{print $20}\'',
      "bash",
      syntheticStat,
    ]);
    expect(parsed.stdout.trim()).toBe("424242");
  });

  it("preserves the original startup error when cleanup also fails", async () => {
    const calls: RunnerInput[] = [];
    const runner = {
      execute: vi.fn(async (input: RunnerInput) => {
        calls.push(input);
        if (calls.length === 1) return result(255, "original launch transport error");
        return result(255, "cleanup transport error");
      }),
    };

    await expect(startSandboxCallbackBridgeServer(startInput(runner))).rejects.toThrow(
      /original launch transport error/i,
    );
    expect(runner.execute).toHaveBeenCalledTimes(2);
  });

  it("makes normal stop reject when cleanup cannot be verified", async () => {
    const calls: RunnerInput[] = [];
    const runner = {
      execute: vi.fn(async (input: RunnerInput) => {
        calls.push(input);
        if (calls.length === 1) return result(0);
        if (calls.length === 2) {
          return {
            ...result(0),
            stdout: '{"host":"127.0.0.1","port":43123,"pid":4242}\n',
          };
        }
        return result(1, "cleanup could not be verified");
      }),
    };

    const server = await startSandboxCallbackBridgeServer(startInput(runner));
    await expect(server.stop()).rejects.toThrow(/stop sandbox callback bridge/i);
  });

  it("rejects an unsafe PID value without signalling a process group", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-unsafe-pid-"));
    cleanupDirs.push(rootDir);
    const queueDir = path.join(rootDir, "bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(queueDir, { recursive: true });
    await writeFile(directories.pidFile, "0\n", "utf8");

    const execRunner = createExecRunner();
    let call = 0;
    const runner = {
      execute: async (input: RunnerInput): Promise<RunProcessResult> => {
        call += 1;
        if (call === 1) return result(0);
        if (call === 2) return result(1, "readiness failed");
        return execRunner.execute(input);
      },
    };

    await expect(startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: rootDir,
      assetRemoteDir: "/remote/assets",
      queueDir,
      bridgeToken: "bridge-token",
      timeoutMs: 10_000,
    })).rejects.toThrow(/wait for sandbox callback bridge readiness/i);

    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
  });

  it("does not signal a portable identity collision when the launch token changed", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-stale-pid-"));
    cleanupDirs.push(rootDir);
    const assetRemoteDir = path.join(rootDir, "assets");
    const remoteEntrypoint = path.join(assetRemoteDir, "paperclip-bridge-server.mjs");
    const queueDir = path.join(rootDir, "bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(queueDir, { recursive: true });

    const unrelated = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
      remoteEntrypoint,
      "--paperclip-bridge-launch-token=previous-launch",
    ]);
    cleanupProcesses.push(unrelated);
    const identityRecord = await pidIdentityRecord(unrelated.pid!, "/definitely-missing-procfs");
    await writeFile(directories.pidFile, identityRecord, "utf8");

    const execRunner = createExecRunner();
    let call = 0;
    const runner = {
      execute: async (input: RunnerInput): Promise<RunProcessResult> => {
        call += 1;
        if (call === 1) return result(0);
        if (call === 2) return result(1, "readiness failed");
        return execRunner.execute(withoutProcfs(input));
      },
    };

    await expect(startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: rootDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: "bridge-token",
      timeoutMs: 10_000,
    })).rejects.toThrow(/wait for sandbox callback bridge readiness/i);

    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
    await expect(readFile(directories.pidFile, "utf8")).resolves.toBe(identityRecord);
  });

  it("escalates to SIGKILL and verifies exit before deleting the PID file", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-resistant-pid-"));
    cleanupDirs.push(rootDir);
    const assetRemoteDir = path.join(rootDir, "assets");
    const remoteEntrypoint = path.join(assetRemoteDir, "paperclip-bridge-server.mjs");
    const queueDir = path.join(rootDir, "bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(queueDir, { recursive: true });

    const expectedLaunchToken = "--paperclip-bridge-launch-token=test-resistant";
    const resistant = spawn(process.execPath, [
      "-e",
      'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
      remoteEntrypoint,
      expectedLaunchToken,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    cleanupProcesses.push(resistant);
    await new Promise<void>((resolve, reject) => {
      resistant.stdout.once("data", () => resolve());
      resistant.once("error", reject);
    });
    const resistantIdentity = await pidIdentityRecord(resistant.pid!);
    await writeFile(directories.pidFile, resistantIdentity, "utf8");

    const execRunner = createExecRunner();
    let call = 0;
    const runner = {
      execute: async (input: RunnerInput): Promise<RunProcessResult> => {
        call += 1;
        if (call === 1) return result(0);
        if (call === 2) return result(1, "readiness failed");
        return execRunner.execute({
          ...input,
          env: { ...input.env, PAPERCLIP_EXPECTED_BRIDGE_LAUNCH_TOKEN: expectedLaunchToken },
        });
      },
    };

    await expect(startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: rootDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: "bridge-token",
      timeoutMs: 10_000,
    })).rejects.toThrow(/wait for sandbox callback bridge readiness/i);

    await expectIdentityExitedOrZombie(resistant.pid!, resistantIdentity);
    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
  }, 20_000);

  it("uses immutable PID identity to escalate after the process changes its title", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-bridge-renamed-pid-"));
    cleanupDirs.push(rootDir);
    const assetRemoteDir = path.join(rootDir, "assets");
    const remoteEntrypoint = path.join(assetRemoteDir, "paperclip-bridge-server.mjs");
    const queueDir = path.join(rootDir, "bridge");
    const directories = sandboxCallbackBridgeDirectories(queueDir);
    await mkdir(queueDir, { recursive: true });

    const expectedLaunchToken = "--paperclip-bridge-launch-token=test-renamed";
    const renamed = spawn(process.execPath, [
      "-e",
      'process.on("SIGTERM", () => { process.title = "renamed-bridge"; }); console.log("ready"); setInterval(() => {}, 1000)',
      remoteEntrypoint,
      expectedLaunchToken,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    cleanupProcesses.push(renamed);
    await new Promise<void>((resolve, reject) => {
      renamed.stdout.once("data", () => resolve());
      renamed.once("error", reject);
    });
    const renamedIdentity = await pidIdentityRecord(renamed.pid!);
    await writeFile(directories.pidFile, renamedIdentity, "utf8");

    const execRunner = createExecRunner();
    let call = 0;
    const runner = {
      execute: async (input: RunnerInput): Promise<RunProcessResult> => {
        call += 1;
        if (call === 1) return result(0);
        if (call === 2) return result(1, "readiness failed");
        return execRunner.execute({
          ...input,
          env: { ...input.env, PAPERCLIP_EXPECTED_BRIDGE_LAUNCH_TOKEN: expectedLaunchToken },
        });
      },
    };

    await expect(startSandboxCallbackBridgeServer({
      runner,
      remoteCwd: rootDir,
      assetRemoteDir,
      queueDir,
      bridgeToken: "bridge-token",
      timeoutMs: 10_000,
    })).rejects.toThrow(/wait for sandbox callback bridge readiness/i);

    await expectIdentityExitedOrZombie(renamed.pid!, renamedIdentity);
    await expect(readFile(directories.pidFile, "utf8")).rejects.toThrow();
  }, 20_000);
});
