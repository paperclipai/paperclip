import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixturePath = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-echo-agent.mjs");
const tempRoots: string[] = [];

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

it("does not export server-only secrets to the spawned agent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-spawn-env-"));
  tempRoots.push(root);
  const secretKeys = [
    "PAPERCLIP_AGENT_JWT_SECRET",
    "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
    "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
    "PAPERCLIP_DECISION_SIGNING_SECRET",
    "PAPERCLIP_SECRETS_MASTER_KEY",
    "BETTER_AUTH_SECRET",
    "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
    "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
    "PAPERCLIP_DEV_SERVER_STATUS_TOKEN",
    "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN",
    "PAPERCLIP_TELEMETRY_BACKEND_TOKEN",
    "PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET",
    "DATABASE_URL",
    "DATABASE_MIGRATION_URL",
  ];
  const inspectedKeys = [...secretKeys, "PAPERCLIP_API_KEY"];
  const previousValues = Object.fromEntries(secretKeys.map((key) => [key, process.env[key]]));
  const marker = "must-not-reach-agent";
  for (const key of secretKeys) process.env[key] = marker;

  try {
    const logs: string[] = [];
    const execute = createAcpxEngineExecutor();
    const result = await execute({
      runId: "spawn-env-smoke",
      agent: { id: "spawn-agent", companyId: "spawn-company" },
      authToken: "run-scoped-value",
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
        mode: "oneshot",
        stateDir: path.join(root, "state"),
        cwd: repoRoot,
        env: {
          PAPERCLIP_ACPX_INSPECT_ENV_KEYS: inspectedKeys.join(","),
          DATABASE_URL: marker,
        },
      },
      context: {},
      onLog: async (_stream: string, text: string) => logs.push(text),
      onMeta: async () => {},
    } as never);

    expect(result.exitCode, JSON.stringify({ result, logs }, null, 2)).toBe(0);
    const output = logs.join("");
    for (const key of secretKeys) expect(output).toContain(`\\"${key}\\":false`);
    expect(output).toContain(`\\"PAPERCLIP_API_KEY\\":true`);
    expect(output).not.toContain(marker);
  } finally {
    for (const key of secretKeys) {
      const previous = previousValues[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
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
