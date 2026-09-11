import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const ensureDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const maybeInstallMock = vi.hoisted(() => vi.fn(async () => null));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetDirectory: ensureDirectoryMock,
  maybeRunSandboxInstallCommand: maybeInstallMock,
  resolveAdapterExecutionTargetCwd: (_target: unknown, configuredCwd: string, fallbackCwd: string) =>
    configuredCwd || fallbackCwd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import { testEnvironment } from "./test.js";

describe("kimi_local testEnvironment", () => {
  beforeEach(() => {
    ensureDirectoryMock.mockClear();
    ensureCommandMock.mockClear();
    maybeInstallMock.mockClear();
    runProcessMock.mockReset();
    // Keep auth detection deterministic on hosts that really have kimi set up.
    vi.stubEnv("KIMI_MODEL_NAME", "");
    vi.stubEnv("KIMI_MODEL_API_KEY", "");
    vi.stubEnv("KIMI_CODE_HOME", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports a healthy host with a working version and hello probe", async () => {
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "kimi 0.27.0\n",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ role: "assistant", content: "hello" }),
          JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_1" }),
        ].join("\n"),
        stderr: "",
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "kimi_local",
      config: {
        engine: "cli",
        command: "kimi",
        cwd: "/tmp/project",
        env: {
          KIMI_MODEL_NAME: "kimi-code/kimi-for-coding",
          KIMI_MODEL_API_KEY: "test-key",
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.map((check: { code: string }) => check.code)).toEqual(
      expect.arrayContaining([
        "kimi_command_resolvable",
        "kimi_version_detected",
        "kimi_auth_detected",
        "kimi_hello_probe_passed",
      ]),
    );
    expect(runProcessMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      null,
      "kimi",
      ["--version"],
      expect.any(Object),
    );
    expect(runProcessMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      null,
      "kimi",
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "-p",
        "Respond with hello.",
      ]),
      expect.any(Object),
    );
  });

  it("passes -m to the hello probe when a model is configured", async () => {
    runProcessMock
      .mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: "kimi 0.27.0\n", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ role: "assistant", content: "hello" }),
        stderr: "",
      });

    await testEnvironment({
      companyId: "company-1",
      adapterType: "kimi_local",
      config: {
        engine: "cli",
        command: "kimi",
        cwd: "/tmp/project",
        model: "kimi-code/k3",
        env: { KIMI_MODEL_NAME: "kimi-code/k3", KIMI_MODEL_API_KEY: "test-key" },
      },
    });

    expect(runProcessMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      null,
      "kimi",
      expect.arrayContaining(["-m", "kimi-code/k3"]),
      expect.any(Object),
    );
  });

  it("downgrades missing auth and auth probe failures to warnings", async () => {
    runProcessMock
      .mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: "kimi 0.27.0\n", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Not authenticated. Run `kimi login` to authenticate with a device code.",
      });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "kimi_local",
      config: {
        engine: "cli",
        command: "kimi",
        cwd: "/tmp/project",
        env: { KIMI_CODE_HOME: "/nonexistent-kimi-home-for-test" },
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks.map((check: { code: string }) => check.code)).toEqual(
      expect.arrayContaining([
        "kimi_auth_missing",
        "kimi_hello_probe_auth_required",
      ]),
    );
  });
});
