import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixturePath = path.join(
  repoRoot,
  "scripts",
  "mcp-fixtures",
  "servers",
  "acp-echo-agent.mjs",
);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

it("spawns a real Node ACP agent with per-session env on this platform", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-spawn-smoke-"),
  );
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
  const stderr = await fs.readFile(
    path.join(stateDir, "run-stderr", "spawn-smoke.log"),
    "utf8",
  );
  expect(stderr).toContain("nes/close");
  expect(stderr).toContain("paperclip-acp-echo-agent started");
});

it("fails closed on a typed ACP session failure without exposing its provider text", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-typed-failure-"),
  );
  tempRoots.push(root);
  const logs: string[] = [];
  const providerText = "provider-error-canary-must-not-become-agent-output";
  const execute = createAcpxEngineExecutor();

  const result = await execute({
    runId: "typed-failure-smoke",
    agent: { id: "spawn-agent", companyId: "spawn-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      stateDir: path.join(root, "state"),
      cwd: repoRoot,
      env: { PAPERCLIP_ACPX_TYPED_FAILURE_CANARY: providerText },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);

  expect(result.exitCode).toBe(1);
  expect(result.errorCode).toBe("acpx_turn_failed");
  expect(JSON.stringify(result)).not.toContain(providerText);
  expect(logs.join("\n")).not.toContain(providerText);
  expect(result.summary).toContain("terminal request failure");
});

it("fails closed on a typed ACP session failure in persistent mode", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-persistent-typed-failure-"),
  );
  tempRoots.push(root);
  const providerText = "persistent-provider-error-canary-must-not-escape";
  const logs: string[] = [];
  const execute = createAcpxEngineExecutor();

  const result = await execute({
    runId: "persistent-typed-failure-smoke",
    agent: { id: "spawn-agent", companyId: "spawn-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
      mode: "persistent",
      warmHandleIdleMs: 0,
      stateDir: path.join(root, "state"),
      cwd: repoRoot,
      env: { PAPERCLIP_ACPX_TYPED_FAILURE_CANARY: providerText },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);

  expect(result.exitCode).toBe(1);
  expect(result.errorCode).toBe("acpx_turn_failed");
  expect(JSON.stringify(result)).not.toContain(providerText);
  expect(logs.join("\n")).not.toContain(providerText);
  expect(result.summary).toContain("terminal request failure");
});

it("preserves ordinary assistant text even when it resembles a provider error", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-error-shaped-answer-"),
  );
  tempRoots.push(root);
  const answer =
    'Warning: quoted example follows. {"error":{"type":"invalid_request_error","message":"example only"}}';
  const execute = createAcpxEngineExecutor();

  const result = await execute({
    runId: "error-shaped-answer-smoke",
    agent: { id: "spawn-agent", companyId: "spawn-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      stateDir: path.join(root, "state"),
      cwd: repoRoot,
      env: { PAPERCLIP_ACPX_SPAWN_SMOKE: answer },
    },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
  } as never);

  expect(result.exitCode).toBe(0);
  expect(result.summary).toBe(answer);
});

it("keeps a typed retry warning nonfatal when the turn produces an answer", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-typed-warning-"),
  );
  tempRoots.push(root);
  const answer = "Recovered after the transient connection warning.";
  const warningCanary = "typed-warning-is-not-terminal";
  const logs: string[] = [];
  const execute = createAcpxEngineExecutor();

  const result = await execute({
    runId: "typed-warning-smoke",
    agent: { id: "spawn-agent", companyId: "spawn-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
      mode: "oneshot",
      stateDir: path.join(root, "state"),
      cwd: repoRoot,
      env: {
        PAPERCLIP_ACPX_TYPED_WARNING_CANARY: warningCanary,
        PAPERCLIP_ACPX_SPAWN_SMOKE: answer,
      },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);

  expect(result.exitCode).toBe(0);
  expect(result.summary).toBe(answer);
  expect(JSON.stringify(result)).not.toContain(warningCanary);
  expect(logs.join("\n")).not.toContain(warningCanary);
});

it("captures the Node error shape for a host-invalid spawn cwd", async () => {
  // Regression anchor for the primitive behind the remote-lane bug: a host
  // `spawn()` whose `cwd` does not exist fails BEFORE `exec`, when libuv
  // `chdir`s into it. The command itself (`process.execPath`) is valid, so the
  // failure is unambiguously the missing cwd — the exact condition acpx hits
  // when it host-spawns the relay proxy with the in-sandbox `remoteCwd`.
  const missingCwd = path.join(
    os.tmpdir(),
    "paperclip-acpx-missing-spawn-cwd",
    "nested",
    "does-not-exist",
  );

  const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "0"], {
      cwd: missingCwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.once("error", resolve);
    child.once("spawn", () => {
      child.kill("SIGKILL");
      reject(
        new Error(
          "expected spawn to fail with a host-invalid cwd, but it started",
        ),
      );
    });
  });

  expect(err.code).toBe("ENOENT");
  // libuv attributes the failed pre-`exec` `chdir` to the command spawn, not to
  // the missing cwd — `syscall`/`path` point at the executable. This misdirection
  // is precisely why the remote-lane failure was hard to diagnose.
  expect(err.syscall).toBe(`spawn ${process.execPath}`);
  expect(err.path).toBe(process.execPath);
});
