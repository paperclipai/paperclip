import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildNativeExecutionInput } from "../native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { heartbeatExternalProvider, nativeRuntimeHasInstructionFilesystem, nativeExecutionUsesTaskWorkspace } from "./external-provider.js";

function execution(provider: "muse" | "openai_dot" | "grok_bot" | "codex") {
  const companyId = randomUUID(), agentId = randomUUID();
  const binding = { companyId, agentId, bindingId: randomUUID(), bindingGeneration: 1,
    acceptByUnixMs: Date.now() + 60_000, expiresAtUnixMs: Date.now() + 600_000 };
  return buildNativeExecutionInput({ companyId, agentId, runId: randomUUID(), provider,
    ...(provider === "muse" ? { museBinding: binding } : provider === "openai_dot" || provider === "grok_bot" ? { dotBinding: binding } : {}),
    issue: { id: randomUUID(), identifier: "EXT-1", title: "Bound task", description: null, workMode: "standard" },
    taskPrompt: "Complete the task", normalizedSessionId: randomUUID(),
    workspace: { id: randomUUID(), cwd: "/controller", repoUrl: null, repoRef: null, branchName: null },
    completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Complete the task", criteria: [{ id: "objective", requirement: "Complete the task" }] } },
    runtimeContext: nativeRuntimeContextFixture(),
  });
}

describe("shared external heartbeat classification", () => {
  it.each(["muse", "openai_dot", "grok_bot"] as const)("keeps %s external on fresh admission and after a configured provider change", provider => {
    const agent = { adapterType: "paperclip_runner", adapterConfig: { provider } };
    expect(heartbeatExternalProvider({ agent, run: { runtimeMode: "legacy", runnerProfileJson: null } })).toBe(provider);
    const admitted = execution(provider);
    expect(admitted.schema).toBe(provider === "muse" ? "paperclip.native-execution-input.v8" : "paperclip.native-execution-input.v6");
    expect(admitted.provider.kind).toBe(provider);
    expect(admitted.session.driverKind).toBe(provider === "muse" ? "muse_external" : provider === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp");
    expect(heartbeatExternalProvider({ agent: { ...agent, adapterConfig: { provider: "codex" } },
      run: { runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: admitted } } })).toBe(provider);
    expect(nativeRuntimeHasInstructionFilesystem(admitted.session.driverKind)).toBe(false);
    expect(nativeExecutionUsesTaskWorkspace(admitted)).toBe(false);
  });

  it("does not turn an admitted local provider into an external bridge after configuration changes", () => {
    expect(heartbeatExternalProvider({ agent: { adapterType: "paperclip_runner", adapterConfig: { provider: "muse" } },
      run: { runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: execution("codex") } } })).toBeNull();
    expect(nativeRuntimeHasInstructionFilesystem("codex_app_server")).toBe(true);
    expect(nativeExecutionUsesTaskWorkspace(execution("codex"))).toBe(true);
    expect(heartbeatExternalProvider({ agent: { adapterType: "process", adapterConfig: { provider: "muse" } },
      run: { runtimeMode: "legacy", runnerProfileJson: null } })).toBeNull();
  });
});
