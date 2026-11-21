import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access } from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const helloStdout = JSON.stringify({
  type: "turn_end",
  message: { role: "assistant", content: "hello" },
  toolResults: [],
});

const state = vi.hoisted(() => ({
  discoveryEnvs: [] as Array<Record<string, string>>,
  probeEnvs: [] as Array<Record<string, string>>,
  probeModelsJson: null as string | null,
  tempDirs: [] as string[],
  discovery: {
    models: [] as Array<{ id: string; label: string }>,
    error: null as Error | null,
  },
  probe: {
    value: { exitCode: 1, stdout: "", stderr: "" },
    throwError: null as Error | null,
  },
}));

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  discoverPiModelsCached,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
  maybeRunSandboxInstallCommand: vi.fn(async () => null),
  runAdapterExecutionTargetProcess: vi.fn(
    async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      options: { env?: Record<string, string> },
    ) => {
      const env = options.env ?? {};
      state.probeEnvs.push(env);
      if (typeof env.PI_CODING_AGENT_DIR === "string") {
        const fs = await import("node:fs/promises");
        state.probeModelsJson = await fs.readFile(
          path.join(env.PI_CODING_AGENT_DIR, "models.json"),
          "utf8",
        );
      }
      if (state.probe.throwError) throw state.probe.throwError;
      return {
        exitCode: state.probe.value.exitCode,
        signal: null,
        timedOut: false,
        stdout: state.probe.value.stdout,
        stderr: state.probe.value.stderr,
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    },
  ),
  describeAdapterExecutionTarget: vi.fn(() => "Daytona"),
  resolveAdapterExecutionTargetCwd: vi.fn(() => "/home/daytona/paperclip-workspace"),
  discoverPiModelsCached: vi.fn(async (input: { env?: Record<string, string> }) => {
    state.discoveryEnvs.push(input.env ?? {});
    if (state.discovery.error) throw state.discovery.error;
    return state.discovery.models;
  }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
  };
});

vi.mock("./models.js", () => ({ discoverPiModelsCached }));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mkdtemp = vi.fn(async (prefix: string) => {
    const dir = await actual.mkdtemp(prefix);
    state.tempDirs.push(dir);
    return dir;
  });
  return {
    ...actual,
    mkdtemp,
    default: { ...(actual as unknown as Record<string, unknown>), mkdtemp },
  };
});

import { testEnvironment } from "./test.js";

const sandboxTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "daytona",
  remoteCwd: "/home/daytona/paperclip-workspace",
  runner: {
    execute: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    }),
  },
};

const PROVIDERS = JSON.stringify({
  tensorix: {
    baseUrl: "http://gateway.example.svc.cluster.local:8080/anthropic",
    apiKey: "sk-literal",
    api: "anthropic-messages",
    models: [{ id: "claude-test" }],
  },
});

function localConfig(extra: Record<string, unknown> = {}) {
  return {
    command: "pi",
    model: "tensorix/claude-test",
    env: { PAPERCLIP_PI_PROVIDERS: PROVIDERS },
    ...extra,
  };
}

async function expectRemoved(dir: string) {
  await expect(access(dir)).rejects.toThrow();
}

beforeEach(() => {
  state.discoveryEnvs = [];
  state.probeEnvs = [];
  state.probeModelsJson = null;
  state.tempDirs = [];
  state.discovery = { models: [{ id: "tensorix/claude-test", label: "tensorix/claude-test" }], error: null };
  state.probe = { value: { exitCode: 0, stdout: helloStdout, stderr: "" }, throwError: null };
  delete process.env.PAPERCLIP_PI_PROVIDERS;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCLIP_PI_PROVIDERS;
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("pi environment test custom providers", () => {
  it("materializes PAPERCLIP_PI_PROVIDERS for discovery and the local hello probe", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: localConfig(),
      executionTarget: null,
      environmentName: null,
    });

    // Both discovery calls and the hello probe resolve the same managed dir.
    const configured = result.checks.find((check) => check.code === "pi_custom_providers_configured");
    expect(configured).toMatchObject({ level: "info" });
    expect(configured?.message).toContain("Injected 1 custom Pi provider(s)");

    const agentConfigDir = state.probeEnvs[0]?.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    expect(state.discoveryEnvs.length).toBeGreaterThan(0);
    for (const env of state.discoveryEnvs) {
      expect(env.PI_CODING_AGENT_DIR).toBe(agentConfigDir);
    }
    // The probe genuinely saw the provider registry the run would use.
    expect(state.probeModelsJson).toBeTruthy();
    const written = JSON.parse(state.probeModelsJson ?? "{}") as {
      providers?: Record<string, { baseUrl?: string }>;
    };
    expect(written.providers?.tensorix?.baseUrl).toBe(
      "http://gateway.example.svc.cluster.local:8080/anthropic",
    );

    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
    expect(result.status).toBe("pass");

    expect(state.tempDirs).toHaveLength(1);
    await expectRemoved(state.tempDirs[0]);
  });

  it("leaves the probe env untouched when PAPERCLIP_PI_PROVIDERS is unset", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: { command: "pi", model: "tensorix/claude-test" },
      executionTarget: null,
      environmentName: null,
    });

    expect(state.probeEnvs).toHaveLength(1);
    expect(state.probeEnvs[0]?.PI_CODING_AGENT_DIR).toBeUndefined();
    for (const env of state.discoveryEnvs) {
      expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    }
    expect(state.tempDirs).toHaveLength(0);
    expect(
      result.checks.some((check) => check.code.startsWith("pi_custom_providers")),
    ).toBe(false);
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);
    expect(result.status).toBe("pass");
  });

  it("warns on invalid PAPERCLIP_PI_PROVIDERS JSON without creating a temp dir or failing", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: localConfig({ env: { PAPERCLIP_PI_PROVIDERS: "{not json" } }),
      executionTarget: null,
      environmentName: null,
    });

    const invalid = result.checks.find((check) => check.code === "pi_custom_providers_invalid");
    expect(invalid).toMatchObject({ level: "warn" });
    expect(invalid?.message).toContain("PAPERCLIP_PI_PROVIDERS");
    expect(invalid?.hint).toContain("JSON object");

    expect(state.tempDirs).toHaveLength(0);
    expect(state.probeEnvs[0]?.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    expect(result.status).toBe("warn");
  });

  it("keeps the host temp dir out of a remote probe and warns it is unverified", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: localConfig(),
      executionTarget: sandboxTarget,
      environmentName: "Daytona",
    });

    // The managed dir is host-local, so it must never reach a remote sandbox.
    expect(state.probeEnvs).toHaveLength(1);
    expect(state.probeEnvs[0]?.PI_CODING_AGENT_DIR).toBeUndefined();

    const unverified = result.checks.find(
      (check) => check.code === "pi_custom_providers_remote_unverified",
    );
    expect(unverified).toMatchObject({ level: "warn" });
    expect(result.checks.some((check) => check.code === "pi_custom_providers_configured")).toBe(true);
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);

    // Validation still materialized the dir, and it is cleaned up.
    expect(state.tempDirs).toHaveLength(1);
    await expectRemoved(state.tempDirs[0]);
  });

  it("cleans up the managed dir when the environment test throws", async () => {
    maybeRunSandboxInstallCommand.mockRejectedValueOnce(new Error("sandbox install exploded"));

    await expect(
      testEnvironment({
        companyId: "company-1",
        adapterType: "pi_local",
        config: localConfig(),
        executionTarget: null,
        environmentName: null,
      }),
    ).rejects.toThrow("sandbox install exploded");

    expect(state.tempDirs).toHaveLength(1);
    await expectRemoved(state.tempDirs[0]);
  });
});
