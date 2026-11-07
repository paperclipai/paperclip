import { beforeEach, describe, expect, it, vi } from "vitest";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
const mocks = vi.hoisted(() => ({ metadata: vi.fn(), command: vi.fn(), environment: vi.fn(), bindings: vi.fn(), acquire: vi.fn(), realize: vi.fn(), release: vi.fn(), resolve: vi.fn(), general: vi.fn(), experimental: vi.fn(), defaults: vi.fn(), kubernetes: vi.fn(), managed: vi.fn(), supportsTasks: vi.fn(), updateLeaseMetadata: vi.fn() }));
vi.mock("../vendor/paperclip-runner/live/index.js", async importOriginal => ({ ...await importOriginal<object>(), probeCopilotMetadata: mocks.metadata }));
vi.mock("@paperclipai/adapter-utils/execution-target", () => ({ runAdapterExecutionTargetShellCommand: mocks.command }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/environments.js", () => ({ environmentService: () => ({ getById: mocks.environment, listBoundCompanyIds: mocks.bindings, findKubernetesEnvironment: mocks.kubernetes, findManagedSandboxEnvironment: mocks.managed, updateLeaseMetadata: mocks.updateLeaseMetadata }) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({ get: mocks.defaults, getGeneral: mocks.general, getExperimental: mocks.experimental }) }));
vi.mock("../services/environment-runtime.js", () => ({ environmentRuntimeService: vi.fn(() => ({ acquireRunLease: mocks.acquire, supportsTasks: mocks.supportsTasks, realizeWorkspace: mocks.realize, getDriver: () => ({ releaseRunLease: mocks.release }) })) }));
vi.mock("../services/environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: mocks.resolve }));
import { logger } from "../middleware/logger.js";
import { probeCopilotConnection, probeCopilotExecutionTarget } from "../services/copilot-connection-probe.js";
import { QUALIFIED_ACPX_PROFILES } from "../../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import type { Db } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
const verified = { status: "verified", version: "1.0.88", profileDigest: QUALIFIED_ACPX_PROFILES.copilot.commandDigest, promptSent: false, models: [{ id: "gpt-5.6-luna", label: "GPT" }] };
const remote = { kind: "remote", remoteCwd: "/workspace" } as AdapterExecutionTarget;
beforeEach(() => {
  vi.clearAllMocks(); mocks.command.mockReset(); mocks.general.mockResolvedValue({ executionMode: "local" }); mocks.experimental.mockResolvedValue({}); mocks.defaults.mockResolvedValue({ defaultEnvironmentId: null });
  mocks.environment.mockResolvedValue({ id: "selected", driver: "sandbox", status: "active", config: { provider: "daytona" } }); mocks.bindings.mockResolvedValue(["company"]);
  mocks.supportsTasks.mockResolvedValue(false);
  mocks.updateLeaseMetadata.mockImplementation(async (id, metadata) => ({ id, metadata }));
  mocks.acquire.mockResolvedValue({ lease: { id: "lease", metadata: {} } }); mocks.realize.mockResolvedValue({}); mocks.release.mockResolvedValue(undefined); mocks.resolve.mockResolvedValue(remote);
  mocks.command.mockResolvedValue({ timedOut: false, stdout: JSON.stringify(verified), exitCode: 0 }); mocks.metadata.mockResolvedValue(verified);
});
describe("Copilot connection verification", () => {
  it.each(["ssh", "sandbox", "plugin"])("keeps an explicitly selected %s environment under managed-only execution", async driver => {
    mocks.experimental.mockResolvedValue({ enableManagedSandboxOnly: true });
    mocks.environment.mockResolvedValue({ id: "selected", driver, status: "active", config: { provider: "daytona" } });
    expect(await probeCopilotConnection({} as Db, "company", "private-token", "selected")).toEqual(verified);
    expect(mocks.managed).not.toHaveBeenCalled();
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ environment: expect.objectContaining({ id: "selected", driver }) }));
    expect(mocks.metadata).not.toHaveBeenCalled();
    expect(mocks.command).toHaveBeenCalledOnce();
  });
  it.each([null, "local"])("redirects only a local selection (%s) onto the managed environment", async selection => {
    mocks.experimental.mockResolvedValue({ enableManagedSandboxOnly: true });
    mocks.managed.mockResolvedValue({ id: "managed" });
    mocks.environment.mockImplementation(async id => ({ id, driver: id === "local" ? "local" : "sandbox", status: "active", config: { provider: "daytona" } }));
    expect(await probeCopilotConnection({} as Db, "company", "private-token", selection)).toEqual(verified);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ environment: expect.objectContaining({ id: "managed" }) }));
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
  it("gives forced Kubernetes precedence over an explicitly selected remote and managed-only policy", async () => {
    mocks.general.mockResolvedValue({ executionMode: "kubernetes" });
    mocks.experimental.mockResolvedValue({ enableManagedSandboxOnly: true });
    mocks.kubernetes.mockResolvedValue({ id: "kubernetes" });
    mocks.environment.mockImplementation(async id => ({ id, driver: "sandbox", status: "active", config: { provider: "kubernetes" } }));
    expect(await probeCopilotConnection({} as Db, "company", "private-token", "selected")).toEqual(verified);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ environment: expect.objectContaining({ id: "kubernetes" }) }));
    expect(mocks.managed).not.toHaveBeenCalled();
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
  it("probes the selected environment and releases its owned lease", async () => {
    const db = {} as Db;
    const pluginWorkerManager = {} as PluginWorkerManager;
    expect(await probeCopilotConnection(db, "company", "private-token", "selected", "gpt-5.6-luna", { pluginWorkerManager })).toEqual(verified);
    expect(environmentRuntimeService).toHaveBeenCalledWith(db, { pluginWorkerManager });
    expect(mocks.metadata).not.toHaveBeenCalled(); expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.command.mock.calls[0]![3]).toMatchObject({ env: { COPILOT_GITHUB_TOKEN: "private-token", PAPERCLIP_COPILOT_PROBE_MODEL: "gpt-5.6-luna" }, timeoutSec: 35 });
    expect(mocks.command.mock.calls[0]![2]).not.toContain("private-token");
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ status: "released" }));
  });
  it("uses a private task probe for Copilot metadata without a shell or model prompt", async () => {
    mocks.environment.mockResolvedValue({ id: "selected", driver: "plugin", status: "active", config: {} });
    mocks.supportsTasks.mockResolvedValue(true);
    const runnerTask = vi.fn(async () => ({ kind: "copilot_metadata", taskId: "task", metadata: verified, executionStopped: true }));
    const target = { kind: "remote", transport: "sandbox", remoteCwd: ".", runnerTask } as const;
    mocks.resolve.mockResolvedValue(target);
    expect(await probeCopilotConnection({} as Db, "company", "private-token", "selected", "gpt-5.6-luna", { targetAgentId: "saved-agent" })).toEqual(verified);
    expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({ agentId: "saved-agent" }));
    expect(runnerTask).toHaveBeenCalledWith({ kind: "copilot_metadata", token: "private-token", model: "gpt-5.6-luna" });
    expect(mocks.updateLeaseMetadata).toHaveBeenCalledWith("lease", expect.objectContaining({ runnerTaskProbe: expect.objectContaining({ runId: expect.any(String) }) }));
    expect(mocks.realize).not.toHaveBeenCalled(); expect(mocks.command).not.toHaveBeenCalled(); expect(mocks.metadata).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ status: "released" }));
    runnerTask.mockResolvedValueOnce({ kind: "copilot_metadata", taskId: "task", metadata: { ...verified, profileDigest: "stale" }, executionStopped: true });
    await expect(probeCopilotExecutionTarget("private-token", target, "gpt-5.6-luna")).rejects.toThrow();
  });
  it("rejects a foreign company before creating a lease or transmitting the token", async () => {
    mocks.bindings.mockResolvedValue(["other-company"]);
    await expect(probeCopilotConnection({} as Db, "company", "private-token", "selected")).rejects.toMatchObject({ status: 403 });
    expect(mocks.command).not.toHaveBeenCalled(); expect(mocks.metadata).not.toHaveBeenCalled(); expect(mocks.acquire).not.toHaveBeenCalled();
  });
  it("does not fall back to host credentials when the remote runtime is missing", async () => {
    mocks.command.mockResolvedValue({ timedOut: false, stdout: "", exitCode: 127 });
    await expect(probeCopilotConnection({} as Db, "company", "private-token", "selected")).rejects.toMatchObject({ details: { code: "COPILOT_INSTALLATION_INVALID" } });
    expect(mocks.metadata).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
  it("sanitizes remote errors and releases the lease on authentication failure", async () => {
    mocks.command.mockResolvedValue({ timedOut: false, stdout: JSON.stringify({ status: "failed", code: "COPILOT_AUTH_REQUIRED", promptSent: false, message: "private-token" }), exitCode: 1 });
    const error = await probeCopilotConnection({} as Db, "company", "private-token", "selected").catch(e => e);
    expect(error.details.code).toBe("COPILOT_AUTH_REQUIRED"); expect(error.message).not.toContain("private-token"); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("preserves authentication classification when lease cleanup also fails", async () => {
    mocks.command.mockResolvedValue({ timedOut: false, stdout: JSON.stringify({ status: "failed", code: "COPILOT_AUTH_REQUIRED", promptSent: false, message: "private-token" }), exitCode: 1 });
    mocks.release.mockRejectedValue(new Error("cleanup private-token"));
    const error = await probeCopilotConnection({} as Db, "company", "private-token", "selected").catch(e => e);
    expect(error).toMatchObject({ status: 422, details: { code: "COPILOT_AUTH_REQUIRED" } });
    expect(error.message).not.toContain("private-token");
    expect(logger.warn).toHaveBeenCalledWith({ companyId: "company", environmentId: "selected", leaseId: "lease", code: "COPILOT_PROBE_CLEANUP_FAILED" }, expect.any(String));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("private-token");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("does not verify a connection when its successful probe cannot clean up", async () => {
    mocks.release.mockRejectedValue(new Error("cleanup private-token"));
    const error = await probeCopilotConnection({} as Db, "company", "private-token", "selected").catch(e => e);
    expect(error).toMatchObject({ status: 422, details: { code: "COPILOT_REQUEST_FAILED", cleanupCode: "COPILOT_PROBE_CLEANUP_FAILED" } });
    expect(error.message).not.toContain("private-token");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("rejects stale profile results and unavailable model selections", async () => {
    mocks.command.mockResolvedValue({ timedOut: false, stdout: JSON.stringify({ ...verified, profileDigest: "stale" }), exitCode: 0 });
    await expect(probeCopilotExecutionTarget("private-token", remote)).rejects.toMatchObject({ details: { code: "COPILOT_REQUEST_FAILED" } });
    mocks.command.mockResolvedValue({ timedOut: false, stdout: JSON.stringify(verified), exitCode: 0 });
    await expect(probeCopilotExecutionTarget("private-token", remote, "missing")).rejects.toMatchObject({ details: { code: "COPILOT_MODEL_UNAVAILABLE" } });
  });
});

describe("remote Copilot installation fallback", () => {
  it.each(["missing", "incomplete", "stale-profile"])("uses the valid home pack after rejecting a %s opt pack", async variant => {
    const rejected = variant === "missing" ? { timedOut: false, stdout: "", exitCode: 127 }
      : { timedOut: false, exitCode: variant === "incomplete" ? 1 : 0, stdout: JSON.stringify(variant === "incomplete"
        ? { status: "failed", code: "COPILOT_INSTALLATION_INVALID", promptSent: false }
        : { ...verified, profileDigest: `sha256:${"0".repeat(64)}` }) };
    mocks.command.mockResolvedValueOnce(rejected).mockResolvedValueOnce({ timedOut: false, stdout: JSON.stringify(verified), exitCode: 0 });
    await expect(probeCopilotExecutionTarget("private-token", remote, "gpt-5.6-luna")).resolves.toEqual(verified);
    expect(mocks.command).toHaveBeenCalledTimes(2);
    expect(mocks.command.mock.calls[0]![2]).toContain("/opt/paperclip-runner/provider-pack");
    expect(mocks.command.mock.calls[1]![2]).toContain("$HOME/.local/share/paperclip-runner/provider-pack");
    for (const call of mocks.command.mock.calls) {
      expect(call[2]).not.toContain("private-token");
      expect(call[3].env).toMatchObject({ COPILOT_GITHUB_TOKEN: "private-token", PAPERCLIP_COPILOT_PROBE_MODEL: "gpt-5.6-luna" });
      expect(call[3].timeoutSec).toBeLessThanOrEqual(35);
    }
  });
  it.each(["COPILOT_AUTH_REQUIRED", "COPILOT_ENTITLEMENT_DENIED", "COPILOT_MODEL_UNAVAILABLE"])("keeps %s and does not try another installation", async code => {
    mocks.command.mockResolvedValueOnce({ timedOut: false, exitCode: 1, stdout: JSON.stringify({ status: "failed", code, promptSent: false }) });
    await expect(probeCopilotExecutionTarget("private-token", remote)).rejects.toMatchObject({ details: { code } });
    expect(mocks.command).toHaveBeenCalledOnce();
  });
});
