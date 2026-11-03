import { describe, expect, it, vi } from "vitest";
import { parseNativeExecutionInput, buildNativeModelEnvelope, NativeExecutionInputError,
  NATIVE_EXECUTION_INPUT_SCHEMA_V11, type NativeExecutionInputV11 } from "./native-execution.js";
import { NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest, nativeRuntimePromptDigest } from "./runtime-context.js";
import { createNativeSessionBackend } from "../backends/native-backend-factory.js";
import { createRunnerdNativeSessionBackend } from "../backends/codex-native-backend.js";
import { nativeTaskConstraints } from "../backends/runtime-context.js";

function execution(): NativeExecutionInputV11 {
  const digest = "0".repeat(64);
  const context = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest,
      manifestDigest: digest, rootPath: "/runtime/instructions", fileCount: 1, totalBytes: 10 } },
    skills: [], mcp: { assignmentSetId: "none", digest, bindingId: null },
  };
  return parseNativeExecutionInput({
    schema: NATIVE_EXECUTION_INPUT_SCHEMA_V11,
    binding: { companyId: "company_1", runId: "run_1", issueId: "issue_1", agentId: "agent_1", executionWorkspaceId: "workspace_1" },
    task: { identifier: "PAP-1", title: "Native extension task", description: null, prompt: "Complete the task.", workMode: "standard" },
    workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: "session_1", driverKind: "extension", protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    provider: { kind: "extension", harnessId: "example.fixture/native", model: "selected-model",
      config: { temperature: 0.2, modes: ["coding"] }, capabilities: { typedEvents: true, structuredResult: true, interruption: true },
      release: { harnessId: "example.fixture/native", packageName: "@example/plugin-native", version: "1.0.0",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, protocolVersion: 1, runtimeDigest: `sha256:${"a".repeat(64)}` } },
    completionContract: { id: "contract_1", sha256: "contract-digest", schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Complete the task", criteria: [{ id: "objective", requirement: "A verified task result exists" }] } },
    interactionResponses: [], credentialBindings: [], executionMode: "default", planningContext: null,
    runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) }, homeMode: "isolated",
  }) as NativeExecutionInputV11;
}

describe("native extension execution admission", () => {
  it("round-trips exact immutable package identity and detaches configuration", () => {
    const source = execution();
    const parsed = parseNativeExecutionInput(source) as NativeExecutionInputV11;
    expect(parsed).toEqual(source);
    source.provider.config.temperature = 0.8;
    expect(parsed.provider.config.temperature).toBe(0.2);
    expect(parseNativeExecutionInput(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects crossed release, provider, driver and prior schema identities", () => {
    const source = execution();
    const rejected = [
      { ...source, provider: { ...source.provider, harnessId: "other.plugin/native" } },
      { ...source, provider: { ...source.provider, release: { ...source.provider.release, protocolVersion: 2 } } },
      { ...source, provider: { ...source.provider, kind: "codex" } },
      { ...source, session: { ...source.session, driverKind: "codex_app_server" } },
      { ...source, schema: "paperclip.native-execution-input.v10" },
      { ...source, provider: { ...source.provider, command: "/bin/sh" } },
      { ...source, provider: { ...source.provider, model: " selected-model" } },
      { ...source, homeMode: "preconfigured" },
    ];
    for (const input of rejected) expect(() => parseNativeExecutionInput(input)).toThrow(NativeExecutionInputError);
  });

  it("rejects non-JSON or oversized configuration and false capability shapes", () => {
    const source = execution();
    for (const config of [{ dropped: undefined }, { invalid: Infinity }, { command: () => {} }, { big: "x".repeat(1024 * 1024) }]) {
      expect(() => parseNativeExecutionInput({ ...source, provider: { ...source.provider, config } })).toThrow(NativeExecutionInputError);
    }
    expect(() => parseNativeExecutionInput({ ...source, provider: { ...source.provider, capabilities: { planning: "yes" } } })).toThrow(NativeExecutionInputError);
  });

  it("uses the compact model envelope without exposing release metadata or provider settings", () => {
    const input = execution();
    const envelope = buildNativeModelEnvelope(input);
    expect(envelope).toMatchObject({ schema: "paperclip.native-model-envelope.v3", task: { prompt: "Complete the task." } });
    expect(envelope).not.toHaveProperty("provider");
    expect(JSON.stringify(envelope)).not.toContain("@example/plugin-native");
    input.interactionResponses = [{ interactionId: "answered", kind: "ask_user_questions", response: {
      status: "answered", result: { version: 1, answers: [{ questionId: "question_1", optionIds: ["answer_1"] }] },
    } }];
    expect(nativeTaskConstraints(input).join("\n")).toContain("interactionResponses[0].response.result.answers");
    expect(nativeTaskConstraints(input).join("\n")).not.toContain("message.interactionResponses");
  });

  it("requires a selected installed transport and never falls back to a built-in process", () => {
    expect(() => createNativeSessionBackend(execution())).toThrow("require an admitted Runner transport");
    const transport = vi.fn(() => { throw new Error("must remain lazy"); });
    const backend = createNativeSessionBackend(execution(), { retainedSystemInstructions: "Pinned instructions", codexTransportFactory: transport });
    expect(backend).toBeDefined();
    expect(transport).not.toHaveBeenCalled();
  });

  it("derives optional controls only from persisted admitted capability claims", async () => {
    const source = execution();
    const options = { retainedSystemInstructions: "Pinned instructions", transportFactory: () => { throw new Error("must remain lazy"); } };
    const limited = await createRunnerdNativeSessionBackend(source, options).descriptor();
    expect(limited).toMatchObject({ name: "extension", version: "1.0.0", capabilities: {
      steering: false, toolRefreshOnResume: false, goals: false, interruption: true, collaborationModes: ["default"],
    } });
    source.provider.capabilities = { ...source.provider.capabilities, resume: true, dynamicTools: true, steering: true, toolRefreshOnResume: true, planning: true };
    const rich = await createRunnerdNativeSessionBackend(source, options).descriptor();
    expect(rich.capabilities).toMatchObject({ steering: true, toolRefreshOnResume: true, collaborationModes: ["default", "plan"] });
    const planning = { ...source, task: { ...source.task, workMode: "planning" }, executionMode: "plan",
      planningContext: { documentId: null, baseRevisionId: null, baseRevisionNumber: 0, markdown: "", sha256: "empty", reviewContext: {} } };
    expect(() => parseNativeExecutionInput(planning)).not.toThrow();
    expect(() => parseNativeExecutionInput({ ...planning, provider: { ...planning.provider, capabilities: {} } })).toThrow("does not support planning");
  });
});
