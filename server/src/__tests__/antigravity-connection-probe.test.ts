import { access, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), pluginProbe: vi.fn(), admission: vi.fn(), remoteAdmitted: vi.fn(() => false), credentials: vi.fn(), copyBack: vi.fn(), remove: vi.fn(), turn: vi.fn(), warn: vi.fn(),
  shell: vi.fn(), released: false }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../vendor/paperclip-runner/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../vendor/paperclip-runner/index.js")>();
  // Tests keep mocks.released = false for the pending-candidate suite and flip mocks.released = true for the qualified release suite.
  const pending = { ...original.QUALIFIED_ACPX_PROFILES.antigravity, qualificationStatus: "pending" as const };
  const profiles = { ...original.QUALIFIED_ACPX_PROFILES };
  Object.defineProperty(profiles, "antigravity", { enumerable: true,
    get: () => mocks.released ? original.QUALIFIED_ACPX_PROFILES.antigravity : pending });
  return { ...original, QUALIFIED_ACPX_PROFILES: profiles, probeNativeRunnerEnvironment: mocks.probe };
});
vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => ({
  ...await importOriginal<object>(), runAdapterExecutionTargetShellCommand: mocks.shell,
}));
vi.mock("../services/native-runtime/remote-provider-pack.js", async importOriginal => ({
  ...await importOriginal<object>(), ANTIGRAVITY_PATCHED_CLOSURE_SHA256: { "linux-x64": "b".repeat(64) },
}));
vi.mock("../services/native-runtime/acpx-qualification.js", () => ({ resolveAntigravityCandidateAdmission: mocks.admission,
  antigravityRemoteCandidateAdmitted: mocks.remoteAdmitted }));
vi.mock("../services/native-runtime/antigravity-runner-credentials.js", () => ({
  prepareAntigravityRunnerCredentials: mocks.credentials, antigravityCredentialTurn: mocks.turn,
}));
vi.mock("../services/native-runtime/native-codex-runner.js", () => ({
  resolvePaperclipRunnerBinary: () => "/owned/runnerd",
  resolvePaperclipRunnerBinaryAsync: async () => "/owned/runnerd",
}));
vi.mock("../services/native-runtime/plugin-runner-probe.js", () => ({
  probePluginRunnerEnvironment: mocks.pluginProbe,
}));
import { antigravityConnectionProbeFailure, testAntigravityConnection } from "../services/antigravity-connection-probe.js";
import { NativeEnvironmentProbeCleanupError, QUALIFIED_ACPX_PROFILES, resolveAcpxRuntimeRoot } from "../vendor/paperclip-runner/index.js";

const model = "exact-google-model";
const admission = { agent: "antigravity", model, companyId: "company-1" };
const roots: string[] = [];
const context: AdapterEnvironmentTestContext = { companyId: "company-1", adapterType: "paperclip_runner",
  config: { provider: "acpx", acpxAgent: "antigravity", model, env: { GEMINI_HOME: "/selected/provider", PATH: "/selected/bin" } },
  managedAiCredentialHome: "/selected/provider", executionTarget: null,
};
const receipt = { provider: "acpx", providerDriver: "acpx_runtime", effectiveModel: model,
  sessionAdmissionPassed: true, admissionOnly: true, helloProbePassed: false };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admission.mockReturnValue(admission);
  mocks.credentials.mockImplementation(async input => ({ environment: { ...input.environment, PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "fixture-managed-credential" }, home: "/selected/provider", credential: "fixture-managed-credential" }));
  mocks.turn.mockImplementation(() => ({ copyBack: mocks.copyBack, remove: mocks.remove }));
  mocks.probe.mockImplementation(async options => {
    roots.push(options.runtimeDirectory);
    await options.onCleanupConfirmed();
    return receipt;
  });
});
afterEach(async () => {
  mocks.released = false;
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Google Antigravity setup admission", () => {
  it("reports the observed installation failure with a repair action and only closed server diagnostics", () => {
    const privateValue = "fixture-private-token /private/selected-google-home";
    const error = new Error(privateValue);
    Object.defineProperty(error, "runnerCommandResult", { value: { commandType: "session.open", status: "failed", request: privateValue,
      result: { code: "command_execution_failed", message: "failed to start ACPX provider: ACPX sidecar command session.open was rejected (retryable=false, classification=admission_installation)" } } });
    const result = antigravityConnectionProbeFailure("company-1", error);
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "antigravity_installation_check_failed",
      message: "Paperclip could not complete the local Google Antigravity installation check.", hint: expect.stringContaining("instance operator") }] });
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith({ companyId: "company-1", code: "antigravity_installation_check_failed",
      errorClass: "Error", commandCode: "command_execution_failed", classification: "admission_installation", retryable: false },
    "Antigravity installation check failed before account verification");
    expect(JSON.stringify([result, mocks.warn.mock.calls])).not.toMatch(/fixture-private-token|\/private\/selected-google-home/);
    expect(JSON.stringify(result)).not.toMatch(/reconnect|sign in/i);
  });

  it("logs the closed instructions admission classification without treating it as an installation failure", () => {
    const error = new Error("fixture-private-token");
    Object.defineProperty(error, "runnerCommandResult", { value: { commandType: "session.open", status: "failed",
      result: { code: "command_execution_failed", message: "failed to start ACPX provider: ACPX sidecar command session.open was rejected (retryable=false, classification=admission_instructions)" } } });
    expect(antigravityConnectionProbeFailure("company-1", error).checks[0].code).toBe("antigravity_admission_failed");
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ commandCode: "command_execution_failed",
      classification: "admission_instructions", retryable: false }), "Antigravity runtime admission check failed");
  });

  it("does not parse outer serialized errors or copy unknown codes, classes or native output", () => {
    const privateValue = "fixture-private-token /private/selected-google-home";
    for (const native of [{ code: privateValue, message: privateValue }, { code: "command_execution_failed",
      message: "failed to start ACPX provider: ACPX sidecar command session.open was rejected (retryable=false, classification=admission_installation)" + privateValue }]) {
      const nativeMessage = native.message;
      const error = new Error(`PRP command session.open failed: ${nativeMessage}`);
      error.name = privateValue;
      Object.defineProperty(error, "runnerCommandResult", { value: { commandType: "session.open", status: "failed",
        result: native } });
      const result = antigravityConnectionProbeFailure("company-1", error);
      expect(result.checks[0].code).toBe("antigravity_admission_failed");
      expect(JSON.stringify([result, mocks.warn.mock.calls])).not.toMatch(/fixture-private-token|\/private\/selected-google-home/);
    }
    const rawOnly = new Error('PRP command session.open failed: {"code":"command_execution_failed","classification":"admission_installation"}');
    expect(antigravityConnectionProbeFailure("company-1", rawOnly).checks[0].code).toBe("antigravity_admission_failed");
  });

  it("preserves physical cleanup ownership instead of converting its typed error into a connection result", () => {
    const retired = Promise.resolve();
    const error = new NativeEnvironmentProbeCleanupError(retired, new Error("fixture-private-token"), [new Error("fixture private path")]);
    expect(() => antigravityConnectionProbeFailure("company-1", error)).toThrow(error);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(error.retired).toBe(retired);
  });

  it("uses the selected managed account, exact candidate and a private runtime without a model turn", async () => {
    vi.stubEnv("GEMINI_API_KEY", "ambient-key-must-not-enter");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/ambient-google-credential");
    const order: string[] = [];
    mocks.copyBack.mockImplementation(async () => { order.push("copy-back"); });
    mocks.remove.mockImplementation(async () => { order.push("scrub"); });
    let root = "";
    mocks.probe.mockImplementation(async options => {
      root = options.runtimeDirectory; roots.push(root);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(options.transportOptions.acpxRuntimeDirectory)).mode & 0o777).toBe(0o700);
      expect(options).toMatchObject({ provider: "acpx", model, admissionOnly: true,
        environment: { PATH: "/selected/bin", PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: "fixture-managed-credential" },
        transportOptions: { runnerBinary: "/owned/runnerd", acpxAgent: "antigravity", acpxCandidateAdmission: admission,
          acpxPermissionMode: "approve-reads", acpxPermissionModePinned: true } });
      expect(options.environment.GEMINI_API_KEY).toBeUndefined();
      expect(options.environment.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
      const identity = options.transportOptions.prpIdentity;
      const nativeHome = join(await resolveAcpxRuntimeRoot(options.transportOptions.acpxRuntimeDirectory, identity.normalizedSessionId), "antigravity-home");
      expect(mocks.turn).toHaveBeenCalledWith({ managedHome: "/selected/provider", runtimeHome: nativeHome, credential: "fixture-managed-credential" });
      await mkdir(nativeHome, { recursive: true });
      order.push("retired");
      await options.onCleanupConfirmed();
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      return receipt;
    });
    const result = await testAntigravityConnection(context, model);
    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "antigravity_metadata_verified" }));
    expect(mocks.admission).toHaveBeenCalledExactlyOnceWith({ companyId: "company-1", model, target: { platform: process.platform, architecture: process.arch } });
    expect(mocks.credentials).toHaveBeenCalledWith(expect.objectContaining({ managedHome: "/selected/provider", remote: false, lifecycleMode: "per_turn" }));
    expect(order).toEqual(["retired", "copy-back", "scrub"]);
  });

  it.each(["effectiveModel", "providerDriver", "sessionAdmissionPassed", "admissionOnly", "helloProbePassed"] as const)("rejects a mismatched %s receipt after cleanup", async field => {
    mocks.probe.mockImplementation(async options => {
      roots.push(options.runtimeDirectory);
      await options.onCleanupConfirmed();
      return { ...receipt, [field]: typeof receipt[field] === "string" ? "different" : !receipt[field] };
    });
    await expect(testAntigravityConnection(context, model)).rejects.toThrow("no matching account and model admission receipt");
    expect(mocks.copyBack).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("rejects an unavailable company or remote target before reading credentials or launching native code", async () => {
    mocks.admission.mockReturnValue(undefined);
    await expect(testAntigravityConnection(context, model)).rejects.toThrow("not available for this company");
    const remote = await testAntigravityConnection({ ...context, executionTarget: { kind: "remote" } as AdapterEnvironmentTestContext["executionTarget"] }, model);
    expect(remote).toMatchObject({ status: "fail", checks: [{ code: "antigravity_remote_unavailable", message: expect.stringMatching(/only on the Paperclip host/) }] });
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.shell).not.toHaveBeenCalled();
  });
});

describe("Google Antigravity cloud candidate while pending", () => {
  const remoteTarget = { kind: "remote", transport: "ssh", remoteCwd: "/workspace" } as unknown as AdapterEnvironmentTestContext["executionTarget"];
  const apiKeyContext = { ...context, managedAiCredentialHome: undefined,
    config: { ...context.config, env: { GEMINI_API_KEY: "fixture-google-key" } }, executionTarget: remoteTarget };
  const pendingEntry = () => ({ version: QUALIFIED_ACPX_PROFILES.antigravity.agentServerVersion, profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest,
    closureDigest: `sha256:${"b".repeat(64)}`, qualification: "pending", path: "provider-assets/antigravity/linux-x64", sha256: `sha256:${"c".repeat(64)}` });
  const pendingManifest = (providers: Record<string, unknown>) => ["Linux", "x86_64", JSON.stringify({
    schema: "paperclip-runner/remote-provider-pack/v1", payload: { target: { platform: "linux", architecture: "x64" }, ...providers } })].join("\n");
  afterEach(() => { mocks.remoteAdmitted.mockReset(); mocks.remoteAdmitted.mockReturnValue(false); });

  it("checks the cloud candidate pack for an API key the operator granted this company and model", async () => {
    mocks.remoteAdmitted.mockReturnValue(true);
    mocks.shell.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: pendingManifest({ candidateProviders: { antigravity: pendingEntry() } }), stderr: "" });
    expect(await testAntigravityConnection(apiKeyContext, model)).toMatchObject({ status: "warn", checks: [{ code: "antigravity_remote_runtime_ready" }] });
    expect(mocks.remoteAdmitted).toHaveBeenCalledWith({ companyId: "company-1", model });
    mocks.shell.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: pendingManifest({ providers: { antigravity: { ...pendingEntry(), qualification: "qualified" } } }), stderr: "" });
    expect((await testAntigravityConnection(apiKeyContext, model)).status).toBe("fail");
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  it("refuses Google sign-in in the cloud even with a grant, refuses plugin Runner-task targets while pending, and refuses any cloud run without a grant", async () => {
    mocks.remoteAdmitted.mockReturnValue(true);
    expect(await testAntigravityConnection({ ...context, executionTarget: remoteTarget }, model))
      .toMatchObject({ status: "fail", checks: [{ code: "antigravity_remote_sign_in_unsupported" }] });
    const pluginTarget = { kind: "remote", transport: "sandbox", remoteCwd: ".", leaseId: "lease-1",
      runnerTaskProbe: { runId: "run-1", sessionId: "session-1" }, runnerTask: vi.fn() } as unknown as AdapterEnvironmentTestContext["executionTarget"];
    expect(await testAntigravityConnection({ ...apiKeyContext, executionTarget: pluginTarget }, model))
      .toMatchObject({ status: "fail", checks: [{ code: "antigravity_remote_unavailable" }] });
    expect(mocks.pluginProbe).not.toHaveBeenCalled();
    mocks.remoteAdmitted.mockReturnValue(false);
    expect(await testAntigravityConnection(apiKeyContext, model))
      .toMatchObject({ status: "fail", checks: [{ code: "antigravity_remote_unavailable" }] });
    expect(mocks.shell).not.toHaveBeenCalled();
  });
});

describe("Google Antigravity setup admission after the release flip", () => {
  const remoteTarget = { kind: "remote", transport: "ssh", remoteCwd: "/workspace" } as unknown as AdapterEnvironmentTestContext["executionTarget"];
  const apiKeyContext = { ...context, managedAiCredentialHome: undefined,
    config: { ...context.config, env: { GEMINI_API_KEY: "fixture-google-key" } }, executionTarget: remoteTarget };
  const manifest = (antigravity: Record<string, unknown>, extra: Record<string, unknown> = {}) => ["Linux", "x86_64", JSON.stringify({
    schema: "paperclip-runner/remote-provider-pack/v1", payload: { target: { platform: "linux", architecture: "x64" }, providers: { antigravity }, ...extra } })].join("\n");
  const entry = () => ({ version: QUALIFIED_ACPX_PROFILES.antigravity.agentServerVersion, profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest,
    closureDigest: `sha256:${"b".repeat(64)}`, qualification: "qualified", path: "provider-assets/antigravity/linux-x64", sha256: `sha256:${"c".repeat(64)}` });
  beforeEach(() => { mocks.released = true; });

  it("verifies the local connection without a candidate grant", async () => {
    mocks.admission.mockReturnValue(undefined);
    const result = await testAntigravityConnection(context, model);
    expect(result.status).toBe("pass");
    expect(mocks.admission).not.toHaveBeenCalled();
    expect(mocks.probe.mock.calls[0][0].transportOptions.acpxCandidateAdmission).toBeUndefined();
  });

  it("checks the cloud image's patched Antigravity runtime for Google sign-in once released without sending credentials or a prompt", async () => {
    mocks.shell.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: manifest(entry()), stderr: "" });
    const result = await testAntigravityConnection({ ...context, executionTarget: remoteTarget }, model);
    expect(result).toMatchObject({ status: "warn", checks: [{ code: "antigravity_remote_runtime_ready",
      message: expect.stringContaining("Google sign-in") }] });
    const [, , command, options] = mocks.shell.mock.calls[0];
    expect(options.env).toEqual({});
    expect(command).not.toContain("/selected/provider");
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  it("delegates plugin Runner-task targets to probePluginRunnerEnvironment for both Gemini API key and Google sign-in once released", async () => {
    const pluginTarget = { kind: "remote", transport: "sandbox", remoteCwd: ".", leaseId: "lease-1",
      runnerTaskProbe: { runId: "run-1", sessionId: "session-1" }, runnerTask: vi.fn() } as unknown as AdapterEnvironmentTestContext["executionTarget"];
    const verified = { adapterType: "paperclip_runner", status: "pass" as const, testedAt: new Date(0).toISOString(),
      checks: [{ code: "antigravity_metadata_verified", level: "info" as const, message: "Verified." }] };
    mocks.pluginProbe.mockResolvedValue(verified);

    const apiKeyPluginContext: AdapterEnvironmentTestContext = {
      ...apiKeyContext,
      config: { ...apiKeyContext.config, managedAiConnection: { identity: "key-id", sessionIdentity: "key-session" } },
      executionTarget: pluginTarget,
    };
    expect(await testAntigravityConnection(apiKeyPluginContext, model)).toEqual(verified);
    expect(mocks.pluginProbe).toHaveBeenCalledWith(apiKeyPluginContext, { identity: "key-id", accountIdentity: "key-session", home: undefined });

    const signInPluginContext: AdapterEnvironmentTestContext = {
      ...context,
      config: { ...context.config, managedAiConnection: { identity: "google-id", sessionIdentity: "google-session" } },
      executionTarget: pluginTarget,
    };
    expect(await testAntigravityConnection(signInPluginContext, model)).toEqual(verified);
    expect(mocks.pluginProbe).toHaveBeenLastCalledWith(signInPluginContext, { identity: "google-id", accountIdentity: "google-session", home: "/selected/provider" });
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it("checks the cloud image's patched Antigravity runtime for an API key without sending the key or a prompt", async () => {
    mocks.shell.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: manifest(entry()), stderr: "" });
    const result = await testAntigravityConnection(apiKeyContext, model);
    expect(result).toMatchObject({ status: "warn", checks: [{ code: "antigravity_remote_runtime_ready" }] });
    const [, , command, options] = mocks.shell.mock.calls[0];
    expect(options.env).toEqual({});
    expect(command).not.toContain("fixture-google-key");
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.credentials).not.toHaveBeenCalled();
  });

  it.each([
    ["the vendor closure", manifest({ ...entry(), closureDigest: `sha256:${"e".repeat(64)}` })],
    ["a pending entry", manifest({ ...entry(), qualification: "pending" })],
    ["an entry in both inventories", manifest(entry(), { candidateProviders: { antigravity: entry() } })],
    ["an older profile", manifest({ ...entry(), profileDigest: `sha256:${"f".repeat(64)}` })],
    ["an ARM host", manifest(entry()).replace("x86_64", "aarch64")],
  ])("refuses %s", async (_name, stdout) => {
    mocks.shell.mockResolvedValue({ exitCode: 0, timedOut: false, stdout, stderr: "" });
    expect((await testAntigravityConnection(apiKeyContext, model)).status).toBe("fail");
  });

  it("reports a missing pack in plain language", async () => {
    mocks.shell.mockResolvedValue({ exitCode: 127, timedOut: false, stdout: "", stderr: "" });
    expect(await testAntigravityConnection(apiKeyContext, model)).toMatchObject({ status: "fail",
      checks: [{ code: "antigravity_remote_runtime_missing" }] });
  });
});
