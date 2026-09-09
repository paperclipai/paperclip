import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixturePath = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-echo-agent.mjs");
const childLeakFixturePath = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-child-leak-agent.mjs");
const tempRoots: string[] = [];

async function readLinuxProcessState(pid: number): Promise<{ state: string; parentPid: number } | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const endOfCommand = stat.lastIndexOf(") ");
    if (endOfCommand < 0) return null;
    const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
    return { state: fields[0]!, parentPid: Number(fields[1]) };
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let lastState: string | null = null;
  while (Date.now() < deadline) {
    const processState = await readLinuxProcessState(pid);
    if (!processState) return null;
    lastState = `${processState.state} (ppid=${processState.parentPid})`;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return lastState;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("spawns a real Node ACP agent with per-session env on this platform", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-spawn-smoke-"));
  tempRoots.push(root);
  const stateDir = path.join(root, "state");
  const logs: string[] = [];
  const execute = createAcpxEngineExecutor();

  const result = await execute({
    runId: "spawn-smoke",
    agent: { id: "spawn-agent", companyId: "spawn-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      stateDir,
      cwd: repoRoot,
      env: { PAPERCLIP_ACPX_SPAWN_SMOKE: "spawn-ok" },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);

  expect(result.exitCode, JSON.stringify({ result, logs }, null, 2)).toBe(0);
  expect(logs.join(""), logs.join("\n")).toContain("spawn-ok");
  await expect(fs.access(path.join(stateDir, "wrappers"))).rejects.toThrow();
  const stderr = await fs.readFile(path.join(stateDir, "run-stderr", "spawn-smoke.log"), "utf8");
  expect(stderr).toContain("nes/close");
  expect(stderr).toContain("paperclip-acp-echo-agent started");
});

it("captures the Node error shape for a host-invalid spawn cwd", async () => {
  // Regression anchor for the primitive behind the remote-lane bug: a host
  // `spawn()` whose `cwd` does not exist fails BEFORE `exec`, when libuv
  // `chdir`s into it. The command itself (`process.execPath`) is valid, so the
  // failure is unambiguously the missing cwd — the exact condition acpx hits
  // when it host-spawns the relay proxy with the in-sandbox `remoteCwd`.
  const missingCwd = path.join(os.tmpdir(), "paperclip-acpx-missing-spawn-cwd", "nested", "does-not-exist");

  const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "0"], {
      cwd: missingCwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.once("error", resolve);
    child.once("spawn", () => {
      child.kill("SIGKILL");
      reject(new Error("expected spawn to fail with a host-invalid cwd, but it started"));
    });
  });

  expect(err.code).toBe("ENOENT");
  // libuv attributes the failed pre-`exec` `chdir` to the command spawn, not to
  // the missing cwd — `syscall`/`path` point at the executable. This misdirection
  // is precisely why the remote-lane failure was hard to diagnose.
  expect(err.syscall).toBe(`spawn ${process.execPath}`);
  expect(err.path).toBe(process.execPath);
});

it("reaps an ACPX child descendant after a completed run", async () => {
  if (process.platform !== "linux") return;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-reap-smoke-"));
  tempRoots.push(root);
  const stateDir = path.join(root, "state");
  const execute = createAcpxEngineExecutor();
  let leakedPid: number | null = null;
  try {
    const result = await execute({
      runId: "reap-smoke",
      agent: { id: "reap-agent", companyId: "reap-company" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(childLeakFixturePath.replaceAll("\\", "/"))}`,
        mode: "oneshot",
        warmHandleIdleMs: 0,
        stateDir,
        cwd: repoRoot,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
    leakedPid = Number.parseInt(result.summary ?? "", 10);
    expect(Number.isInteger(leakedPid) && leakedPid > 0).toBe(true);
    const remainingProcess = await waitForProcessExit(leakedPid!);
    expect(remainingProcess, `ACPX descendant ${leakedPid} was not reaped`).toBeNull();
  } finally {
    if (leakedPid) {
      try {
        process.kill(leakedPid, "SIGKILL");
      } catch {
        // The child may have exited between the assertion and cleanup.
      }
    }
  }
});
