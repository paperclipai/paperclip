import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSshRunCommandTarget, buildSshRunnerRemoteCommand, buildSshSpawnTarget } from "./ssh.js";

// Moving the remote environment onto a framed stdin prefix added a reader loop
// in front of the payload. A reader that forgot to `exec` would leave a shell
// sitting between sshd and the payload: `kill` against the remote pid would hit
// the wrapper, and a signal death would be reported back as a plain exit status
// 128+n instead of a signal. These tests pin that down for both POSIX call
// paths, with and without the reader prologue.
//
// sshd runs the remote argument as `$SHELL -c <argument>`, so the process it
// waits on is the shell that parses our script. The harness reproduces that
// exactly by spawning `sh -c "exec <argument>"`: the `exec` makes the child
// node observes the very process sshd would have. No sshd is required.

const SIGNAL_ENV = {
  PAPERCLIP_API_KEY: "paperclip-signal-canary-value",
  PAPERCLIP_AGENT_ID: "agent-fixture",
};

// Report the shell pid, then become a process with the default SIGTERM
// disposition. `sleep` dies on the signal itself, so the wait status the parent
// observes is a signal status and not a shell's 128+n translation.
const SIGNAL_PAYLOAD = 'printf "PID=%s\\n" "$$"; exec sleep 30';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createRemoteCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-signal-"));
  tempDirs.push(dir);
  return dir;
}

interface SignalRunResult {
  remotePid: number;
  reportedPid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Start the remote-side script, wait until the payload has announced its pid,
 * then deliver `signal` to the pid sshd would be holding.
 */
async function runAndSignal(
  remoteArgument: string,
  stdin: string,
  signal: NodeJS.Signals,
): Promise<SignalRunResult> {
  const child = spawn("sh", ["-c", `exec ${remoteArgument}`], { stdio: ["pipe", "pipe", "pipe"] });
  const remotePid = child.pid as number;
  expect(typeof remotePid).toBe("number");

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
    },
  );

  // The reader prologue blocks on the framed prefix, so stdin has to arrive
  // before the payload can announce itself.
  child.stdin.end(stdin);

  const reportedPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`payload never reported its pid; stdout=${stdout} stderr=${stderr}`));
    }, 20_000);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const match = /PID=(\d+)\n/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("close", () => {
      clearTimeout(timer);
      reject(new Error(`remote script exited before reporting a pid; stderr=${stderr}`));
    });
  });

  process.kill(remotePid, signal);
  // A wrapper left between sshd and the payload swallows the signal and keeps
  // waiting, so name that failure instead of letting the test time out.
  const result = await Promise.race([
    exited,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`remote pid ${remotePid} survived ${signal}; a wrapper process absorbed it`));
      }, 2_000).unref();
    }),
  ]);
  return { remotePid, reportedPid, ...result };
}

function expectSignalledExit(result: SignalRunResult, signal: NodeJS.Signals): void {
  // The payload owns the remote pid: nothing was left wrapping it, so the
  // signal ssh delivers reaches the payload itself.
  expect(result.reportedPid).toBe(result.remotePid);
  // A signal death stays a signal death all the way back to the caller.
  expect(result.signal).toBe(signal);
  expect(result.code).toBeNull();
  // No wrapper or payload process survives the signal.
  expect(() => process.kill(result.remotePid, 0)).toThrow();
}

describe.skipIf(process.platform === "win32")("SSH remote signal behaviour (no sshd required)", () => {
  it("delivers signals to the payload on the runSshCommand path with the environment reader", async () => {
    const cwd = await createRemoteCwd();
    const remoteCommand = buildSshRunnerRemoteCommand({
      command: "sh",
      args: ["-c", SIGNAL_PAYLOAD],
      cwd,
    });
    const target = buildSshRunCommandTarget({ remoteCommand, env: SIGNAL_ENV });
    expect(target.stdinPrefix).toBeDefined();
    // The reader prologue is the code under test here.
    expect(target.remoteArgument).toContain("__paperclip_env_header");

    const result = await runAndSignal(
      target.remoteArgument,
      target.stdinPrefix as string,
      "SIGTERM",
    );
    expectSignalledExit(result, "SIGTERM");
  });

  it("delivers signals to the payload on the runSshCommand path without an environment", async () => {
    const cwd = await createRemoteCwd();
    const remoteCommand = buildSshRunnerRemoteCommand({
      command: "sh",
      args: ["-c", SIGNAL_PAYLOAD],
      cwd,
    });
    const target = buildSshRunCommandTarget({ remoteCommand });
    expect(target.stdinPrefix).toBeUndefined();

    const result = await runAndSignal(target.remoteArgument, "", "SIGINT");
    expectSignalledExit(result, "SIGINT");
  });

  it("delivers signals to the payload on the spawn path with the environment reader", async () => {
    const cwd = await createRemoteCwd();
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: cwd,
        remoteCwd: cwd,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "sh",
      args: ["-c", SIGNAL_PAYLOAD],
      env: SIGNAL_ENV,
    });

    try {
      const remoteArgument = target.args.at(-1) as string;
      expect(typeof remoteArgument).toBe("string");
      expect(remoteArgument).toContain("__paperclip_env_header");
      expect(target.stdinPrefix).toBeDefined();

      const result = await runAndSignal(remoteArgument, target.stdinPrefix as string, "SIGTERM");
      expectSignalledExit(result, "SIGTERM");
    } finally {
      await target.cleanup();
    }
  });

  it("delivers signals to the payload on the spawn path without an environment", async () => {
    const cwd = await createRemoteCwd();
    const target = await buildSshSpawnTarget({
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: cwd,
        remoteCwd: cwd,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "sh",
      args: ["-c", SIGNAL_PAYLOAD],
      env: {},
    });

    try {
      const remoteArgument = target.args.at(-1) as string;
      expect(target.stdinPrefix).toBeUndefined();

      const result = await runAndSignal(remoteArgument, "", "SIGINT");
      expectSignalledExit(result, "SIGINT");
    } finally {
      await target.cleanup();
    }
  });
});
