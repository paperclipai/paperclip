import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  runAdapterExecutionTargetProcess,
}));

import { execute } from "./execute.js";

type Routing = { kind: string; protocol: string; baseUrl?: string; auth: string; models: unknown[] };

async function runManagedConnection(input: { routing: Routing | null; providerKey: string; connection?: boolean; openAiApiKey?: string }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-routed-gate-"));
  const paperclipHome = path.join(root, "paperclip-home");
  const hostCodexHome = path.join(root, "host-codex-home");
  const providerHome = path.join(root, "managed-ai", "provider");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(hostCodexHome, { recursive: true });
  await fs.mkdir(providerHome, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  const providerConfig = input.routing
    ? `model_provider = "paperclip"\n[model_providers.paperclip]\nname = "Paperclip connection"\n` +
      `base_url = ${JSON.stringify(input.routing.baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\n` +
      (input.routing.auth === "none" ? "" : 'env_key = "PAPERCLIP_AI_PROVIDER_KEY"\n')
    : "";
  await fs.writeFile(path.join(providerHome, "config.toml"), `cli_auth_credentials_store = "file"\n${providerConfig}`);

  vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  vi.stubEnv("CODEX_HOME", hostCodexHome);

  const run = execute({
    runId: "run-routed-gate",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "CodexCoder",
      adapterType: "codex_local",
      adapterConfig: { engine: "cli" },
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      engine: "cli",
      command: "codex",
      cwd: workspaceDir,
      paperclipRuntimeSkills: [],
      env: {
        CODEX_HOME: providerHome,
        OPENAI_API_KEY: input.openAiApiKey ?? "",
        CODEX_API_KEY: "",
        PAPERCLIP_AI_PROVIDER_KEY: input.providerKey,
      },
      ...(input.routing ? { managedAiRouting: input.routing } : {}),
      ...(input.connection === false ? {} : {
        managedAiConnection: {
          provider: "openai",
          method: "api_key",
          identity: "grant-1:shared:0000",
          sessionIdentity: "grant-1:shared:no-auth",
        },
      }),
    },
    context: {},
    onLog: async () => {},
  });
  return { root, run };
}

describe("codex credential gate on a managed AI connection", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    runAdapterExecutionTargetProcess.mockClear();
    while (cleanupDirs.length > 0) {
      await fs.rm(cleanupDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("launches Codex on a routed local connection that needs no credential", async () => {
    const { root, run } = await runManagedConnection({
      routing: { kind: "local", protocol: "responses", baseUrl: "http://127.0.0.1:4010/v1", auth: "none", models: [] },
      providerKey: "",
    });
    cleanupDirs.push(root);

    await expect(run).resolves.toBeDefined();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalled();
  });

  it("launches Codex on a routed gateway connection whose routing carries the provider key", async () => {
    const { root, run } = await runManagedConnection({
      routing: { kind: "gateway", protocol: "responses", baseUrl: "https://gateway.example.test/v1", auth: "bearer", models: [] },
      providerKey: "gw-test-key",
    });
    cleanupDirs.push(root);

    await expect(run).resolves.toBeDefined();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalled();
  });

  it("refuses a routed gateway connection whose provider key is empty", async () => {
    const { root, run } = await runManagedConnection({
      routing: { kind: "gateway", protocol: "responses", baseUrl: "https://gateway.example.test/v1", auth: "bearer", models: [] },
      providerKey: "",
    });
    cleanupDirs.push(root);

    await expect(run).rejects.toThrow(/no Codex credentials provisioned for managed home/);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("keeps the host-credential gate for a routing without a managed connection", async () => {
    const { root, run } = await runManagedConnection({
      routing: { kind: "local", protocol: "responses", baseUrl: "http://127.0.0.1:4010/v1", auth: "none", models: [] },
      providerKey: "",
      connection: false,
    });
    cleanupDirs.push(root);

    await expect(run).rejects.toThrow(/no usable auth\.json and OPENAI_API_KEY is empty/);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("passes the gate on a routed gateway connection with an empty provider key when OPENAI_API_KEY is configured", async () => {
    const { root, run } = await runManagedConnection({
      routing: { kind: "gateway", protocol: "responses", baseUrl: "https://gateway.example.test/v1", auth: "bearer", models: [] },
      providerKey: "",
      openAiApiKey: "sk-test-configured",
    });
    cleanupDirs.push(root);

    await expect(run).resolves.toBeDefined();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalled();
  });

  it("keeps the host-credential gate for a bedrock route, which projects no provider key", async () => {
    const { root, run } = await runManagedConnection({
      routing: { kind: "bedrock", protocol: "messages", auth: "bearer", models: [] },
      providerKey: "",
    });
    cleanupDirs.push(root);

    await expect(run).rejects.toThrow(/no usable auth\.json and OPENAI_API_KEY is empty/);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("refuses an unrouted connection with no auth.json and no key", async () => {
    const { root, run } = await runManagedConnection({ routing: null, providerKey: "" });
    cleanupDirs.push(root);

    await expect(run).rejects.toThrow(/no usable auth\.json and OPENAI_API_KEY is empty/);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
