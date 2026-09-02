import { describe, expect, it } from "vitest";

import type { NativeExecutionInput } from "../contracts/native-execution.js";
import { createNativeSessionBackend } from "../index.js";
import { createCodexNativeSessionBackend } from "./codex-native-backend.js";

function execution(
  provider: NativeExecutionInput["provider"] = {
    kind: "codex",
    model: null,
    approvalPolicy: "never",
  },
): NativeExecutionInput {
  return {
    schema: "paperclip.native-execution-input.v1",
    binding: {
      companyId: "company",
      runId: "run",
      issueId: "issue",
      agentId: "agent",
      executionWorkspaceId: "workspace",
    },
    task: {
      identifier: "PAP-1",
      title: "Exercise Codex native routing",
      description: null,
      prompt: "Complete the task.",
      workMode: "standard",
    },
    workspace: {
      cwd: "/workspace",
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    session: {
      normalizedSessionId: "session",
      driverKind: "codex_app_server",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider,
    completionContract: {
      id: "contract",
      sha256: "sha256",
      schemaVersion: "1",
      contract: {
        revision: "revision",
        objective: "Complete the task.",
        criteria: [],
      },
    },
    interactionResponses: [],
    credentialBindings: [],
  };
}

function acpxExecution(
  agent: "codex" | "pi" | "claude" = "codex",
): NativeExecutionInput {
  return {
    ...execution(),
    session: {
      normalizedSessionId: "session",
      driverKind: "acpx_runtime",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: {
      kind: "acpx",
      agent,
      model:
        agent === "codex"
          ? "gpt-5.6-sol"
          : agent === "pi"
            ? "openrouter/deepseek/deepseek-v4-flash-0731"
            : "claude-sonnet-5",
      permissionPolicy: "interactive",
      profile: {
        driverKind: "acpx_runtime",
        protocolVersion: 1,
        acpxVersion: "0.13.1",
        agent,
        agentProfileVersion: 1,
        agentServerPackage:
          agent === "codex"
            ? "@agentclientprotocol/codex-acp"
            : agent === "pi"
              ? "pi-acp"
              : "@agentclientprotocol/claude-agent-acp",
        agentServerVersion:
          agent === "codex" ? "1.6.2" : agent === "pi" ? "0.0.33" : "0.70.0",
        agentRuntimePackage:
          agent === "pi" ? "@earendil-works/pi-coding-agent" : null,
        agentRuntimeVersion: agent === "pi" ? "0.84.2" : null,
        commandDigest:
          agent === "codex"
            ? "sha256:94049b3e3c3aee87de62703786e4fa81d031d7bd979f99bdf516d84f28791a79"
            : agent === "pi"
              ? "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f"
              : "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
      },
    },
  };
}

function opencodeExecution(): NativeExecutionInput {
  return {
    ...execution(),
    session: {
      normalizedSessionId: "session",
      driverKind: "opencode_server",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: {
      kind: "opencode",
      model: "openrouter/model",
      permissionMode: "allow",
    },
  };
}

function managedExecution(
  kind: "claude_managed" | "aws_agentcore",
): NativeExecutionInput {
  if (kind === "claude_managed") {
    return {
      ...execution(),
      session: {
        normalizedSessionId: "session",
        driverKind: "claude_managed_agents_api",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      provider: {
        kind,
        model: "claude-sonnet-5",
        maxSessionListCostUsd: 1,
        managedProfile: {
          profileId: "profile",
          anthropicAgentId: "agent",
          agentVersion: "1",
          environmentId: "environment",
          betaVersion: "managed-agents-2026-04-01",
        },
      },
    };
  }
  return {
    ...execution(),
    session: {
      normalizedSessionId: "session",
      driverKind: "aws_agentcore_harness_api",
      protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: {
      kind,
      model: "global.anthropic.claude-sonnet-4-6",
      maxEstimatedSessionCostUsd: 1,
      invocationLimits: {
        maxIterations: 8,
        maxOutputTokens: 4096,
        timeoutSeconds: 300,
      },
      agentCoreProfile: {
        profileId: "profile",
        region: "us-east-1",
        accountId: "123456789012",
        harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/test",
        harnessVersion: "1",
        endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/test",
        endpointQualifier: "1",
        agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
        memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test",
        memoryId: "memory",
        invocationRoleArn: "arn:aws:iam::123456789012:role/runner",
        contextBucket: "context-bucket",
        contextPrefix: "companies/company/profiles/profile",
        contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
        qualificationRevision: "aws-agentcore-harness-v1",
        eventExpiryDays: 90,
      },
    },
  };
}

describe("native backend factory", () => {
  it("constructs the Codex backend without starting its transport", async () => {
    const backend = createNativeSessionBackend(execution(), {
      codexTransportFactory: () => {
        throw new Error("descriptor must not launch the transport");
      },
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name: "codex_app_server",
      version: "codex-v2",
      capabilities: {
        collaborationModes: ["default", "plan"],
      },
    });
  });

  it("requires an explicit runtime root for OpenCode", () => {
    expect(() =>
      createNativeSessionBackend(opencodeExecution()),
    ).toThrow("OpenCode native backend requires an instance runtime directory");
  });

  it("routes OpenCode through runnerd when a durable transport is supplied", async () => {
    const backend = createNativeSessionBackend(opencodeExecution(), {
      codexTransportFactory: () => {
        throw new Error("descriptor must not launch the transport");
      },
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name: "opencode_server",
      version: "1.18.17",
      capabilities: {
        steering: false,
        resume: true,
        interruption: true,
        dynamicTools: true,
      },
    });
  });

  it.each([
    ["claude_managed" as const, "claude_managed_agents_api", "managed-agents-2026-04-01"],
    ["aws_agentcore" as const, "aws_agentcore_harness_api", "aws-agentcore-harness-v1"],
  ])("routes %s through runnerd", async (kind, name, version) => {
    const backend = createNativeSessionBackend(managedExecution(kind), {
      codexTransportFactory: () => {
        throw new Error("descriptor must not launch the transport");
      },
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name,
      version,
      capabilities: {
        steering: false,
        resume: true,
        interruption: true,
        dynamicTools: true,
      },
    });
  });

  it("constructs the OpenCode backend without starting its process", async () => {
    const backend = createNativeSessionBackend(opencodeExecution(), {
      opencodeRuntimeDirectory: "/runtime",
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name: "opencode_server",
      version: "1.18.17",
      capabilities: {
        resume: true,
        interruption: true,
        dynamicTools: true,
      },
    });
  });

  it("constructs the qualified Codex ACPX backend without starting ACPX", async () => {
    const backend = createNativeSessionBackend(acpxExecution(), {
      acpxRuntimeDirectory: "/runtime",
    });

    await expect(backend.descriptor()).resolves.toMatchObject({
      kind: "runner",
      name: "acpx_runtime",
      version: "0.13.1",
      capabilities: {
        resume: true,
        interruption: true,
        dynamicTools: true,
      },
    });
  });

  it.each(["codex" as const, "claude" as const])(
    "routes qualified %s ACPX through runnerd",
    async (agent) => {
      const backend = createNativeSessionBackend(acpxExecution(agent), {
        codexTransportFactory: () => {
          throw new Error("descriptor must not launch the transport");
        },
      });

      await expect(backend.descriptor()).resolves.toMatchObject({
        name: "acpx_runtime",
        version: "0.13.1",
        capabilities: {
          steering: false,
          resume: true,
          interruption: true,
          dynamicTools: true,
        },
      });
    },
  );

  it("requires an explicit runtime root", () => {
    expect(() => createNativeSessionBackend(acpxExecution())).toThrow(
      "requires an instance runtime directory",
    );
  });

  it.each(["claude" as const])(
    "constructs the qualified %s ACPX backend",
    async (agent) => {
      const backend = createNativeSessionBackend(acpxExecution(agent), {
        acpxRuntimeDirectory: "/runtime",
      });

      await expect(backend.descriptor()).resolves.toMatchObject({
        name: "acpx_runtime",
        version: "0.13.1",
      });
    },
  );

  it("rejects Pi before constructing an ACPX backend", () => {
    expect(() =>
      createNativeSessionBackend(acpxExecution("pi"), {
        acpxRuntimeDirectory: "/runtime",
      }),
    ).toThrow("descriptor-confined verified launch");
  });

  it("rejects a Codex ACPX snapshot that drifts from its qualified profile", () => {
    const input = acpxExecution();
    if (input.provider.kind !== "acpx") throw new Error("invalid fixture");
    input.provider.profile.commandDigest = `sha256:${"a".repeat(64)}`;

    expect(() =>
      createNativeSessionBackend(input, {
        acpxRuntimeDirectory: "/runtime",
      }),
    ).toThrow("does not match the qualified commandDigest");
  });

  it("guards the provider-specific constructor as a second boundary", () => {
    expect(() =>
      createCodexNativeSessionBackend(
        execution({
          kind: "opencode",
          model: "openrouter/model",
        }),
      ),
    ).toThrow("Codex native backend requires provider kind codex");
  });
});
