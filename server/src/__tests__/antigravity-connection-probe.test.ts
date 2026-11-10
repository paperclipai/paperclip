import { access, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), admission: vi.fn(), credentials: vi.fn(), copyBack: vi.fn(), remove: vi.fn(), turn: vi.fn(), warn: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../vendor/paperclip-runner/index.js", async original => ({
  ...await original<object>(), probeNativeRunnerEnvironment: mocks.probe,
}));
vi.mock("../services/native-runtime/acpx-qualification.js", () => ({ resolveAntigravityCandidateAdmission: mocks.admission }));
vi.mock("../services/native-runtime/antigravity-runner-credentials.js", () => ({
  prepareAntigravityRunnerCredentials: mocks.credentials, antigravityCredentialTurn: mocks.turn,
}));
vi.mock("../services/native-runtime/native-codex-runner.js", () => ({ resolvePaperclipRunnerBinary: () => "/owned/runnerd" }));
import { antigravityConnectionProbeFailure, testAntigravityConnection } from "../services/antigravity-connection-probe.js";
import { NativeEnvironmentProbeCleanupError, resolveAcpxRuntimeRoot } from "../vendor/paperclip-runner/index.js";

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
    expect(mocks.admission).toHaveBeenCalledExactlyOnceWith({ companyId: "company-1", model });
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
    await expect(testAntigravityConnection({ ...context, executionTarget: { kind: "remote" } as AdapterEnvironmentTestContext["executionTarget"] }, model))
      .rejects.toThrow("requires the Paperclip host");
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
