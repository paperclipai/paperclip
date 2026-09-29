import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildNativeModelEnvelope, parseNativeExecutionInput, NATIVE_EXECUTION_INPUT_SCHEMA, type NativeExecutionInputV1 } from "./native-execution.js";
import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  composeNativeSystemInstructions,
  nativeRuntimePromptDigest,
} from "./runtime-context.js";

const input: NativeExecutionInputV1 = {
  schema: "paperclip.native-execution-input.v1",
  binding: {
    companyId: "company-1",
    runId: "run-1",
    issueId: "issue-1",
    agentId: "agent-1",
    executionWorkspaceId: "workspace-1",
  },
  task: {
    identifier: "PAP-1",
    title: "Safe task",
    description: null,
    prompt: "# PAP-1: Safe task\n\nPlease address the latest comment.",
    workMode: "standard",
  },
  workspace: { cwd: "/safe/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: {
    normalizedSessionId: null,
    driverKind: "codex_app_server",
    protocolVersion: 1,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
  },
  provider: { kind: "codex", model: null },
  completionContract: {
    id: "contract-1",
    sha256: "abc123",
    schemaVersion: "paperclip.completion-contract.v1",
    contract: {
      revision: "1",
      objective: "Complete the safe task.",
      criteria: [{ id: "objective", requirement: "The task is complete." }],
    },
  },
  interactionResponses: [],
  credentialBindings: [{
    bindingId: "opaque-binding",
    service: "github",
    destination: "github.com",
    expiresAt: null,
    displayName: "GitHub",
  }],
};

describe("NativeExecutionInputV1", () => {
  it("parses v3 immutable runtime context without changing the model task envelope", () => {
    const digest = "0".repeat(64);
    const context = {
      prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
      instructions: {
        entryPath: "AGENTS.md",
        bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: "/runtime/instructions", fileCount: 2, totalBytes: 42 },
      },
      skills: [{
        key: "company/research",
        runtimeName: "research",
        versionId: "version-1",
        bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: "/runtime/skills/research", fileCount: 2, totalBytes: 42 },
      }],
      mcp: { assignmentSetId: "sha256:test", digest, bindingId: "native-mcp:run-1" },
    } as const;
    const parsed = parseNativeExecutionInput({
      ...input,
      schema: "paperclip.native-execution-input.v3",
      executionMode: "default",
      planningContext: null,
      runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
    });
    expect(parsed.schema).toBe("paperclip.native-execution-input.v3");
    const envelope = buildNativeModelEnvelope(parsed);
    expect(envelope.task).toEqual(buildNativeModelEnvelope(input).task);
    expect(envelope.completionContract).toEqual(buildNativeModelEnvelope(input).completionContract);
    expect(JSON.stringify(envelope)).not.toContain("runtimeContext");
    expect(JSON.stringify(envelope)).not.toContain(PAPERCLIP_EXECUTION_PROMPT);
    expect(composeNativeSystemInstructions(parsed.runtimeContext, "Follow sibling.md")).toBe(
      `${PAPERCLIP_EXECUTION_PROMPT}\n\nFollow sibling.md\n\nRead-only instruction sibling root: /runtime/instructions`,
    );
    expect(canonicalNativeRuntimeContextDigest({
      ...context,
      mcp: { ...context.mcp, bindingId: "native-mcp:run-2" },
    })).toBe(parsed.runtimeContext.aggregateDigest);
    const current = parseNativeExecutionInput({
      ...parsed,
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "codex", model: null, approvalPolicy: "on-request" },
    });
    const withDelta = parseNativeExecutionInput({ ...current, continuationPrompt: '{"messages":[{"authorType":"user","body":"Just this new comment"}]}' });
    // No checkpoint / failed provider recovery must retain full bootstrap input.
    expect(buildNativeModelEnvelope(withDelta)).toEqual(buildNativeModelEnvelope(current));
    const delta = buildNativeModelEnvelope(withDelta, { resumedSession: true });
    expect(delta).toEqual({
      schema: "paperclip.native-continuation.v1",
      events: '{"messages":[{"authorType":"user","body":"Just this new comment"}]}',
      completion: { revision: "1", criterionIds: ["objective"] },
    });
    expect(JSON.stringify(delta)).not.toContain(input.task.title);
    expect(JSON.stringify(delta)).not.toContain(input.completionContract.contract.objective);
    expect(JSON.stringify(delta)).not.toContain("opaque-binding");
    const withGuidance = parseNativeExecutionInput({ ...current, initialCommunicationGuidance: "Saved Slack instructions" });
    expect(buildNativeModelEnvelope(withGuidance).task.prompt).toBe(`Saved Slack instructions\n\n${current.task.prompt}`);
    // Structured question/approval resumes may use a full envelope rather than
    // a delta. They still must not repeat initial communication instructions.
    expect(buildNativeModelEnvelope(withGuidance, { resumedSession: true })).toEqual(buildNativeModelEnvelope(current));
    expect(buildNativeModelEnvelope(parseNativeExecutionInput({ ...withGuidance, continuationPrompt: "new message" }), { resumedSession: true })).not.toHaveProperty("task");
    expect(buildNativeModelEnvelope(withGuidance).task.prompt.match(/Saved Slack instructions/g)).toHaveLength(1);
    expect(current).toMatchObject({
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "codex", approvalPolicy: "on-request" },
    });
    expect(() => parseNativeExecutionInput({
      ...parsed,
      schema: "paperclip.native-execution-input.v4",
      provider: { kind: "codex", model: null, approvalPolicy: "sometimes" },
    })).toThrow("approvalPolicy");
  });

  it("rejects runtime-context traversal and aggregate digest drift", () => {
    const digest = "0".repeat(64);
    const context = {
      prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
      instructions: {
        entryPath: "../AGENTS.md",
        bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: "/runtime/instructions", fileCount: 1, totalBytes: 1 },
      },
      skills: [],
      mcp: { assignmentSetId: "none", digest, bindingId: null },
      aggregateDigest: digest,
    } as const;
    expect(() => parseNativeExecutionInput({ ...input, schema: "paperclip.native-execution-input.v3", executionMode: "default", planningContext: null, runtimeContext: context })).toThrow("bundle root");
    expect(() => parseNativeExecutionInput({
      ...input,
      schema: "paperclip.native-execution-input.v3",
      executionMode: "default",
      planningContext: null,
      runtimeContext: { ...context, instructions: { ...context.instructions, entryPath: "AGENTS.md" } },
    })).toThrow("aggregateDigest");
  });

  it("builds a model envelope without authority or credential bindings", () => {
    const parsed = parseNativeExecutionInput(input);
    const model = buildNativeModelEnvelope(parsed);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("company-1");
    expect(serialized).not.toContain("run-1");
    expect(serialized).not.toContain("opaque-binding");
    expect(model.task.title).toBe("Safe task");
    expect(model.task.prompt).toContain("latest comment");
  });

  it("rejects unknown context or environment escape hatches", () => {
    expect(() => parseNativeExecutionInput({ ...input, context: { secret: "canary" } })).toThrow(
      "unknown field context",
    );
    expect(() => parseNativeExecutionInput({
      ...input,
      workspace: { ...input.workspace, env: { PAPERCLIP_API_KEY: "canary" } },
    })).toThrow("unknown field env");
  });

  it("accepts a persisted OpenCode driver/model pair and rejects mismatches", () => {
    const opencode = parseNativeExecutionInput({
      ...input,
      session: { ...input.session, driverKind: "opencode_server" },
      provider: { kind: "opencode", model: "openrouter/deepseek/deepseek-v4-flash-0731" },
    });
    expect(opencode.provider).toEqual({
      kind: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    expect(parseNativeExecutionInput(opencode)).toEqual(opencode);
    expect(() => parseNativeExecutionInput({
      ...input,
      session: { ...input.session, driverKind: "opencode_server" },
      provider: { kind: "codex", model: null },
    })).toThrow("does not match");
  });

  it("deserializes pre-provider Codex state as Codex", () => {
    const legacy = structuredClone(input) as Record<string, unknown>;
    delete legacy.provider;
    expect(parseNativeExecutionInput(legacy).provider).toEqual({
      kind: "codex",
      model: null,
    });
    expect(parseNativeExecutionInput(parseNativeExecutionInput(legacy))).toEqual(
      parseNativeExecutionInput(legacy),
    );
  });

  it("accepts an immutable Claude Managed Agent profile and rejects driver or beta drift", () => {
    const claudeManaged = {
      ...input,
      session: { ...input.session, driverKind: "claude_managed_agents_api" },
      provider: {
        kind: "claude_managed",
        model: "claude-sonnet-5",
        managedProfile: {
          profileId: "managed-profile-1",
          anthropicAgentId: "agent_01",
          agentVersion: "3",
          environmentId: "environment_01",
          betaVersion: "managed-agents-2026-04-01",
        },
        maxSessionListCostUsd: 1,
      },
    } as const;
    const parsed = parseNativeExecutionInput(claudeManaged);
    expect(parsed.provider).toEqual(claudeManaged.provider);
    expect(buildNativeModelEnvelope(parsed).workspace).toBeNull();
    expect(() => parseNativeExecutionInput({
      ...claudeManaged,
      session: { ...claudeManaged.session, driverKind: "codex_app_server" },
    })).toThrow("does not match");
    expect(() => parseNativeExecutionInput({
      ...claudeManaged,
      provider: {
        ...claudeManaged.provider,
        managedProfile: { ...claudeManaged.provider.managedProfile, betaVersion: "future-beta" },
      },
    })).toThrow("betaVersion");
  });

  it("accepts a closed AWS AgentCore Harness snapshot and rejects drift or unsafe limits", () => {
    const awsAgentCore = {
      ...input,
      session: { ...input.session, driverKind: "aws_agentcore_harness_api" },
      provider: {
        kind: "aws_agentcore",
        model: "global.anthropic.claude-sonnet-4-6",
        agentCoreProfile: {
          profileId: "agentcore-development",
          region: "us-east-1",
          accountId: "123456789012",
          harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/harness-1",
          harnessVersion: "3",
          endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness-endpoint/harness-1/paperclip",
          endpointQualifier: "paperclip",
          agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-1",
          memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/memory-1",
          memoryId: "memory-1",
          invocationRoleArn: "arn:aws:iam::123456789012:role/paperclip-agentcore-runner",
          contextBucket: "paperclip-agentcore-context",
          contextPrefix: "paperclip/runtime",
          contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
          qualificationRevision: "aws-agentcore-harness-context-v2",
          eventExpiryDays: 90,
        },
        maxEstimatedSessionCostUsd: 1,
        invocationLimits: { maxIterations: 8, maxOutputTokens: 4096, timeoutSeconds: 300 },
      },
    } as const;
    const parsed = parseNativeExecutionInput(awsAgentCore);
    expect(parsed.provider).toEqual(awsAgentCore.provider);
    expect(buildNativeModelEnvelope(parsed).workspace).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(() => parseNativeExecutionInput({
      ...awsAgentCore,
      session: { ...awsAgentCore.session, driverKind: "codex_app_server" },
    })).toThrow("does not match");
    expect(() => parseNativeExecutionInput({
      ...awsAgentCore,
      provider: { ...awsAgentCore.provider, invocationLimits: { ...awsAgentCore.provider.invocationLimits, maxIterations: 9 } },
    })).toThrow("maxIterations");
    expect(() => parseNativeExecutionInput({
      ...awsAgentCore,
      provider: { ...awsAgentCore.provider, agentCoreProfile: { ...awsAgentCore.provider.agentCoreProfile, eventExpiryDays: 30 } },
    })).toThrow("eventExpiryDays");
  });

  it("accepts only a closed ACPX profile matching the driver and agent", () => {
    const provider = {
      kind: "acpx",
      agent: "pi",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      permissionPolicy: "interactive",
      profile: {
        driverKind: "acpx_runtime",
        protocolVersion: 1,
        acpxVersion: "0.13.1",
        agent: "pi",
        agentProfileVersion: 1,
        agentServerPackage: "pi-acp",
        agentServerVersion: "0.0.33",
        agentRuntimePackage: "@earendil-works/pi-coding-agent",
        agentRuntimeVersion: "0.84.2",
        commandDigest: "sha256:24ff73fda6e3c76ddce2d359a79f5c4b8f292eb290e4d2ab85aac94676b2c2dc",
      },
    } as const;
    const parsed = parseNativeExecutionInput({
      ...input,
      session: { ...input.session, driverKind: "acpx_runtime" },
      provider,
    });
    expect(parsed.provider).toEqual({
      kind: "acpx",
      agent: "pi",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      permissionPolicy: "interactive",
      profile: provider.profile,
    });
    expect(parseNativeExecutionInput(parsed)).toEqual(parsed);
    expect(buildNativeModelEnvelope(parsed).workspace).toEqual({ cwd: "/safe/workspace" });
    expect(() => parseNativeExecutionInput({
      ...input,
      session: { ...input.session, driverKind: "acpx_runtime" },
      provider: { ...provider, profile: { ...provider.profile, agent: "claude" } },
    })).toThrow("qualified ACPX v1 profile");
    expect(() => parseNativeExecutionInput({
      ...input,
      session: { ...input.session, driverKind: "opencode_server" },
      provider,
    })).toThrow("does not match");
  });

  it("defaults legacy lifecycle state to per-turn and validates warm timeouts", () => {
    const legacy = structuredClone(input) as Record<string, unknown>;
    delete (legacy.session as Record<string, unknown>).lifecyclePolicy;
    expect(parseNativeExecutionInput(legacy).session.lifecyclePolicy).toEqual({
      mode: "per_turn",
      idleTimeoutMs: null,
    });
    expect(parseNativeExecutionInput({
      ...input,
      session: {
        ...input.session,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
      },
    }).session.lifecyclePolicy).toEqual({ mode: "warm", idleTimeoutMs: 300_000 });
    expect(() => parseNativeExecutionInput({
      ...input,
      session: {
        ...input.session,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 0 },
      },
    })).toThrow("positive integer");
    expect(() => parseNativeExecutionInput({
      ...input,
      session: {
        ...input.session,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 86_400_001 },
      },
    })).toThrow("no greater than 86400000");
  });
});

describe("NativeExecutionInputV2 planning", () => {
  const planning = {
    ...input,
    schema: "paperclip.native-execution-input.v2",
    executionMode: "plan",
    task: { ...input.task, workMode: "planning" },
    planningContext: {
      documentId: "document-1",
      baseRevisionId: "revision-3",
      baseRevisionNumber: 3,
      markdown: "# Existing plan",
      sha256: "plan-digest",
      reviewContext: { threads: [{ id: "annotation-1" }] },
    },
  } as const;

  it("round-trips native plan mode and its pinned canonical revision into model context", () => {
    const parsed = parseNativeExecutionInput(planning);
    expect(parsed).toMatchObject({ schema: "paperclip.native-execution-input.v2", executionMode: "plan" });
    expect(buildNativeModelEnvelope(parsed)).toMatchObject({
      schema: "paperclip.native-model-envelope.v2",
      executionMode: "plan",
      planningContext: { baseRevisionId: "revision-3", baseRevisionNumber: 3 },
    });
  });

  it("fails closed when plan mode omits its pinned Paperclip context", () => {
    expect(() => parseNativeExecutionInput({ ...planning, planningContext: null }))
      .toThrow("planningContext is required");
    expect(() => parseNativeExecutionInput({
      ...planning,
      task: { ...planning.task, workMode: "standard" },
    })).toThrow("requires planning work mode");
  });

  it("allows an accepted planning issue to continue in fresh default execution mode", () => {
    expect(parseNativeExecutionInput({
      ...planning,
      executionMode: "default",
      planningContext: null,
    })).toMatchObject({ task: { workMode: "planning" }, executionMode: "default" });
  });
});

describe("NativeExecutionInputV2 ask mode", () => {
  it("round-trips ask mode as a default execution without planning context", () => {
    const parsed = parseNativeExecutionInput({
      ...input,
      schema: "paperclip.native-execution-input.v2",
      executionMode: "default",
      task: { ...input.task, workMode: "ask" },
      planningContext: null,
    });
    expect(parsed).toMatchObject({
      schema: "paperclip.native-execution-input.v2",
      executionMode: "default",
      task: { workMode: "ask" },
    });
    expect(buildNativeModelEnvelope(parsed)).toMatchObject({
      schema: "paperclip.native-model-envelope.v2",
      task: { workMode: "ask" },
      executionMode: "default",
      planningContext: null,
    });
  });

  it("rejects plan execution for ask mode", () => {
    expect(() => parseNativeExecutionInput({
      ...input,
      schema: "paperclip.native-execution-input.v2",
      executionMode: "plan",
      task: { ...input.task, workMode: "ask" },
      planningContext: {
        documentId: null,
        baseRevisionId: null,
        baseRevisionNumber: 0,
        markdown: "",
        sha256: "digest",
        reviewContext: {},
      },
    })).toThrow("plan execution mode requires planning work mode");
  });
});


describe("native task context ownership", () => {
  function currentInput() {
    const digest = "0".repeat(64);
    const context = {
      prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
      instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: "/runtime/instructions", fileCount: 1, totalBytes: 1 } },
      skills: [],
      mcp: { assignmentSetId: "none", digest, bindingId: null },
    } as const;
    return parseNativeExecutionInput({
      ...input,
      schema: NATIVE_EXECUTION_INPUT_SCHEMA,
      task: { ...input.task, description: "Use $assigned-skill. Repeat this. Repeat this.", prompt: "# PAP-1\n\nIssue description:\nUse $assigned-skill. Repeat this. Repeat this." },
      provider: { kind: "codex", model: null, approvalPolicy: "never" },
      executionMode: "default",
      planningContext: null,
      runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
    });
  }

  it.each([
    ["v4", "paperclip.native-execution-input.v4", "paperclip.native-model-envelope.v2"],
    ["v5", NATIVE_EXECUTION_INPUT_SCHEMA, "paperclip.native-model-envelope.v3"],
  ] as const)("applies communication guidance once for fresh %s input and never on resume", (_label, schema, envelopeSchema) => {
    const guidance = "Saved Slack instructions";
    const v5 = currentInput();
    const source = {
      kind: "description" as const,
      id: v5.binding.issueId,
      revision: createHash("sha256").update(v5.task.description!).digest("hex"),
    };
    const contract = {
      ...v5.completionContract.contract,
      criteria: [{ id: "objective", requirement: v5.task.description! }],
    };
    const parsed = parseNativeExecutionInput({
      ...v5,
      schema,
      initialCommunicationGuidance: guidance,
      ...(schema === NATIVE_EXECUTION_INPUT_SCHEMA ? {
        completionContract: { ...v5.completionContract, contract },
        completionSources: {
          promptSha256: createHash("sha256").update(v5.task.prompt).digest("hex"),
          contractRevision: contract.revision,
          criteria: [{ id: "objective", source }],
        },
      } : {}),
    });
    const fresh = buildNativeModelEnvelope(parsed);
    expect(fresh.schema).toBe(envelopeSchema);
    expect(fresh.task.prompt).toBe(`${guidance}\n\n${parsed.task.prompt}`);
    expect(fresh.task.prompt.match(/Saved Slack instructions/g)).toHaveLength(1);
    if (schema === NATIVE_EXECUTION_INPUT_SCHEMA) {
      expect(fresh.task).not.toHaveProperty("description");
      expect(fresh.completionContract.criteria).toEqual([
        { id: "objective", source: { ...source, location: "task.prompt" } },
      ]);
    } else {
      expect(fresh.task).toHaveProperty("description", parsed.task.description);
    }

    const fullResume = buildNativeModelEnvelope(parsed, { resumedSession: true });
    expect(fullResume.schema).toBe(envelopeSchema);
    expect(fullResume.task.prompt).toBe(parsed.task.prompt);
    expect(fullResume.task.prompt).not.toContain(guidance);

    const compactResume = buildNativeModelEnvelope(
      parseNativeExecutionInput({ ...parsed, continuationPrompt: "new message" }),
      { resumedSession: true },
    );
    expect(compactResume).toMatchObject({ schema: "paperclip.native-continuation.v1" });
    expect(JSON.stringify(compactResume)).not.toContain(guidance);
  });

  it("selects model fields without losing the internal skill-selection description", () => {
    const execution = currentInput();
    const envelope = buildNativeModelEnvelope(execution);
    expect(envelope.task).toEqual({
      identifier: execution.task.identifier,
      title: execution.task.title,
      prompt: execution.task.prompt,
      workMode: execution.task.workMode,
    });
    expect(execution.task.description).toBe("Use $assigned-skill. Repeat this. Repeat this.");
    expect(envelope.task.prompt).toContain("Repeat this. Repeat this.");
    expect(envelope.completionContract).toEqual(execution.completionContract.contract);
  });

  it("references only verified criterion sources and preserves independent requirements", () => {
    const execution = currentInput();
    const source = { kind: "description", id: execution.binding.issueId, revision: createHash("sha256").update(execution.task.description!).digest("hex") };
    const contract = { ...execution.completionContract.contract, criteria: [
      { id: "objective", requirement: execution.task.description! },
      { id: "independent", requirement: "Also report a measured result." },
    ] };
    const completeInput = parseNativeExecutionInput({
      ...execution,
      completionContract: { ...execution.completionContract, contract },
      completionSources: { promptSha256: createHash("sha256").update(execution.task.prompt).digest("hex"), contractRevision: contract.revision, criteria: [{ id: "objective", source }] },
    });
    const before = structuredClone(completeInput.completionContract);
    const envelope = buildNativeModelEnvelope(completeInput);
    expect(envelope.completionContract.criteria).toEqual([
      { id: "objective", source: { ...source, location: "task.prompt" } },
      { id: "independent", requirement: "Also report a measured result." },
    ]);
    expect(completeInput.completionContract).toEqual(before);
    // A different prompt or contract revision invalidates the projection, never the saved contract.
    for (const stale of [
      { ...completeInput, task: { ...completeInput.task, prompt: "Recovery without the original brief" } },
      { ...completeInput, completionContract: { ...completeInput.completionContract, contract: { ...contract, revision: "new" } } },
    ]) {
      expect(buildNativeModelEnvelope(stale).completionContract).toEqual(stale.completionContract.contract);
    }
  });
});
