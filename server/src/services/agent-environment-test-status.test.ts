import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as executionTargets from "@paperclipai/adapter-utils/execution-target";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { environmentTaskErrorCodeData, JsonRpcCallError, PluginEnvironmentTaskError } from "@paperclipai/plugin-sdk";

const { runtimeProbe, claudeProbe, verifyKey, markAuthFailed } = vi.hoisted(() => ({
  runtimeProbe: vi.fn(), claudeProbe: vi.fn(), verifyKey: vi.fn(), markAuthFailed: vi.fn(),
}));
vi.mock("../adapters/index.js", () => ({ requireServerAdapter: (type: string) => ({ testEnvironment: type === "paperclip_runner" ? runtimeProbe : claudeProbe }) }));
vi.mock("./ai-api-key-test.js", () => ({ validateAiApiKey: verifyKey }));
vi.mock("./ai-connections.js", async original => ({ ...await original<typeof import("./ai-connections.js")>(), aiConnectionService: () => ({ markAuthenticationFailed: markAuthFailed }) }));
import { agentEnvironmentTestService } from "./agent-environment-test.js";
import { assertHarnessTestPassed } from "./agent-harness-verification.js";

const checkedAt = new Date(0).toISOString();
function readiness(): AdapterEnvironmentTestResult {
  return { adapterType: "paperclip_runner", status: "warn", testedAt: checkedAt, checks: [{
    code: "acpx_remote_runtime_unverified", level: "warn", message: "The remote platform is supported. Runtime package integrity and readiness must still be verified by the remote runner before launch.",
  }] };
}
const context: AdapterEnvironmentTestContext = { companyId: "company-1", adapterType: "paperclip_runner", environmentName: "Paperclip Sandbox",
  config: { provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5", env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-token" }, managedAiConnection: { method: "subscription" } },
  executionTarget: { kind: "remote" as const, transport: "sandbox" as const, providerKey: "daytona", leaseId: "lease-1", remoteCwd: "/workspace", runner: { execute: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "", stderr: "", signal: null }) } },
};
async function testConnection(overrides: Partial<AdapterEnvironmentTestContext> = {}) {
  const service = agentEnvironmentTestService({} as Db);
  return service.testManagedEnvironment("paperclip_runner", { ...context, ...overrides },
    { provider: "anthropic", method: "subscription", mode: "responsible_user" },
    { identity: "fixture-identity", attribution: { provider: "anthropic", connectionId: "connection-1", grantId: "grant-1" } } as Parameters<typeof service.testManagedEnvironment>[3]);
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.restoreAllMocks(); });
function verifiedClaude() {
  runtimeProbe.mockResolvedValue(readiness());
  claudeProbe.mockResolvedValue({ adapterType: "claude_local", status: "pass", testedAt: checkedAt,
    checks: [{ code: "claude_hello_probe_passed", level: "info", message: "Claude hello probe succeeded." }] });
}

describe("managed Runner connection test status", () => {
  it("projects the selected Google home for background verification and rejects a conflicting explicit home", async () => {
    const service = agentEnvironmentTestService({} as Db);
    const input = { companyId: "company-1", adapterType: "paperclip_runner", executionTarget: null,
      config: { provider: "acpx", acpxAgent: "antigravity", model: "exact-google-model", env: {}, managedAiConnection: { method: "subscription" } } };
    const binding = { provider: "google", method: "subscription", mode: "responsible_user" } as const;
    const managed = { home: join(tmpdir(), "selected-google"), identity: "fixture-identity",
      attribution: { provider: "google", connectionId: "connection-1", grantId: "grant-1" } } as Parameters<typeof service.testManagedEnvironment>[3];
    runtimeProbe.mockResolvedValue({ adapterType: "paperclip_runner", status: "pass", testedAt: checkedAt,
      checks: [{ code: "antigravity_metadata_verified", level: "info", message: "Native account and model accepted." }] });
    expect((await service.testManagedEnvironment("paperclip_runner", input, binding, managed)).status).toBe("pass");
    expect(runtimeProbe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ managedAiCredentialHome: join(tmpdir(), "selected-google", "provider") }));
    runtimeProbe.mockClear();
    await expect(service.testManagedEnvironment("paperclip_runner", { ...input, managedAiCredentialHome: join(tmpdir(), "other-google", "provider") }, binding, managed))
      .rejects.toThrow("does not match the selected managed account");
    expect(runtimeProbe).not.toHaveBeenCalled();
    expect(claudeProbe).not.toHaveBeenCalled();
  });
  it("accepts only the Antigravity native admission receipt without invoking another provider", async () => {
    const service = agentEnvironmentTestService({} as Db);
    const input = { companyId: "company-1", adapterType: "paperclip_runner", executionTarget: null,
      config: { provider: "acpx", acpxAgent: "antigravity", model: "exact-google-model", env: {}, managedAiConnection: { method: "subscription" } } };
    const binding = { provider: "google", method: "subscription", mode: "responsible_user" } as const;
    const managed = { identity: "fixture-identity", attribution: { provider: "google", connectionId: "connection-1", grantId: "grant-1" } } as Parameters<typeof service.testManagedEnvironment>[3];
    runtimeProbe.mockResolvedValue({ adapterType: "paperclip_runner", status: "pass", testedAt: checkedAt,
      checks: [{ code: "antigravity_metadata_verified", level: "info", message: "Native account and model accepted." }] });
    expect((await service.testManagedEnvironment("paperclip_runner", input, binding, managed)).status).toBe("pass");
    expect(claudeProbe).not.toHaveBeenCalled();
    expect(verifyKey).not.toHaveBeenCalled();
    runtimeProbe.mockResolvedValue({ adapterType: "paperclip_runner", status: "pass", testedAt: checkedAt, checks: [] });
    const missing = await service.testManagedEnvironment("paperclip_runner", input, binding, managed);
    expect(missing.status).toBe("fail");
    expect(missing.checks).toContainEqual(expect.objectContaining({ code: "ai_connection_validation_incomplete" }));
    expect(claudeProbe).not.toHaveBeenCalled();
  });
  it("binds the Codex credential home to the prepared managed runtime", async () => {
    const service = agentEnvironmentTestService({} as Db);
    const home = join(tmpdir(), "selected-codex-runtime");
    const input: AdapterEnvironmentTestContext = { companyId: "company-1", adapterType: "paperclip_runner", config: { provider: "codex", env: {} } };
    const binding = { provider: "openai", method: "subscription", mode: "responsible_user" } as const;
    const managed = { home, identity: "fixture-identity", attribution: { provider: "openai", connectionId: "connection-1", grantId: "grant-1" } } as Parameters<typeof service.testManagedEnvironment>[3];
    runtimeProbe.mockResolvedValue({ adapterType: "paperclip_runner", status: "pass", testedAt: checkedAt, checks: [{ code: "codex_hello_probe_passed", level: "info", message: "Fixture account checked" }] });
    expect((await service.testManagedEnvironment("paperclip_runner", input, binding, managed)).status).toBe("pass");
    expect(runtimeProbe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ managedAiCredentialHome: join(home, "provider") }));
    await expect(service.testManagedEnvironment("paperclip_runner", { ...input, managedAiCredentialHome: join(tmpdir(), "other-account", "provider") }, binding, managed)).rejects.toThrow("does not match");
  });

  it("passes a healthy Cloud Claude connection without asking the user to verify launch-time runtime preparation", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture");
    verifiedClaude();
    const result = await testConnection();
    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_passed" }));
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "acpx_remote_runtime_managed", level: "info" }));
    expect(claudeProbe).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: context.executionTarget, config: expect.objectContaining({ engine: "cli" }) }));
  });
  it("keeps remote runtime readiness warnings for self-hosted connections", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", ""); vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    verifiedClaude();
    const result = await testConnection();
    expect(result.status).toBe("warn");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "acpx_remote_runtime_unverified", level: "warn" }));
  });
  it("does not turn a failed hello into a successful Cloud connection", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture"); verifiedClaude();
    claudeProbe.mockResolvedValue({ adapterType: "claude_local", status: "fail", testedAt: checkedAt,
      checks: [{ code: "claude_hello_probe_auth_required", level: "error", message: "Authentication required" }] });
    expect((await testConnection()).status).toBe("fail");
    expect(markAuthFailed).toHaveBeenCalledTimes(1);
  });
  it("does not promote a runtime error before the provider probe", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture"); verifiedClaude();
    runtimeProbe.mockResolvedValue({ adapterType: "paperclip_runner", status: "fail", testedAt: checkedAt,
      checks: [{ code: "acpx_runtime_package_missing", level: "error", message: "Runtime missing" }] });
    expect((await testConnection()).status).toBe("fail");
    expect(claudeProbe).not.toHaveBeenCalled();
  });
  it("does not promote a missing hello receipt", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture"); verifiedClaude();
    claudeProbe.mockResolvedValue({ adapterType: "claude_local", status: "pass", testedAt: checkedAt, checks: [] });
    const result = await testConnection();
    expect(result.status).toBe("fail");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "ai_connection_validation_incomplete" }));
  });
  it("passes a managed API-key connection only after provider re-verification", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture"); verifiedClaude();
    const result = await testConnection({ config: { ...context.config, env: { ANTHROPIC_API_KEY: "fixture-key" }, managedAiConnection: { method: "api_key" } } });
    expect(result.status).toBe("pass");
    expect(verifyKey).toHaveBeenCalledExactlyOnceWith("anthropic", "fixture-key");
    expect(claudeProbe).not.toHaveBeenCalled();
  });
  it("keeps a rejected API key failed", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture"); verifiedClaude();
    verifyKey.mockRejectedValueOnce(new Error("Rejected key"));
    expect((await testConnection({ config: { ...context.config, env: { ANTHROPIC_API_KEY: "fixture-key" }, managedAiConnection: { method: "api_key" } } })).status).toBe("fail");
  });
  it("keeps SSH runtime warnings even on a Cloud instance", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture"); verifiedClaude();
    vi.spyOn(executionTargets, "runAdapterExecutionTargetProcess").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null });
    const result = await testConnection({ executionTarget: { kind: "remote", transport: "ssh", remoteCwd: "/workspace", spec: { host: "example.test", port: 22, username: "test", remoteCwd: "/workspace", remoteWorkspacePath: "/workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true } } });
    expect(result.status).toBe("warn");
  });
  it("never promotes an unexplained warning without the exact deferred check", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture"); verifiedClaude();
    runtimeProbe.mockResolvedValue({ adapterType: "paperclip_runner", status: "warn", testedAt: checkedAt, checks: [] });
    expect((await testConnection()).status).toBe("warn");
  });
  it("preserves an unexplained provider warning even with a hello receipt", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture"); verifiedClaude();
    claudeProbe.mockResolvedValue({ adapterType: "claude_local", status: "warn", testedAt: checkedAt,
      checks: [{ code: "claude_hello_probe_passed", level: "info", message: "Hello completed with an unresolved warning." }] });
    expect((await testConnection()).status).toBe("warn");
  });
  it("reports a plugin task that cannot describe its Runner as a retryable failed check", async () => {
    verifiedClaude();
    const runnerTask = vi.fn().mockRejectedValue(new Error("Plugin-provided Runner execution operation unavailable; reconcile the same task before retrying"));
    const result = await testConnection({ executionTarget: { ...context.executionTarget!, runnerTask } as AdapterEnvironmentTestContext["executionTarget"] });
    expect(runnerTask).toHaveBeenCalledExactlyOnceWith({ kind: "describe" });
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([expect.objectContaining({ code: "runner_environment_unavailable", level: "error", retryable: true })]);
    expect(JSON.stringify(result)).not.toContain("reconcile the same task");
    expect(() => assertHarnessTestPassed(result)).toThrow(expect.objectContaining({ code: "test_environment_unavailable" }));
    expect(runtimeProbe).not.toHaveBeenCalled();
    expect(claudeProbe).not.toHaveBeenCalled();
    expect(markAuthFailed).not.toHaveBeenCalled();
  });
  it("still rejects a plugin task that describes no project authentication check", async () => {
    verifiedClaude();
    const runnerTask = vi.fn().mockResolvedValue({ kind: "description", taskId: "task-1", runner: { version: "1", digest: `sha256:${"0".repeat(64)}` } });
    await expect(testConnection({ executionTarget: { ...context.executionTarget!, runnerTask } as AdapterEnvironmentTestContext["executionTarget"] }))
      .rejects.toMatchObject({ status: 422, details: { code: "ai_connection_incompatible" } });
    expect(runtimeProbe).not.toHaveBeenCalled();
  });
  it("keeps the stable Runner revision mismatch result when plugin description fails", async () => {
    verifiedClaude();
    const refusal = new JsonRpcCallError({ code: -32002, message: "The installed Runner does not match the expected revision",
      data: environmentTaskErrorCodeData(new PluginEnvironmentTaskError("runner_revision_mismatch")) });
    const runnerTask = vi.fn().mockRejectedValue(refusal);
    const result = await testConnection({ executionTarget: { ...context.executionTarget!, runnerTask } as AdapterEnvironmentTestContext["executionTarget"] });
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "runner_revision_mismatch", level: "error", retryable: true }] });
    expect(() => assertHarnessTestPassed(result)).toThrow(expect.objectContaining({ code: "runner_revision_mismatch" }));
    expect(runtimeProbe).not.toHaveBeenCalled();
    expect(markAuthFailed).not.toHaveBeenCalled();
  });
  it("keeps actionable warnings after a successful hello", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "managed-fixture"); verifiedClaude();
    const result = readiness(); result.checks.push({ code: "provider_configuration_warning", level: "warn", message: "Check the selected provider configuration." }); runtimeProbe.mockResolvedValue(result);
    expect((await testConnection()).status).toBe("warn");
  });
});
