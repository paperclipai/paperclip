import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agents, type Db } from "@paperclipai/db";
import type { LifecycleAgent } from "../modules/agent-lifecycle/index.js";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { NativeEnvironmentProbeCleanupError } from "../vendor/paperclip-runner/index.js";
import { agentHarnessVerificationService } from "./agent-harness-verification.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { ResolvedRunnerHarness } from "./runner-harness-registry.js";

const state = vi.hoisted(() => ({
  registry: { resolve: vi.fn() },
  probe: vi.fn(),
  builtin: vi.fn(),
  secrets: { resolveAdapterConfigForRuntime: vi.fn(), resolveEnvBindings: vi.fn() },
  tests: { resolveAdapterTestEnvironmentId: vi.fn(), assertAdapterTestEnvironmentForCompany: vi.fn(),
    resolveAdapterTestExecutionContext: vi.fn(), testManagedEnvironment: vi.fn() },
  release: vi.fn(),
}));
vi.mock("./runner-harness-registry.js", async importOriginal => ({
  ...await importOriginal<typeof import("./runner-harness-registry.js")>(), runnerHarnessRegistry: () => state.registry,
}));
vi.mock("./native-runtime/extension-runtime.js", () => ({ probeInstalledRunnerHarness: state.probe }));
vi.mock("../adapters/index.js", () => ({ requireServerAdapter: state.builtin }));
vi.mock("./agent-environment-test.js", () => ({ agentEnvironmentTestService: () => state.tests }));
vi.mock("./secrets.js", () => ({ secretService: () => state.secrets }));
vi.mock("./environments.js", () => ({ environmentService: () => ({}) }));

const resolved: ResolvedRunnerHarness = {
  pluginId: "installed-plugin", pluginKey: "example.native", packageRoot: "/installed/package", entrypoint: "/installed/package/runtime.js",
  release: { harnessId: "example.native/coding", packageName: "@example/plugin-coding", version: "1.0.0", protocolVersion: 1,
    integrity: `sha256-${Buffer.alloc(32, 1).toString("base64")}`, runtimeDigest: `sha256:${"a".repeat(64)}` },
  declaration: { harnessKey: "coding", displayName: "Example harness", platforms: ["linux-x64"], capabilities: {},
    configSchema: { type: "object", properties: { mode: { enum: ["coding", "review"] } }, required: ["mode"], additionalProperties: false },
    runtime: { entrypoint: "runtime.js", sha256: `sha256:${"a".repeat(64)}` },
    credentials: [{ key: "EXAMPLE_API_KEY", displayName: "API key", required: true }] },
};
const passed: AdapterEnvironmentTestResult = { adapterType: "paperclip_runner", status: "pass", testedAt: new Date(0).toISOString(),
  checks: [{ code: "runner_extension_probe_passed", level: "info", message: "Exact installed harness and model verified" }] };

function fixture() {
  const agent = { id: randomUUID(), companyId: "company", lifecycleVersion: 1, adapterType: "paperclip_runner",
    adapterConfig: { provider: "extension", harnessId: resolved.release.harnessId, model: "selected-model", extensionConfig: { mode: "coding" },
      env: { EXAMPLE_API_KEY: { type: "secret_ref", secretId: "selected-secret" } } },
    runtimeConfig: {} as Record<string, unknown>, defaultEnvironmentId: null, lifecycleOperation: { responsibleUserId: "responsible-user" },
  };
  const database = { select: () => ({ from: (table: unknown) => ({ where: async () => table === agents
    ? [agent] : [{ defaultResponsibleUserId: "responsible-user" }] }) }) } as unknown as Db;
  const verify = () => agentHarnessVerificationService(database, {} as PluginWorkerManager).verify(agent as unknown as LifecycleAgent);
  return { agent, database, verify };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.registry.resolve.mockResolvedValue(resolved);
  state.probe.mockResolvedValue(passed);
  state.release.mockResolvedValue(undefined);
  state.secrets.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId: string, config: Record<string, unknown>) => ({
    config: { ...config, env: { EXAMPLE_API_KEY: "resolved-selected-key" } },
  }));
  state.tests.resolveAdapterTestEnvironmentId.mockResolvedValue(null);
  state.tests.resolveAdapterTestExecutionContext.mockResolvedValue({ executionTarget: null, environmentName: "Local", fallbackChecks: [], release: state.release });
});

describe("installed native harness lifecycle verification", () => {
  it("verifies the installed extension with resolved declared credentials through its native probe", async () => {
    const { agent, database, verify } = fixture();
    await expect(verify()).resolves.toBe("complete");
    expect(state.registry.resolve).toHaveBeenCalledExactlyOnceWith(agent.companyId, resolved.release.harnessId);
    expect(state.probe).toHaveBeenCalledExactlyOnceWith(database, expect.objectContaining({ companyId: agent.companyId,
      config: { ...agent.adapterConfig, env: { EXAMPLE_API_KEY: "resolved-selected-key" } } }));
    expect(state.builtin).not.toHaveBeenCalled();
    expect(state.tests.testManagedEnvironment).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledExactlyOnceWith("released");
  });

  it.each(["unavailable", "settings", "credential-key", "model", "ai-binding"])("rejects %s before secrets, environment allocation, or any probe", async mode => {
    const { agent, verify } = fixture();
    if (mode === "unavailable") state.registry.resolve.mockRejectedValueOnce(new Error("Installed package was disabled"));
    if (mode === "settings") agent.adapterConfig.extensionConfig.mode = "not-declared";
    if (mode === "credential-key") Object.assign(agent.adapterConfig.env, { NODE_OPTIONS: "--require=untrusted" });
    if (mode === "model") agent.adapterConfig.model = "";
    if (mode === "ai-binding") agent.runtimeConfig.aiConnection = { mode: "router", connectionId: "built-in-pool" };
    await expect(verify()).rejects.toBeInstanceOf(Error);
    expect(state.secrets.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(state.tests.resolveAdapterTestExecutionContext).not.toHaveBeenCalled();
    expect(state.probe).not.toHaveBeenCalled();
    expect(state.builtin).not.toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
  });

  it.each([
    { status: "pass", checks: [] },
    { status: "pass", checks: [{ code: "codex_hello_probe_succeeded", level: "info", message: "Unrelated builtin" }] },
    { status: "warn", checks: passed.checks },
    { status: "fail", checks: passed.checks },
  ] satisfies Array<Pick<AdapterEnvironmentTestResult, "status" | "checks">>)("requires an explicit successful extension receipt: %j", async supplied => {
    state.probe.mockResolvedValueOnce({ ...passed, ...supplied });
    await expect(fixture().verify()).rejects.toMatchObject({ code: "harness_test_failed" });
    expect(state.release).toHaveBeenCalledExactlyOnceWith("failed");
  });

  it("retains the environment lease until the extension probe's cleanup owner confirms retirement", async () => {
    let confirmRetirement!: () => void;
    const retired = new Promise<void>(resolve => { confirmRetirement = resolve; });
    const failure = new NativeEnvironmentProbeCleanupError(retired, new Error("Synthetic pending child"), [], async () => retired);
    state.probe.mockRejectedValueOnce(failure);
    try {
      await expect(fixture().verify()).rejects.toBe(failure);
      expect(state.release).not.toHaveBeenCalled();
      confirmRetirement();
      await vi.waitFor(() => expect(state.release).toHaveBeenCalledExactlyOnceWith("failed"));
    } finally { confirmRetirement(); }
  });
});
