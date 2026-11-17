import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { resolveProviderApiPlacement } from "./provider-api-placement.js";
import { evaluateExecutionAllowlist } from "../execution-allowlist.js";

const placement = { kind: "provider_api", provider: "cursor_cloud", controller: "paperclip" };
const agent = { adapterType: "paperclip_runner", adapterConfig: {
  provider: "cursor_cloud", model: "caller-model", repoUrl: "https://github.com/example/qualification",
} };
function execution(provider: "cursor_cloud" | "codex") {
  return buildNativeExecutionInput({ companyId: randomUUID(), agentId: randomUUID(), runId: randomUUID(), provider,
    model: "caller-model", ...(provider === "cursor_cloud" ? { cursorCloud: { schema: "paperclip.cursor-cloud.config.v1" as const, repos: [{ url: "https://github.com/example/qualification" }] } } : {}),
    issue: { id: randomUUID(), identifier: "API-1", title: "Bound task", description: null, workMode: "standard" },
    taskPrompt: "Complete the task", normalizedSessionId: randomUUID(),
    workspace: { id: randomUUID(), cwd: "/private/controller", repoUrl: null, repoRef: null, branchName: null },
    completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Complete the task", criteria: [{ id: "objective", requirement: "Complete the task" }] } },
    runtimeContext: nativeRuntimeContextFixture(),
  });
}

describe("provider API controller placement", () => {
  it("derives API placement only from a validated native Cursor contract while local agent code stays denied", () => {
    expect(resolveProviderApiPlacement({ agent })).toEqual(placement);
    expect(resolveProviderApiPlacement({ agent: { ...agent, adapterType: "cursor_cloud" } })).toBeNull();
    expect(resolveProviderApiPlacement({ agent: { ...agent, adapterConfig: { provider: "codex", executionPlacement: placement } } })).toBeNull();
    expect(evaluateExecutionAllowlist({ managedSandboxOnly: true }, { driver: "local", provider: null }).allowed).toBe(false);
  });
  it.each(["command", "extraArgs", "cwd", "workspaceStrategy", "workspaceRuntime", "executionPlacement", "providerApiPlacement", "controllerPlacement", "apiOnly"])("refuses configurable host authority through %s", key => {
    expect(() => resolveProviderApiPlacement({ agent: { ...agent, adapterConfig: { ...agent.adapterConfig, [key]: key === "extraArgs" ? ["--execute"] : "injected" } } })).toThrow();
  });
  it("requires exact model and refuses unrelated environment or a preconfigured home", () => {
    for (const patch of [{ model: "" }, { env: { NODE_OPTIONS: "--require=untrusted" } }, { homeMode: "preconfigured" }]) {
      expect(() => resolveProviderApiPlacement({ agent: { ...agent, adapterConfig: { ...agent.adapterConfig, ...patch } } })).toThrow();
    }
  });
  it("restores the admitted provider rather than reinterpreting a later agent configuration", () => {
    const nativeExecutionInput = execution("cursor_cloud");
    const run = { runtimeMode: "native", runnerProfileJson: { backend: "cursor_cloud_api", executionPlacement: placement, nativeExecutionInput } };
    expect(resolveProviderApiPlacement({ agent: { ...agent, adapterConfig: { provider: "codex" } }, run })).toEqual(placement);
    expect(() => resolveProviderApiPlacement({ agent, run: { ...run, runnerProfileJson: { ...run.runnerProfileJson, backend: "codex_app_server" } } })).toThrow("binding_mismatch");
    expect(() => resolveProviderApiPlacement({ agent, run: { ...run, runnerProfileJson: { ...run.runnerProfileJson, nativeExecutionInput: execution("codex") } } })).toThrow("binding_mismatch");
    expect(resolveProviderApiPlacement({ agent, run: { runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: execution("codex") } } })).toBeNull();
  });
  it("binds historical Cursor input to its backend and recorded driver before granting API placement", () => {
    const nativeExecutionInput = execution("cursor_cloud");
    const run = { runtimeMode: "native", driverKind: "cursor_cloud_api", runnerProfileJson: { backend: "cursor_cloud_api", nativeExecutionInput } };
    expect(resolveProviderApiPlacement({ agent, run })).toEqual(placement);
    expect(resolveProviderApiPlacement({ agent, run: { ...run, driverKind: null } })).toEqual(placement);
    expect(resolveProviderApiPlacement({ agent, run: { ...run, driverKind: null, runnerProfileJson: { nativeExecutionInput } } })).toEqual(placement);
    expect(() => resolveProviderApiPlacement({ agent, run: { ...run, runnerProfileJson: { ...run.runnerProfileJson, backend: "codex_app_server" } } })).toThrow("binding_mismatch");
    expect(() => resolveProviderApiPlacement({ agent, run: { ...run, driverKind: "codex_app_server" } })).toThrow("binding_mismatch");
  });
});
