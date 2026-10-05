import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSshSpawnTarget,
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  prepareWorkspaceForSshExecution,
  readSshEnvLabFixtureStatus,
  removeRemoteDirectory,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "./ssh.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const SSH_FIXTURE_TEST_TIMEOUT_MS = 30_000;
let sshEnvLabUnsupportedReason: string | null = null;

// One entry per fixture root directory, registered at creation time so
// teardown survives a setup call that throws before the fixture starts, an
// assertion failure, or an early return on skip. `state` stays null until
// the fixture actually starts; a caller that stops the fixture itself still
// leaves the entry in the stack, so the drain below must be idempotent
// (stopSshEnvLabFixture is).
interface FixtureTeardownEntry {
  rootDir: string;
  state: SshEnvLabFixtureState | null;
}

const fixtureTeardowns: FixtureTeardownEntry[] = [];

// Creates the fixture root directory and registers its teardown entry in
// the same step, so a setup call that throws between here and the fixture
// start (mkdir, writeFile, git init) still leaves the root directory queued
// for removal.
async function createFixtureRootDir(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
  fixtureTeardowns.push({ rootDir, state: null });
  return rootDir;
}

async function drainFixtureTeardowns(): Promise<void> {
  while (fixtureTeardowns.length > 0) {
    const entry = fixtureTeardowns.pop();
    if (!entry) continue;
    if (entry.state) {
      try {
        await stopSshEnvLabFixture(entry.state);
      } catch (error) {
        // stopSshEnvLabFixture throws only when the listener survives
        // SIGKILL, and it deliberately keeps the root directory so a later
        // stop call can still find and signal it through the state file.
        // Report the failure but keep the root directory; do not remove it,
        // and do not rethrow, so a throw here cannot strand the entries
        // still left on the stack.
        console.error(
          `SSH env-lab fixture teardown failed for pid ${entry.state.pid} on port ${entry.state.port}:`,
          error,
        );
        continue;
      }
    }
    await rm(entry.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// Finds the pid of a running sshd process by its config file path, the same
// way isSshEnvLabFixtureProcess identifies a fixture internally. Used by the
// readiness-failure regression test, which needs the pid of a fixture that
// startSshEnvLabFixture never returns because it throws before returning it.
async function findSshdPidByConfigPath(sshdConfigPath: string): Promise<number | null> {
  const stdout = await new Promise<string>((resolve) => {
    execFile("ps", ["-eo", "pid=,args="], (error, out) => resolve(error ? "" : out));
  });
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex === -1) continue;
    const pid = Number.parseInt(trimmed.slice(0, spaceIndex), 10);
    const args = trimmed.slice(spaceIndex + 1);
    if (Number.isFinite(pid) && args.includes(sshdConfigPath)) {
      return pid;
    }
  }
  return null;
}

async function startSshEnvLabFixtureOrSkip(statePath: string, label: string) {
  // The teardown entry for this root directory must already exist: callers
  // create it with createFixtureRootDir() before they derive statePath, so
  // this only attaches the state to that entry instead of pushing a new
  // one (a root directory must never get two entries).
  const rootDir = path.dirname(statePath);
  const entry = fixtureTeardowns.find((candidate) => candidate.rootDir === rootDir);
  if (!entry) {
    throw new Error(
      `No fixture teardown entry for ${rootDir}. Call createFixtureRootDir() before starting a fixture.`,
    );
  }

  if (sshEnvLabUnsupportedReason) {
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }

  try {
    const state = await startSshEnvLabFixture({ statePath });
    entry.state = state;
    return state;
  } catch (error) {
    sshEnvLabUnsupportedReason = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }
}

interface ParsedProgressLine {
  raw: string;
  percent: number | null;
  doneMb: number | null;
  totalMb: number | null;
}

function parseProgressLine(line: string): ParsedProgressLine {
  const trimmed = line.trimEnd();
  const percentMatch = trimmed.match(/:\s*(\d+)%\s*\(([\d.]+)\/([\d.]+) MB\)$/);
  if (percentMatch) {
    return {
      raw: trimmed,
      percent: Number.parseInt(percentMatch[1]!, 10),
      doneMb: Number.parseFloat(percentMatch[2]!),
      totalMb: Number.parseFloat(percentMatch[3]!),
    };
  }
  const mbMatch = trimmed.match(/:\s*([\d.]+) MB$/);
  if (mbMatch) {
    return { raw: trimmed, percent: null, doneMb: Number.parseFloat(mbMatch[1]!), totalMb: null };
  }
  return { raw: trimmed, percent: null, doneMb: null, totalMb: null };
}

describe("ssh env-lab fixture", () => {
  afterEach(drainFixtureTeardowns);
  // Backstop: if a throw inside afterEach ever leaves an entry on the stack,
  // this drains it too instead of stranding a listener until the process exits.
  afterAll(drainFixtureTeardowns);

  it("starts an isolated sshd fixture and executes commands through it", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const quotedWorkspace = JSON.stringify(started.workspaceDir);
    const result = await runSshCommand(
      config,
      `cd ${quotedWorkspace} && pwd`,
    );

    expect(result.stdout.trim()).toBe(started.workspaceDir);
    const status = await readSshEnvLabFixtureStatus(statePath);
    expect(status.running).toBe(true);

    await stopSshEnvLabFixture(started);

    const stopped = await readSshEnvLabFixtureStatus(statePath);
    expect(stopped.running).toBe(false);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("resolves a relative statePath to the same absolute state across start, status, and stop", async () => {
    const rootDir = await createFixtureRootDir();
    const absoluteStatePath = path.join(rootDir, "state.json");
    // A path relative to the test process's own working directory. This is
    // the shape a caller outside this file's own resolveEnvLabSshStatePath
    // helper can pass; startSshEnvLabFixture must resolve it up front so the
    // persisted state and every derived path stay absolute.
    const relativeStatePath = path.relative(process.cwd(), absoluteStatePath);

    if (sshEnvLabUnsupportedReason) {
      console.warn(`Skipping relative statePath test: ${sshEnvLabUnsupportedReason}`);
      return;
    }
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
      console.warn(`Skipping relative statePath test: ${sshEnvLabUnsupportedReason}`);
      return;
    }

    const entry = fixtureTeardowns.find((candidate) => candidate.rootDir === rootDir);
    if (!entry) {
      throw new Error(`No fixture teardown entry for ${rootDir}.`);
    }

    let state: SshEnvLabFixtureState;
    try {
      state = await startSshEnvLabFixture({ statePath: relativeStatePath });
    } catch (error) {
      sshEnvLabUnsupportedReason = error instanceof Error ? error.message : String(error);
      console.warn(`Skipping relative statePath test: ${sshEnvLabUnsupportedReason}`);
      return;
    }
    entry.state = state;

    expect(state.statePath).toBe(absoluteStatePath);
    expect(state.rootDir).toBe(rootDir);

    const running = await readSshEnvLabFixtureStatus(relativeStatePath);
    expect(running.running).toBe(true);
    expect(running.state?.statePath).toBe(absoluteStatePath);

    const stopped = await stopSshEnvLabFixture(relativeStatePath);
    expect(stopped).toBe(true);
    entry.state = null;

    const afterStop = await readSshEnvLabFixtureStatus(relativeStatePath);
    expect(afterStop.running).toBe(false);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("forwards stdin to remote SSH commands", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH stdin forwarding test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remotePath = path.posix.join(started.workspaceDir, "stdin-forwarded.txt");

    await runSshCommand(
      config,
      `cat > ${JSON.stringify(remotePath)}`,
      {
        stdin: "hello over ssh stdin\n",
        timeoutMs: 30_000,
        maxBuffer: 256 * 1024,
      },
    );

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(remotePath)}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    expect(result.stdout).toBe("hello over ssh stdin\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("does not treat an unrelated reused pid as the running fixture", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    await stopSshEnvLabFixture(started);
    await mkdir(path.dirname(statePath), { recursive: true });

    await writeFile(
      statePath,
      JSON.stringify({ ...started, pid: process.pid }, null, 2),
      { mode: 0o600 },
    );

    const staleStatus = await readSshEnvLabFixtureStatus(statePath);
    expect(staleStatus.running).toBe(false);

    const restarted = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture restart test");
    if (!restarted) return;
    expect(restarted.pid).not.toBe(process.pid);

    await stopSshEnvLabFixture(restarted);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("rejects a forged state file and cannot signal an unrelated local process", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    // A process this test does not own. A forged state must never be able
    // to target it for SIGTERM or SIGKILL.
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
    const bystanderPid = bystander.pid;
    if (!bystanderPid) {
      throw new Error("Failed to spawn the bystander process for this regression test.");
    }

    try {
      const baseState = {
        kind: "ssh_openbsd" as const,
        bindHost: "127.0.0.1",
        host: "127.0.0.1",
        port: 0,
        username: os.userInfo().username,
        rootDir,
        workspaceDir: path.join(rootDir, "workspace"),
        statePath,
        createdAt: new Date().toISOString(),
        clientPrivateKeyPath: path.join(rootDir, "client_key"),
        clientPublicKeyPath: path.join(rootDir, "client_key.pub"),
        hostPrivateKeyPath: path.join(rootDir, "host_key"),
        hostPublicKeyPath: path.join(rootDir, "host_key.pub"),
        authorizedKeysPath: path.join(rootDir, "authorized_keys"),
        knownHostsPath: path.join(rootDir, "known_hosts"),
        sshdConfigPath: path.join(rootDir, "sshd_config"),
        sshdLogPath: path.join(rootDir, "sshd.log"),
      };

      const forgedVariants = [
        // An empty sshdConfigPath used to defeat the identity check: an
        // empty string is a substring of every command line.
        { ...baseState, pid: bystanderPid, sshdConfigPath: "" },
        // A sshdConfigPath outside the fixture root.
        { ...baseState, pid: bystanderPid, sshdConfigPath: "/etc/ssh/sshd_config" },
        // A non-positive pid.
        { ...baseState, pid: 0 },
        { ...baseState, pid: -1 },
      ];

      for (const forged of forgedVariants) {
        await writeFile(statePath, JSON.stringify(forged, null, 2), { mode: 0o600 });

        const status = await readSshEnvLabFixtureStatus(statePath);
        expect(status.running).toBe(false);
        expect(status.state).toBeNull();

        const stopped = await stopSshEnvLabFixture(statePath);
        expect(stopped).toBe(false);
      }

      // No forged state ever reached the identity check or a signal call,
      // so the bystander process is still alive.
      expect(() => process.kill(bystanderPid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(bystanderPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("stops the fixture listener and frees its loopback port", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH teardown regression test");
    if (!started) return;
    const { pid, port, bindHost } = started;

    await stopSshEnvLabFixture(started);

    let pidStillRunning = true;
    try {
      process.kill(pid, 0);
    } catch {
      pidStillRunning = false;
    }
    expect(pidStillRunning).toBe(false);

    // Bind the exact port to prove it is free; a stopped process is not
    // proof the OS released the socket.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(port, bindHost, () => {
        probe.close((closeError) => (closeError ? reject(closeError) : resolve()));
      });
    });
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("leaves no live listener and no root directory when the fixture fails readiness", async () => {
    if (sshEnvLabUnsupportedReason) {
      console.warn(`Skipping SSH readiness-failure cleanup test: ${sshEnvLabUnsupportedReason}`);
      return;
    }
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
      console.warn(`Skipping SSH readiness-failure cleanup test: ${sshEnvLabUnsupportedReason}`);
      return;
    }

    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const sshdConfigPath = path.join(rootDir, "sshd_config");

    // sshd binds through bindHost (127.0.0.1) and stays alive; the readiness
    // check targets an unreachable RFC 5737 TEST-NET-3 address instead, so it
    // fails on every attempt without ever reaching a real host. Poll for the
    // resulting sshd process concurrently, since startSshEnvLabFixture never
    // returns a state on this path (it throws before writing one).
    let capturedPid: number | null = null;
    const pollDeadline = Date.now() + 5_000;
    const pollForPid = (async () => {
      while (capturedPid === null && Date.now() < pollDeadline) {
        capturedPid = await findSshdPidByConfigPath(sshdConfigPath);
        if (capturedPid === null) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    })();

    await expect(
      startSshEnvLabFixture({
        statePath,
        host: "203.0.113.1",
        readinessTimeoutMs: 1_000,
      }),
    ).rejects.toThrow();

    await pollForPid;
    expect(capturedPid).not.toBeNull();

    let pidStillRunning = true;
    try {
      process.kill(capturedPid!, 0);
    } catch {
      pidStillRunning = false;
    }
    expect(pidStillRunning).toBe(false);

    await expect(stat(rootDir)).rejects.toThrow();
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("builds a remote script that sources login profiles but no nvm", async () => {
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/srv/paperclip/workspace",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "node",
      args: ["--version"],
      env: { FOO: "bar" },
    });

    // The remote script rides the last ssh argument. The SSH target is an
    // operator-configured host that can expose `node` only through a login
    // profile, so the wrapper sources the profiles. It no longer sources
    // `nvm.sh`; a profile that adds nvm still runs.
    const remoteScript = String(target.args.at(-1) ?? "");
    expect(remoteScript).not.toContain("nvm.sh");
    expect(remoteScript).not.toContain("NVM_DIR");
    // Source /etc/profile so a host that exposes the PATH through
    // /etc/profile.d scripts still resolves node and the agent CLI.
    expect(remoteScript).toContain("/etc/profile");
    expect(remoteScript).toContain(".profile");
    expect(remoteScript).toContain(".bash_profile");
    expect(remoteScript).toContain(".zprofile");
    // Fall back to .bashrc when no .bash_profile exists, so a host that adds
    // nvm in .bashrc still resolves node under a non-login SSH command.
    expect(remoteScript).toContain(".bashrc");
    // The last ssh argument wraps the script as `sh -c '...'`, so the inner
    // quotes are escaped. Assert the command still runs: cd, env, and the argv.
    expect(remoteScript).toContain("cd ");
    expect(remoteScript).toContain("/srv/paperclip/workspace");
    expect(remoteScript).toContain("exec env ");
    expect(remoteScript).toContain("node");
    expect(remoteScript).toContain("--version");
    await target.cleanup();
  });

  it("rejects invalid environment variable keys when constructing SSH spawn targets", async () => {
    await expect(
      buildSshSpawnTarget({
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
        command: "env",
        args: [],
        env: {
          "BAD KEY": "value",
        },
      }),
    ).rejects.toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("syncs a local directory into the remote fixture workspace", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "message.txt"), "hello from paperclip\n", "utf8");
    await writeFile(path.join(localDir, "._message.txt"), "should never sync\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
    });

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(path.posix.join(remoteDir, "message.txt"))} && if [ -e ${JSON.stringify(path.posix.join(remoteDir, "._message.txt"))} ]; then echo appledouble-present; fi`,
    );

    expect(result.stdout).toContain("hello from paperclip");
    expect(result.stdout).not.toContain("appledouble-present");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports throttled upload progress with a clamped percent and terminal 100% line", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    // Multiple files large enough that tar emits several pipe chunks, so the
    // byte counter crosses several step boundaries before the stream closes.
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(localDir, `blob-${index}.bin`), Buffer.alloc(256 * 1024, index + 1));
    }

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH upload progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-progress");

    const lines: ParsedProgressLine[] = [];
    await syncDirectoryToSsh({
      spec: { ...config, remoteCwd: started.workspaceDir },
      localDir,
      remoteDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
      progressLabel: "workspace",
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.raw).toContain("Syncing workspace to ssh");
    }
    // Monotonically increasing byte counts.
    const doneSeries = lines.map((line) => line.doneMb ?? 0);
    for (let index = 1; index < doneSeries.length; index += 1) {
      expect(doneSeries[index]!).toBeGreaterThanOrEqual(doneSeries[index - 1]!);
    }
    // Percent clamped to <= 99% on every line emitted before the stream closed.
    for (const line of lines.slice(0, -1)) {
      if (line.percent != null) expect(line.percent).toBeLessThanOrEqual(99);
    }
    // Terminal completion line is 100% with matching done/total.
    const last = lines.at(-1)!;
    expect(last.percent).toBe(100);
    expect(last.doneMb).toBe(last.totalMb);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports restore progress with a terminal completion line", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");
    const restoreDir = path.join(rootDir, "restore-target");

    await mkdir(localDir, { recursive: true });
    await mkdir(restoreDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(localDir, `blob-${index}.bin`), Buffer.alloc(256 * 1024, index + 1));
    }

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH restore progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const remoteDir = path.posix.join(started.workspaceDir, "restore-source");

    await syncDirectoryToSsh({ spec, localDir, remoteDir });

    const lines: ParsedProgressLine[] = [];
    await syncDirectoryFromSsh({
      spec,
      remoteDir,
      localDir: restoreDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
      progressLabel: "workspace",
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.raw).toContain("Restoring workspace from ssh");
    }
    // Terminal completion line: either an exact 100% (probe succeeded) or a
    // final MB-received line (probe unavailable). Either is a valid terminal.
    const last = lines.at(-1)!;
    expect(last.percent === 100 || (last.percent === null && last.doneMb !== null)).toBe(true);
    // The restored files round-tripped through the byte-counting transport.
    await expect(readFile(path.join(restoreDir, "blob-0.bin"))).resolves.toEqual(
      Buffer.alloc(256 * 1024, 1),
    );
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports exact git-history import percentage from the known bundle size", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.bin"), Buffer.alloc(256 * 1024, 7));
    await git(localRepo, ["add", "tracked.bin"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH git import progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const lines: ParsedProgressLine[] = [];
    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
    });

    const importLines = lines.filter((line) => line.raw.includes("Importing git history to ssh"));
    expect(importLines.length).toBeGreaterThan(0);
    // Known bundle size -> exact percentage with no "workspace" label.
    for (const line of importLines) {
      expect(line.raw).not.toContain("workspace");
      expect(line.percent).not.toBeNull();
    }
    const lastImport = importLines.at(-1)!;
    expect(lastImport.percent).toBe(100);
    expect(lastImport.doneMb).toBe(lastImport.totalMb);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("can dereference local symlinks while syncing to the remote fixture", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const sourceDir = path.join(rootDir, "source");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(sourceDir, "auth.json"), "{\"token\":\"secret\"}\n", "utf8");
    await symlink(path.join(sourceDir, "auth.json"), path.join(localDir, "auth.json"));

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH symlink sync test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-follow-links");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
      followSymlinks: true,
    });

    const result = await runSshCommand(
      config,
      `if [ -L ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))} ]; then echo symlink; else echo regular; fi && cat ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))}`,
    );

    expect(result.stdout).toContain("regular");
    expect(result.stdout).toContain("{\"token\":\"secret\"}");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("clears stale files when plain SSH preparation is retried", async () => {
    const rootDir = await createFixtureRootDir();
    const localDir = path.join(rootDir, "plain-local");
    await mkdir(path.join(localDir, "node_modules"), { recursive: true });
    await git(localDir, ["init"]);
    await writeFile(path.join(localDir, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(localDir, "removed.txt"), "remove on retry");
    const binary = Buffer.from([0, 255, 1]);
    await writeFile(path.join(localDir, "node_modules", "personal.bin"), binary);
    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH plain retry");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const input = { spec: { ...config, remoteCwd: started.workspaceDir }, localDir,
      remoteDir: started.workspaceDir, workspaceFileMode: "all" as const };
    // `workspaceFileMode: "all"` ships the directory as it sits: the ignore
    // file above says `node_modules/`, and this mode still carries it.
    expect(await prepareWorkspaceForSshExecution(input)).toEqual({
      gitBacked: false,
      transferExclude: [".paperclip-runtime"],
    });
    expect(await readFile(path.join(started.workspaceDir, "node_modules", "personal.bin"))).toEqual(binary);
    await rm(path.join(localDir, "removed.txt"));
    await prepareWorkspaceForSshExecution(input);
    await expect(stat(path.join(started.workspaceDir, "removed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(started.workspaceDir, "node_modules", "personal.bin"))).toEqual(binary);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("round-trips a git workspace through the SSH fixture", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(localRepo, "._tracked.txt"), "should stay local only\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    const originalHead = await git(localRepo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "dirty local\n", "utf8");
    await writeFile(path.join(localRepo, "untracked.txt"), "from local\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH workspace round-trip test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const remoteStatus = await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git status --short`,
    );
    expect(remoteStatus.stdout).toContain("M tracked.txt");
    expect(remoteStatus.stdout).toContain("?? untracked.txt");
    expect(remoteStatus.stdout).not.toContain("._tracked.txt");

    await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && git add tracked.txt untracked.txt && git commit -m "remote update" >/dev/null && printf "remote dirty\\n" > tracked.txt && printf "remote extra\\n" > remote-only.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const restoredHead = await git(localRepo, ["rev-parse", "HEAD"]);
    expect(restoredHead).not.toBe(originalHead);
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    expect(await git(localRepo, ["status", "--short"])).toContain("M tracked.txt");
    expect(await git(localRepo, ["status", "--short"])).not.toContain("._tracked.txt");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves both concurrent SSH restores in a shared git workspace", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "concurrent SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    expect(preparedA.workspaceRemoteDir).not.toBe(preparedB.workspaceRemoteDir);

    await runSshCommand(
      config,
      `printf "from run a\\n" > ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "run-a.txt"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `printf "from run b\\n" > ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "run-b.txt"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await Promise.all([
      preparedA.restoreWorkspace(),
      preparedB.restoreWorkspace(),
    ]);

    await expect(readFile(path.join(localRepo, "run-a.txt"), "utf8")).resolves.toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "run-b.txt"), "utf8")).resolves.toBe("from run b\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves nested per-run files across sequential SSH restores with stale baselines", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "sequential nested SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `mkdir -p ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "manual-qa/environment-matrix/ssh"))} && printf "from run a\\n" > ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "manual-qa/environment-matrix/ssh/claude_local.md"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `mkdir -p ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "manual-qa/environment-matrix/ssh"))} && printf "from run b\\n" > ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "manual-qa/environment-matrix/ssh/codex_local.md"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await preparedA.restoreWorkspace();
    await preparedB.restoreWorkspace();

    await expect(readFile(path.join(localRepo, "manual-qa/environment-matrix/ssh/claude_local.md"), "utf8")).resolves
      .toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "manual-qa/environment-matrix/ssh/codex_local.md"), "utf8")).resolves
      .toBe("from run b\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("round-trips remote git commits through the managed runtime restore path", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "managed-runtime SSH git round-trip test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "committed\\n" > tracked.txt && git add tracked.txt && git commit -m "remote update" >/dev/null && printf "dirty remote\\n" > tracked.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    await expect(readFile(path.join(localRepo, "tracked.txt"), "utf8")).resolves.toBe("dirty remote\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("propagates remote commits to the local worktree with no git remote configured (no-remote-git contract)", async () => {
    // Locks in the architectural contract documented in
    // packages/adapter-utils/README.md and packages/adapters/AUTHORING.md:
    // the local execution-workspace cwd is the only persistence boundary
    // across runs. No adapter may depend on a git remote for cross-run state.
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    // Assert there is no git remote configured before we begin, and verify
    // that no point in the round-trip introduces one. `git remote` returns an
    // empty string when no remotes exist (and exit code 0).
    expect(await git(localRepo, ["remote"])).toBe("");

    const started = await startSshEnvLabFixtureOrSkip(
      statePath,
      "no-remote-git contract test",
    );
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-no-remote",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    // Remote commit lands a deliverable that must show up locally via
    // sync-back alone — no `git push`, no fetch from any origin.
    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "deliverable\\n" > tracked.txt && git add tracked.txt && git commit -m "remote-only commit" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe(
      "remote-only commit",
    );
    expect(await readFile(path.join(localRepo, "tracked.txt"), "utf8")).toBe(
      "deliverable\n",
    );
    // Final assertion: still no git remote — restore did not silently add one.
    expect(await git(localRepo, ["remote"])).toBe("");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("merges concurrent remote commits through the managed runtime restore path", async () => {
    const rootDir = await createFixtureRootDir();
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "concurrent managed-runtime SSH git merge test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `cd ${JSON.stringify(preparedA.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "from run a\\n" > run-a.txt && git add run-a.txt && git commit -m "remote update a" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `cd ${JSON.stringify(preparedB.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "from run b\\n" > run-b.txt && git add run-b.txt && git commit -m "remote update b" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await Promise.all([
      preparedA.restoreWorkspace(),
      preparedB.restoreWorkspace(),
    ]);

    await expect(readFile(path.join(localRepo, "run-a.txt"), "utf8")).resolves.toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "run-b.txt"), "utf8")).resolves.toBe("from run b\n");
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toContain("Paperclip SSH sync merge");

    const recentSubjects = await git(localRepo, ["log", "--pretty=%s", "-3"]);
    expect(recentSubjects).toContain("remote update a");
    expect(recentSubjects).toContain("remote update b");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  // A workspace whose ignore file says `node_modules/` means it: an ignored
  // directory is build output, a cache or a credential store, and a host-built
  // one is frequently unusable on the box anyway. Shipping it costs the whole
  // transfer and buys nothing.
  async function createIgnoringRepo(rootDir: string): Promise<string> {
    const localRepo = path.join(rootDir, "local-workspace");
    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, ".gitignore"), "node_modules/\nbuilt-cache/\n", "utf8");
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", ".gitignore", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    // Ignored by the workspace's own rules.
    await mkdir(path.join(localRepo, "node_modules", "left-pad"), { recursive: true });
    await writeFile(path.join(localRepo, "node_modules", "left-pad", "index.js"), "mac binary\n", "utf8");
    await mkdir(path.join(localRepo, "built-cache"), { recursive: true });
    await writeFile(path.join(localRepo, "built-cache", "blob"), "cached\n", "utf8");
    // Not ignored, but on the shared heavy-directory list every transport drops.
    await mkdir(path.join(localRepo, "dist"), { recursive: true });
    await writeFile(path.join(localRepo, "dist", "bundle.js"), "built\n", "utf8");
    // Neither ignored nor heavy: this one has to arrive.
    await writeFile(path.join(localRepo, "untracked.txt"), "from local\n", "utf8");
    return localRepo;
  }

  async function remoteEntryKind(
    config: Awaited<ReturnType<typeof buildSshEnvLabFixtureConfig>>,
    remotePath: string,
  ): Promise<string> {
    const result = await runSshCommand(
      config,
      `if [ -e ${JSON.stringify(remotePath)} ]; then echo present; else echo absent; fi`,
      { timeoutMs: 30_000, maxBuffer: 16 * 1024 },
    );
    return result.stdout.trim();
  }

  it("does not ship a git workspace's ignored paths or heavy directories", async () => {
    const rootDir = await createFixtureRootDir();
    const localRepo = await createIgnoringRepo(rootDir);

    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH gitignore honouring");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);

    const prepared = await prepareWorkspaceForSshExecution({
      spec: { ...config, remoteCwd: started.workspaceDir },
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    expect(prepared.gitBacked).toBe(true);
    expect(prepared.transferExclude).toContain("node_modules");
    expect(prepared.transferExclude).toContain("built-cache");
    expect(prepared.transferExclude).toContain("dist");

    for (const skipped of ["node_modules", "built-cache", "dist"]) {
      expect(await remoteEntryKind(config, path.posix.join(started.workspaceDir, skipped))).toBe("absent");
    }
    // The working tree itself still arrives, tracked and untracked alike.
    expect(await remoteEntryKind(config, path.posix.join(started.workspaceDir, "tracked.txt"))).toBe("present");
    expect(await remoteEntryKind(config, path.posix.join(started.workspaceDir, "untracked.txt"))).toBe("present");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  // The restore must not read "absent on the box" as "deleted". A path the
  // upload never sent is absent for a reason that has nothing to do with the
  // run, and deleting the host's copy of it would be data loss.
  it("keeps the local ignored and heavy directories the upload skipped", async () => {
    const rootDir = await createFixtureRootDir();
    const localRepo = await createIgnoringRepo(rootDir);

    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH ignored-path restore");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-ignored",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `printf "from the run\\n" > ${JSON.stringify(path.posix.join(prepared.workspaceRemoteDir, "produced.txt"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    await expect(readFile(path.join(localRepo, "produced.txt"), "utf8")).resolves.toBe("from the run\n");
    await expect(readFile(path.join(localRepo, "node_modules", "left-pad", "index.js"), "utf8")).resolves
      .toBe("mac binary\n");
    await expect(readFile(path.join(localRepo, "built-cache", "blob"), "utf8")).resolves.toBe("cached\n");
    await expect(readFile(path.join(localRepo, "dist", "bundle.js"), "utf8")).resolves.toBe("built\n");
    await expect(readFile(path.join(localRepo, "untracked.txt"), "utf8")).resolves.toBe("from local\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  // Nothing used to remove these. One per run, one workspace each, on a box
  // with a disk.
  it("removes a finished run's transported workspace from the box", async () => {
    const rootDir = await createFixtureRootDir();
    const localRepo = await createIgnoringRepo(rootDir);

    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH run directory collection");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-collected",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const runDir = path.posix.join(started.workspaceDir, ".paperclip-runtime", "runs", "run-collected");
    expect(await remoteEntryKind(config, path.posix.join(runDir, "workspace", "tracked.txt"))).toBe("present");

    await prepared.restoreWorkspace();

    expect(await remoteEntryKind(config, runDir)).toBe("absent");
    // Only this run's directory, and only below `runs`: the anchor workspace
    // and the runtime directory that holds it are still there for the next run.
    expect(await remoteEntryKind(config, path.posix.join(started.workspaceDir, ".paperclip-runtime", "runs")))
      .toBe("present");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  // An ignore set too large to pass as tar arguments must cost weight, never
  // the transfer: `--exclude` entries travel on the command line, and enough of
  // them would fail the sync with E2BIG instead of syncing it unfiltered.
  it("falls back to the heavy-directory excludes when the ignored-path list will not fit on a command line", async () => {
    const rootDir = await createFixtureRootDir();
    const localRepo = path.join(rootDir, "local-workspace");
    await mkdir(path.join(localRepo, "data"), { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    // `data/` holds a tracked file, so `--directory` cannot collapse it: every
    // ignored sibling is reported as its own path.
    await writeFile(path.join(localRepo, ".gitignore"), "data/*.tmp\n", "utf8");
    await writeFile(path.join(localRepo, "data", "kept.txt"), "tracked\n", "utf8");
    await git(localRepo, ["add", ".gitignore", "data/kept.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    await mkdir(path.join(localRepo, "node_modules"), { recursive: true });
    await writeFile(path.join(localRepo, "node_modules", "dep.js"), "dep\n", "utf8");
    // 550 names of 213 bytes each. Counting the ignored paths alone, with a
    // flat allowance per entry, this set measures under the budget; the
    // command it actually produces is over it, because the quoting runs twice
    // over every entry. That gap is the bug this count pins: the upload used
    // to succeed and the restore to die with E2BIG.
    for (let index = 0; index < 550; index += 1) {
      const name = `${String(index).padStart(4, "0")}${"x".repeat(200)}.tmp`;
      await writeFile(path.join(localRepo, "data", name), "scratch\n", "utf8");
    }

    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH exclude budget");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);

    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    let prepared: Awaited<ReturnType<typeof prepareWorkspaceForSshExecution>>;
    try {
      prepared = await prepareWorkspaceForSshExecution({
        spec: { ...config, remoteCwd: started.workspaceDir },
        localDir: localRepo,
        remoteDir: started.workspaceDir,
      });
    } finally {
      warn.mockRestore();
    }

    expect(prepared.gitBacked).toBe(true);
    expect(prepared.transferExclude).toContain("node_modules");
    expect(prepared.transferExclude.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    // The budget is why the paths are missing, not a failed ignore scan: both
    // produce the same list, and only one of them says so. The warning quotes
    // the measured command, which is the thing the limit applies to.
    expect(warnings.join("\n")).toMatch(/makes a \d+-byte remote read command, over the/);
    // The transfer still happened, and the oversized ignore set rode along
    // instead of failing it.
    expect(await remoteEntryKind(config, path.posix.join(started.workspaceDir, "data", "kept.txt"))).toBe("present");
    expect(await remoteEntryKind(config, path.posix.join(started.workspaceDir, "node_modules"))).toBe("absent");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  // Git names a literal path. tar reads an `--exclude` value as a glob. An
  // ignored `report[1].csv` passed through unescaped excludes `report1.csv`
  // instead: tar omits a file the baseline still records, and the restore then
  // deletes the host's copy of it for being absent from the box.
  it("excludes an ignored path that holds a glob character, and no other file", async () => {
    const rootDir = await createFixtureRootDir();
    const localRepo = path.join(rootDir, "local-workspace");
    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    // Escaped in `.gitignore` too, or Git would read the brackets as a
    // character class and ignore `report1.csv` as well.
    await writeFile(path.join(localRepo, ".gitignore"), "report\\[1\\].csv\n", "utf8");
    await writeFile(path.join(localRepo, "report1.csv"), "the real report\n", "utf8");
    await git(localRepo, ["add", ".gitignore", "report1.csv"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    await writeFile(path.join(localRepo, "report[1].csv"), "scratch\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH glob-named ignore");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-glob",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    // Only the ignored name is held back. Its lookalike is a tracked file and
    // the run needs it.
    expect(await remoteEntryKind(config, path.posix.join(prepared.workspaceRemoteDir, "report[1].csv")))
      .toBe("absent");
    expect(await remoteEntryKind(config, path.posix.join(prepared.workspaceRemoteDir, "report1.csv")))
      .toBe("present");

    await prepared.restoreWorkspace();

    // The restore deletes a baseline path the box did not return. Neither of
    // these is that: one came back, the other was never sent.
    await expect(readFile(path.join(localRepo, "report1.csv"), "utf8")).resolves.toBe("the real report\n");
    await expect(readFile(path.join(localRepo, "report[1].csv"), "utf8")).resolves.toBe("scratch\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  // An excluded path is rarely at the top level. Clearing the local tree by
  // top-level name alone removes the parent of an excluded directory, and the
  // incoming tree cannot put back what the remote read never carried.
  it("keeps a nested excluded directory when a restore with no baseline clears the local tree", async () => {
    const rootDir = await createFixtureRootDir();
    const localRepo = path.join(rootDir, "local-workspace");
    await mkdir(path.join(localRepo, "packages", "app"), { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "packages", "app", "index.js"), "source\n", "utf8");
    await git(localRepo, ["add", "packages/app/index.js"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    // Nested two levels down, under a parent that is not excluded itself.
    await mkdir(path.join(localRepo, "packages", "app", "node_modules", "left-pad"), { recursive: true });
    await writeFile(
      path.join(localRepo, "packages", "app", "node_modules", "left-pad", "index.js"),
      "mac binary\n",
      "utf8",
    );

    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH nested exclude clear");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    await prepareWorkspaceForSshExecution({ spec, localDir: localRepo, remoteDir: started.workspaceDir });
    await runSshCommand(
      config,
      `printf "from the run\\n" > ${JSON.stringify(path.posix.join(started.workspaceDir, "packages", "app", "index.js"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await restoreWorkspaceFromSshExecution({ spec, localDir: localRepo, remoteDir: started.workspaceDir });

    await expect(readFile(path.join(localRepo, "packages", "app", "index.js"), "utf8")).resolves
      .toBe("from the run\n");
    await expect(
      readFile(path.join(localRepo, "packages", "app", "node_modules", "left-pad", "index.js"), "utf8"),
    ).resolves.toBe("mac binary\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  // A restore that fails part-way may have left the only copy of the run's
  // uncommitted edits on the box. Removing the directory then would turn a
  // failure the host can retry into lost work.
  it("keeps a run's transported workspace on the box when the restore fails", async () => {
    const rootDir = await createFixtureRootDir();
    const localRepo = await createIgnoringRepo(rootDir);

    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH failed restore");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-failed-restore",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const runDir = path.posix.join(started.workspaceDir, ".paperclip-runtime", "runs", "run-failed-restore");

    // An edit the host has never seen, and then a break that stops the restore
    // before it can be read: the git history is the first thing read back.
    await runSshCommand(
      config,
      `printf "never restored\\n" > ${JSON.stringify(path.posix.join(prepared.workspaceRemoteDir, "produced.txt"))} && ` +
        `rm -rf ${JSON.stringify(path.posix.join(prepared.workspaceRemoteDir, ".git"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      await expect(prepared.restoreWorkspace()).rejects.toThrow();
    } finally {
      warn.mockRestore();
    }

    expect(await remoteEntryKind(config, path.posix.join(runDir, "workspace", "produced.txt"))).toBe("present");
    expect(warnings.join("\n")).toContain(runDir);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("refuses to remove a remote path that is not a plain absolute directory", async () => {
    const rootDir = await createFixtureRootDir();
    const started = await startSshEnvLabFixtureOrSkip(path.join(rootDir, "state.json"), "SSH remote removal guard");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);

    for (const remoteDir of ["", "  ", "relative/path", "/", "/tmp/../etc"]) {
      await expect(removeRemoteDirectory({ spec: config, remoteDir })).rejects.toThrow(/Refusing to remove/);
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);
});
