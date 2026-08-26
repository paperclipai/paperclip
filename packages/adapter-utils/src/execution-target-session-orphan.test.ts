import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getProcessSessionRemoteSource } from "./execution-target.js";

// Regression coverage for orphaned process sessions (BRO-2368). The wrapper is
// launched with `nohup ... &`, so it leaves the run's process group and
// reparents to init as soon as its launching shell exits. Nothing supervises it
// after that, which makes leaving on its own the only thing that bounds its
// lifetime.
//
// Three defects kept it resident. The event-file wrapper went on polling after
// its own child had exited, waiting for a `stdinEnd` that only arrives if the
// host is still alive to send one. `stop()` wrote that `stdinEnd` and then
// removed the session directory on the very next line, so the 50 ms poll could
// lose the race and never see the request. And nothing at all covered a host
// that died without running `stop()`. A single clear-out found 205 strays
// across three runs holding ~10.5 GB, some of them four days old.
//
// Each test below drives the real emitted wrapper source, not a reimplementation
// of it, and asserts on the child as well as the wrapper: a teardown that leaves
// the child behind has only changed which process is the orphan.
describe("process session orphan teardown (BRO-2368)", () => {
  const cleanupDirs: string[] = [];
  const livePids: number[] = [];

  afterEach(async () => {
    // Never let this suite become the leak it is testing for.
    while (livePids.length > 0) {
      const pid = livePids.pop();
      if (pid == null) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is the outcome these tests are asserting.
      }
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !isAlive(pid);
  }

  // Launch the real emitted wrapper as its own process, exactly as the sandbox
  // launch does. `streamOutput` picks the variant: the event-file wrapper is the
  // one the legacy poll path backgrounds, and the one that leaked.
  async function startWrapper(options: {
    command: string;
    args?: string[];
    streamOutput?: boolean;
    watchdogIntervalMs?: number;
    childKillGraceMs?: number;
  }) {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-session-orphan-"));
    cleanupDirs.push(sessionDir);
    await mkdir(path.join(sessionDir, "stdin"), { recursive: true });
    await mkdir(path.join(sessionDir, "events"), { recursive: true });

    const wrapperPath = path.join(sessionDir, "wrapper.mjs");
    await writeFile(
      wrapperPath,
      getProcessSessionRemoteSource({ outputToStdout: options.streamOutput === true }),
      "utf8",
    );

    const config = {
      command: options.command,
      args: options.args ?? [],
      cwd: sessionDir,
      env: {},
    };
    const env: Record<string, string> = {
      ...process.env,
      PAPERCLIP_PROCESS_SESSION_DIR: sessionDir,
      PAPERCLIP_PROCESS_SESSION_COMMAND_B64: Buffer.from(JSON.stringify(config), "utf8").toString("base64"),
    };
    if (options.watchdogIntervalMs != null) {
      env.PAPERCLIP_PROCESS_SESSION_WATCHDOG_INTERVAL_MS = String(options.watchdogIntervalMs);
    }
    if (options.childKillGraceMs != null) {
      env.PAPERCLIP_PROCESS_SESSION_CHILD_KILL_GRACE_MS = String(options.childKillGraceMs);
    }

    const wrapper = spawn(process.execPath, [wrapperPath], {
      cwd: sessionDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    livePids.push(wrapper.pid as number);

    const exited = new Promise<void>((resolve) => wrapper.on("close", () => resolve()));
    return { sessionDir, wrapper, exited };
  }

  // Find the wrapper's child by parentage rather than by matching its command
  // line: the wrapper spawns it directly, so `pgrep -P` names it exactly, and
  // the test does not depend on how `ps` renders a multi-line `sh -c` argument.
  async function findChildPid(wrapperPid: number, timeoutMs = 5_000): Promise<number> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // `pgrep` exits non-zero when nothing matches, which rejects here.
      const { stdout } = await run("pgrep", ["-P", String(wrapperPid)]).catch(() => ({ stdout: "" }));
      const pid = Number.parseInt(stdout.trim().split("\n")[0] ?? "", 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Never observed a child of wrapper pid ${wrapperPid}`);
  }

  // Path 1: the normal exit. This is the one that leaked on every clean run.
  it("event-file wrapper exits once its child closes, without waiting for stdinEnd", async () => {
    const { wrapper, exited } = await startWrapper({ command: "true" });

    // No stdinEnd is ever written here: the host is deliberately silent, which
    // is what a wrapper whose run has moved on actually experiences.
    await Promise.race([
      exited,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("wrapper never exited")), 10_000)),
    ]);

    expect(await waitForExit(wrapper.pid as number, 2_000)).toBe(true);
  }, 20_000);

  // Path 2: the crash backstop. `stop()` never runs, so the only thing the
  // wrapper can notice is its session directory going away.
  it("wrapper tears down itself and its child when the session directory disappears", async () => {
    const marker = `paperclip-orphan-watchdog-${process.pid}`;
    const { sessionDir, wrapper } = await startWrapper({
      // A long-lived child, so the wrapper cannot exit by the child-close path
      // and the watchdog is genuinely the thing under test.
      command: "sh",
      args: ["-c", `# ${marker}\nsleep 300`],
      watchdogIntervalMs: 100,
      childKillGraceMs: 500,
    });

    const childPid = await findChildPid(wrapper.pid as number);
    expect(isAlive(childPid)).toBe(true);

    // Simulate the host vanishing: the directory goes, nothing is signalled.
    await rm(sessionDir, { recursive: true, force: true });

    expect(await waitForExit(wrapper.pid as number, 10_000)).toBe(true);
    // The wrapper leaving is only half of it. A child left behind here is the
    // original bug wearing a different pid.
    expect(await waitForExit(childPid, 10_000)).toBe(true);
  }, 30_000);

  // Path 3: the deterministic host-driven teardown that `stop()` now performs.
  it("wrapper tears down itself and its child on SIGTERM", async () => {
    const marker = `paperclip-orphan-sigterm-${process.pid}`;
    const { wrapper } = await startWrapper({
      command: "sh",
      args: ["-c", `# ${marker}\nsleep 300`],
      childKillGraceMs: 500,
    });

    const childPid = await findChildPid(wrapper.pid as number);
    expect(isAlive(childPid)).toBe(true);

    process.kill(wrapper.pid as number, "SIGTERM");

    expect(await waitForExit(wrapper.pid as number, 10_000)).toBe(true);
    expect(await waitForExit(childPid, 10_000)).toBe(true);
  }, 30_000);

  // A child that ignores SIGTERM must not extend the wrapper's life. Without
  // the SIGKILL escalation the wrapper waits forever on a child that will never
  // leave, which is the same stray with an extra step.
  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const marker = `paperclip-orphan-stubborn-${process.pid}`;
    const { wrapper } = await startWrapper({
      command: "sh",
      args: ["-c", `# ${marker}\ntrap '' TERM\nsleep 300`],
      childKillGraceMs: 500,
    });

    const childPid = await findChildPid(wrapper.pid as number);
    process.kill(wrapper.pid as number, "SIGTERM");

    expect(await waitForExit(wrapper.pid as number, 10_000)).toBe(true);
    expect(await waitForExit(childPid, 10_000)).toBe(true);
  }, 30_000);

  // The streamed wrapper already ended its poll on child close. Pin that, so
  // the shared teardown tail cannot regress the variant that was working.
  it("streamed wrapper still exits once its child closes", async () => {
    const { wrapper, exited } = await startWrapper({ command: "true", streamOutput: true });

    await Promise.race([
      exited,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("wrapper never exited")), 10_000)),
    ]);

    expect(await waitForExit(wrapper.pid as number, 2_000)).toBe(true);
  }, 20_000);
});
