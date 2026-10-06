import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
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

async function writeFailureFile(root: string, title: string): Promise<string> {
  const file = path.join(root, "failure.json");
  await fs.writeFile(file, JSON.stringify({ title, category: "request" }));
  return file;
}

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

it("retains a typed ACP failure as diagnostics without making it assistant output", async () => {
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
      env: { PAPERCLIP_ACPX_TYPED_FAILURE_FILE: await writeFailureFile(root, providerText) },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);

  expect(result.exitCode).toBe(1);
  expect(result.errorCode).toBe("acpx_turn_failed");
  expect(result.errorMessage).toContain(providerText);
  expect(result.resultJson?.terminalSessionFailure).toMatchObject({ title: providerText });
  expect(result.summary).not.toContain(providerText);
  expect(logs.join("\n")).toContain(providerText);
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
      env: { PAPERCLIP_ACPX_TYPED_FAILURE_FILE: await writeFailureFile(root, providerText) },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);

  expect(result.exitCode).toBe(1);
  expect(result.errorCode).toBe("acpx_turn_failed");
  expect(result.errorMessage).toContain(providerText);
  expect(result.resultJson?.terminalSessionFailure).toMatchObject({ title: providerText });
  expect(result.summary).not.toContain(providerText);
  expect(logs.join("\n")).toContain(providerText);
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
  const classifyTerminalSessionFailure = vi.fn(() => null);
  const execute = createAcpxEngineExecutor({ classifyTerminalSessionFailure });

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
  expect(classifyTerminalSessionFailure).not.toHaveBeenCalled();
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

// #14093: acpx sends `settingSources: ["project", "local"]` on a Claude
// `session/new` unless ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1. Claude Code then
// loses the credentials in `~/.claude/settings.json` and every fresh session
// failed with "Not logged in". The `claude-agent-acp` argument makes acpx treat
// the fixture as the Claude bridge.
async function runClaudeSettingsSmoke(runId: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-claude-settings-"));
  tempRoots.push(root);
  const logs: string[] = [];
  const result = await createAcpxEngineExecutor()({
    runId,
    agent: { id: "spawn-agent", companyId: "spawn-company" },
    runtime: {},
    config: {
      agent: "custom",
      agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))} --as-claude-agent-acp`,
      mode: "oneshot",
      stateDir: path.join(root, "state"),
      cwd: repoRoot,
      env: {
        PAPERCLIP_ACPX_REQUIRE_USER_SETTINGS: "1",
        PAPERCLIP_ACPX_RUN_COMMAND: "echo terminal-command-ok",
      },
    },
    context: {},
    onLog: async (_stream: string, text: string) => logs.push(text),
    onMeta: async () => {},
  } as never);
  return { result, logs };
}

it.skipIf(process.platform === "win32")(
  "keeps Claude user settings on a fresh session so a turn that runs a terminal command succeeds",
  async () => {
    vi.stubEnv("ACPX_CLAUDE_INCLUDE_USER_SETTINGS", undefined);
    try {
      const { result, logs } = await runClaudeSettingsSmoke("claude-user-settings-smoke");
      expect(result.exitCode, JSON.stringify({ result, logs }, null, 2)).toBe(0);
      expect(logs.join("")).toContain("terminal-command-ok");
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("reports a Claude login failure as acpx_auth_required with the provider reason", async () => {
  // An operator who opts out of user settings still gets an actionable error.
  vi.stubEnv("ACPX_CLAUDE_INCLUDE_USER_SETTINGS", "0");
  try {
    const { result } = await runClaudeSettingsSmoke("claude-auth-required-smoke");
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("acpx_auth_required");
    expect(result.errorFamily).toBe("configuration");
    expect(result.errorMessage).toContain("Not logged in");
    expect(result.resultJson?.terminalSessionFailure).toMatchObject({ category: "access" });
  } finally {
    vi.unstubAllEnvs();
  }
});
