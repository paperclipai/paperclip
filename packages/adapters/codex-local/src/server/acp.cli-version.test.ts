import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const { ensureAdapterExecutionTargetCommandResolvable, runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "codex-cli 0.156.0\n",
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return { ...actual, ensureAdapterExecutionTargetCommandResolvable, runAdapterExecutionTargetProcess };
});

import { testCodexAcpEnvironment } from "./acp.js";

describe("codex ACP lane model CLI floor", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-acp-version-"));
    vi.stubEnv("CODEX_HOME", await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-acp-home-")));
    vi.stubEnv("PAPERCLIP_HOME", await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-acp-instance-")));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  });

  function sandboxTarget(): AdapterExecutionTarget {
    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/remote/workspace",
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
  }

  it("fails the sandbox Test when the shared codex is older than the model's floor", async () => {
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { cwd, model: "gpt-6.1-sol", env: { OPENAI_API_KEY: "sk-test" } },
      executionTarget: sandboxTarget(),
      environmentName: "QA Daytona",
    });

    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.code === "codex_cli_version_incompatible")).toMatchObject({
      level: "error",
      message: "gpt-6.1-sol requires Codex CLI 0.159.0 or newer with ChatGPT sign-in.",
      detail: "Detected Codex CLI 0.156.0.",
    });
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string,
      AdapterExecutionTarget,
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(call[1]).toMatchObject({ kind: "remote", transport: "sandbox" });
    expect(call[2]).toBe("codex");
    expect(call[3]).toEqual(["--version"]);
    expect(call[4].env).toEqual({ OPENAI_API_KEY: "sk-test" });
  });

  it("probes the codex the agent's configured env selects, not the image default", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "codex-cli 0.160.0\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        cwd,
        model: "gpt-6.1-sol",
        env: {
          OPENAI_API_KEY: "sk-test",
          PATH: "/opt/codex-0.160.0/bin:/usr/local/bin:/usr/bin",
          CODEX_HOME: "/remote/codex-home",
          PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: false,
        },
      },
      executionTarget: sandboxTarget(),
      environmentName: "QA Daytona",
    });

    expect(result.status).toBe("pass");
    expect(result.checks.find((check) => check.code === "codex_cli_version_compatible")).toMatchObject({
      message: "Codex CLI 0.160.0 satisfies the 0.159.0 minimum for gpt-6.1-sol.",
    });
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string,
      AdapterExecutionTarget,
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(call[3]).toEqual(["--version"]);
    // String-valued entries are forwarded exactly as the ACP run receives them;
    // non-string values are dropped the same way buildCodexAcpConfig consumers do.
    expect(call[4].env).toEqual({
      OPENAI_API_KEY: "sk-test",
      PATH: "/opt/codex-0.160.0/bin:/usr/local/bin:/usr/bin",
      CODEX_HOME: "/remote/codex-home",
    });
  });

  it("passes the sandbox Test when the shared codex satisfies the floor", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "codex-cli 0.160.0\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { cwd, model: "gpt-6.1-sol", env: { OPENAI_API_KEY: "sk-test" } },
      executionTarget: sandboxTarget(),
      environmentName: "QA Daytona",
    });

    expect(result.status).toBe("pass");
    expect(result.checks.find((check) => check.code === "codex_cli_version_compatible")).toMatchObject({
      message: "Codex CLI 0.160.0 satisfies the 0.159.0 minimum for gpt-6.1-sol.",
    });
  });

  it("does not probe the sandbox for models without a verified floor", async () => {
    const result = await testCodexAcpEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { cwd, model: "gpt-5.6-sol", env: { OPENAI_API_KEY: "sk-test" } },
      executionTarget: sandboxTarget(),
      environmentName: "QA Daytona",
    });

    expect(result.status).toBe("pass");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    expect(result.checks.some((check) => check.code.startsWith("codex_cli_version_"))).toBe(false);
  });
});
