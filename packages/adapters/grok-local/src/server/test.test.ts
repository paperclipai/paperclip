import { describe, expect, it, vi, beforeEach } from "vitest";

const ensureDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runProcessMock = vi.hoisted(() => vi.fn());
const prepareRuntimeMock = vi.hoisted(() => vi.fn());
const stageGrokHomeMock = vi.hoisted(() => vi.fn(async () => "/tmp/staged-grok-home"));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetDirectory: ensureDirectoryMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  resolveAdapterExecutionTargetCwd: (_target: unknown, configuredCwd: string, fallbackCwd: string) =>
    configuredCwd || fallbackCwd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

vi.mock("./grok-home.js", () => ({ stageGrokHomeForSync: stageGrokHomeMock }));
vi.mock("./grok-auth-copyback.js", () => ({ copyBackGrokAuth: vi.fn(async () => {}) }));

import { existsSync } from "node:fs";
import { parseGrokModelsOutput, testEnvironment } from "./test.js";

describe("parseGrokModelsOutput", () => {
  it("extracts auth state and models from `grok models` output", () => {
    expect(parseGrokModelsOutput([
      "You are logged in with grok.com.",
      "",
      "Default model: grok-build",
      "",
      "Available models:",
      "  * grok-build (default)",
      "  * grok-code",
    ].join("\n"))).toEqual({
      authenticated: true,
      defaultModel: "grok-build",
      models: ["grok-build", "grok-code"],
    });
  });
});

describe("grok_local testEnvironment", () => {
  beforeEach(() => {
    ensureDirectoryMock.mockClear();
    ensureCommandMock.mockClear();
    runProcessMock.mockReset();
    prepareRuntimeMock.mockReset();
    stageGrokHomeMock.mockClear();
  });

  it("reports a healthy authenticated host with a working hello probe", async () => {
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          "You are logged in with grok.com.",
          "",
          "Default model: grok-build",
          "",
          "Available models:",
          "  * grok-build (default)",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "hello" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        ].join("\n"),
        stderr: "",
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "grok_local",
      config: {
        command: "grok",
        cwd: "/tmp/project",
        model: "grok-build",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.map((check: { code: string }) => check.code)).toEqual(
      expect.arrayContaining([
        "grok_command_resolvable",
        "grok_models_probe_passed",
        "grok_model_configured",
        "grok_hello_probe_passed",
      ]),
    );
    expect(runProcessMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      null,
      "grok",
      expect.arrayContaining([
        "--output-format",
        "streaming-json",
        "--always-approve",
        "--permission-mode",
        "dontAsk",
        "--disable-web-search",
        "--single",
        "Respond with exactly hello.",
      ]),
      expect.any(Object),
    );
  });

  it("does not warn when the default-sentinel model is absent from the real model list", async () => {
    // Real grok never lists the "grok-build" sentinel; execute.ts never sends
    // it. The probe must treat the default as valid (info), not warn.
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          "You are logged in with grok.com.",
          "",
          "Default model: grok-4.20-0309-non-reasoning",
          "",
          "Available models:",
          "  * grok-4.20-0309-non-reasoning (default)",
          "  * grok-4",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "hello" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s", requestId: "r" }),
        ].join("\n"),
        stderr: "",
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "grok_local",
      config: { command: "grok", cwd: "/tmp/project" }, // no model → default sentinel
    });

    const codes = result.checks.map((check: { code: string }) => check.code);
    expect(codes).toContain("grok_model_configured");
    expect(codes).not.toContain("grok_model_not_found");
    expect(result.status).toBe("pass");
  });

  it("warns when an explicitly configured real model is not available", async () => {
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          "You are logged in with grok.com.",
          "",
          "Default model: grok-4",
          "",
          "Available models:",
          "  * grok-4",
        ].join("\n"),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "hello" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s", requestId: "r" }),
        ].join("\n"),
        stderr: "",
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "grok_local",
      config: { command: "grok", cwd: "/tmp/project", model: "grok-nonexistent" },
    });

    expect(result.checks.map((check: { code: string }) => check.code)).toContain("grok_model_not_found");
  });

  it("downgrades auth failures to warnings", async () => {
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Not logged in. Run `grok login`.",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Not logged in. Run `grok login`.",
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "grok_local",
      config: {
        command: "grok",
        cwd: "/tmp/project",
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks.map((check: { code: string }) => check.code)).toEqual(
      expect.arrayContaining([
        "grok_auth_required",
        "grok_hello_probe_auth_required",
      ]),
    );
  });

  it("emits the canonical adapter_auth_missing check for a sandbox target with missing authentication", async () => {
    // The user interface reads this neutral canonical code to decide login
    // eligibility for the sandbox; it does not parse the message text.
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Not logged in. Run `grok login`.",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Not logged in. Run `grok login`.",
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "grok_local",
      config: { command: "grok", cwd: "/tmp/project" },
      executionTarget: { kind: "remote", transport: "sandbox" } as never,
    });

    expect(result.checks.some((check: { code: string }) => check.code === "adapter_auth_missing")).toBe(
      true,
    );
  });

  it("stages the managed account through a host temp workspace, never the remote cwd", async () => {
    // The remote cwd is a path inside the sandbox. Handing it to the runtime
    // as `workspaceLocalDir` made the host-side ignore scan fail on a
    // directory that does not exist (git-ignore-scan-failed in production).
    let workspaceLocalDirAtCall: string | undefined;
    let workspaceExistedAtCall: boolean | undefined;
    prepareRuntimeMock.mockImplementationOnce(async (input: { workspaceLocalDir: string }) => {
      workspaceLocalDirAtCall = input.workspaceLocalDir;
      workspaceExistedAtCall = existsSync(input.workspaceLocalDir);
      return { assetDirs: { home: "/sandbox/assets/home" }, restoreWorkspace: async () => {} };
    });
    runProcessMock
      .mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: "You are logged in with grok.com.\n\nDefault model: grok-4\n\nAvailable models:\n  * grok-4", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: [JSON.stringify({ type: "text", data: "hello" }), JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "s", requestId: "r" })].join("\n"), stderr: "" });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "grok_local",
      config: { command: "grok", cwd: "/sandbox/workspace", managedAiConnection: { provider: "xai" } },
      executionTarget: { kind: "remote", transport: "sandbox" } as never,
    });

    expect(prepareRuntimeMock).toHaveBeenCalledOnce();
    expect(prepareRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRemoteDir: "/sandbox/workspace" }),
    );
    expect(workspaceLocalDirAtCall).not.toBe("/sandbox/workspace");
    expect(workspaceExistedAtCall).toBe(true);
    // The staged home dir the runtime uploaded is what the probe must use.
    expect(runProcessMock.mock.calls[0]?.[4]).toMatchObject({ env: expect.objectContaining({ GROK_HOME: "/sandbox/assets/home" }) });
    expect(result.status).toBe("pass");
  });

  it("reports a failed runtime preparation as a check instead of crashing", async () => {
    prepareRuntimeMock.mockRejectedValueOnce(
      new Error("Workspace ignore scan failed: git-ignore-scan-failed"),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "grok_local",
      config: { command: "grok", cwd: "/sandbox/workspace", managedAiConnection: { provider: "xai" } },
      executionTarget: { kind: "remote", transport: "sandbox" } as never,
    });

    expect(result.status).toBe("fail");
    const unprepared = result.checks.find((check: { code: string }) => check.code === "grok_environment_unprepared");
    expect(unprepared).toMatchObject({ level: "error" });
    // A failed staging means there is no environment worth probing.
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it("emits no adapter_auth_missing check for a local target with missing authentication", async () => {
    // The canonical check gates sandbox login eligibility only. A local target
    // has no sandbox login to offer, so the check must not appear.
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Not logged in. Run `grok login`.",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Not logged in. Run `grok login`.",
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "grok_local",
      config: { command: "grok", cwd: "/tmp/project" },
    });

    expect(result.checks.some((check: { code: string }) => check.code === "adapter_auth_missing")).toBe(
      false,
    );
  });
});
