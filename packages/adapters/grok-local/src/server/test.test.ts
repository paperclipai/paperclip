import { describe, expect, it, vi, beforeEach } from "vitest";

const ensureDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetDirectory: ensureDirectoryMock,
  resolveAdapterExecutionTargetCwd: (_target: unknown, configuredCwd: string, fallbackCwd: string) =>
    configuredCwd || fallbackCwd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

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
});
