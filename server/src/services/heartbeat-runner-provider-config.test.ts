import { describe, expect, it } from "vitest";

import {
  assertAgentCoreProfileRecoveryBinding,
  assertManagedProfileRecoveryBinding,
  resolvePaperclipRunnerNativeProviderInput,
} from "./native-runtime/provider-profile.js";

describe("Paperclip Runner native provider configuration", () => {
  it("qualifies native Codex only in never-ask mode", () => {
    expect(
      resolvePaperclipRunnerNativeProviderInput({
        backend: "codex_app_server",
        adapterConfig: { provider: "codex", model: "gpt-5.6-sol" },
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      codexApprovalPolicy: "never",
    });
    expect(() =>
      resolvePaperclipRunnerNativeProviderInput({
        backend: "codex_app_server",
        adapterConfig: {
          provider: "codex",
          codexPermissionMode: "on-request",
        },
      }),
    ).toThrow("codexPermissionMode set to never");
  });

  it("requires persisted Claude recovery to use the qualified identity and current profile secret", () => {
    const stored = {
      id: "00000000-0000-4000-8000-000000000001",
      anthropicAgentId: "agent_remote",
      agentVersion: "7",
      environmentId: "env_remote",
      betaVersion: "managed-agents-2026-04-01",
      apiKeySecretId: "00000000-0000-4000-8000-000000000010",
    };
    const snapshot = {
      profileId: stored.id,
      anthropicAgentId: stored.anthropicAgentId,
      agentVersion: stored.agentVersion,
      environmentId: stored.environmentId,
      betaVersion: stored.betaVersion,
    };
    expect(() => assertManagedProfileRecoveryBinding({
      adapterConfig: {
        env: { ANTHROPIC_API_KEY: { secretId: stored.apiKeySecretId } },
      },
      snapshot,
      stored,
    })).not.toThrow();
    expect(() => assertManagedProfileRecoveryBinding({
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: {
            secretId: "00000000-0000-4000-8000-000000000099",
          },
        },
      },
      snapshot,
      stored,
    })).toThrow("current API-key secret");
    expect(() => assertManagedProfileRecoveryBinding({
      adapterConfig: {
        env: { ANTHROPIC_API_KEY: { secretId: stored.apiKeySecretId } },
      },
      snapshot: { ...snapshot, agentVersion: "8" },
      stored,
    })).toThrow("no longer matches");
  });

  it("requires persisted AgentCore recovery to use the same qualified identity", () => {
    const configuration = {
      region: "us-east-1",
      accountId: "123456789012",
      harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-1",
      harnessVersion: "3",
      endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/e-1",
      endpointQualifier: "prod",
      agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/r-1",
      memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m-1",
      memoryId: "m-1",
      invocationRoleArn: "arn:aws:iam::123456789012:role/invoke",
      contextBucket: "paperclip-context",
      contextPrefix: "runner/",
      contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key-1",
      qualificationRevision: "aws-agentcore-harness-context-v2",
      eventExpiryDays: 90,
    };
    const stored = {
      id: "00000000-0000-4000-8000-000000000002",
      configuration,
    };
    const snapshot = { profileId: stored.id, ...configuration };
    expect(() => assertAgentCoreProfileRecoveryBinding({
      snapshot,
      stored,
    })).not.toThrow();
    expect(() => assertAgentCoreProfileRecoveryBinding({
      snapshot: { ...snapshot, harnessVersion: "4" },
      stored,
    })).toThrow("no longer matches");
    expect(() => assertAgentCoreProfileRecoveryBinding({
      snapshot,
      stored: { ...stored, id: "00000000-0000-4000-8000-000000000099" },
    })).toThrow("no longer matches");
  });


  it("projects OpenCode identity, model, and permissions from adapter config", () => {
    expect(
      resolvePaperclipRunnerNativeProviderInput({
        backend: "opencode_server",
        adapterConfig: {
          provider: "opencode",
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
          opencodePermissionMode: "deny",
        },
      }),
    ).toEqual({
      provider: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      opencodePermissionMode: "deny",
    });
  });

  it.each([
    ["claude", "claude-sonnet-5", "approve-all"],
    ["codex", "gpt-5.6-sol", "deny-all"],
  ] as const)(
    "projects the qualified ACPX %s descriptor from adapter config",
    (acpxAgent, model, acpxPermissionMode) => {
      expect(
        resolvePaperclipRunnerNativeProviderInput({
          backend: "acpx_runtime",
          adapterConfig: { provider: "acpx", acpxAgent, model, acpxPermissionMode },
        }),
      ).toEqual({
        provider: "acpx",
        acpxAgent,
        model,
        acpxPermissionMode,
      });
    },
  );

  it("applies the safe provider permission default from adapter config", () => {
    expect(
      resolvePaperclipRunnerNativeProviderInput({
        backend: "opencode_server",
        adapterConfig: {
          provider: "opencode",
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
        },
      }),
    ).toEqual({
      provider: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      opencodePermissionMode: "ask",
    });
  });

  it("materializes a qualified Claude Managed profile without trusting editable resource IDs", () => {
    expect(resolvePaperclipRunnerNativeProviderInput({
      backend: "claude_managed_agents_api",
      adapterConfig: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
        maxSessionListCostUsd: 0.75,
      },
      managedProfile: {
        id: "00000000-0000-4000-8000-000000000001",
        profileKey: "managed-primary",
        anthropicAgentId: "agent_remote",
        agentVersion: "7",
        environmentId: "env_remote",
        betaVersion: "managed-agents-2026-04-01",
        defaultModel: "claude-sonnet-5",
        defaultMaxListCostCents: 100,
      },
    })).toEqual({
      provider: "claude_managed",
      model: "claude-sonnet-5",
      managedProfile: {
        profileId: "00000000-0000-4000-8000-000000000001",
        anthropicAgentId: "agent_remote",
        agentVersion: "7",
        environmentId: "env_remote",
        betaVersion: "managed-agents-2026-04-01",
      },
      maxSessionListCostUsd: 0.75,
    });
  });

  it("materializes a qualified AgentCore profile with bounded invocation limits", () => {
    expect(resolvePaperclipRunnerNativeProviderInput({
      backend: "aws_agentcore_harness_api",
      adapterConfig: {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-primary",
        agentCoreRetentionAcknowledged: true,
        maxIterations: 8,
        maxOutputTokens: 2_048,
        timeoutSeconds: 30,
      },
      agentCoreProfile: {
        id: "00000000-0000-4000-8000-000000000002",
        profileKey: "agentcore-primary",
        configuration: {
          region: "us-east-1",
          accountId: "123456789012",
          harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-1",
          harnessVersion: "3",
          endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/e-1",
          endpointQualifier: "prod",
          agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/r-1",
          memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m-1",
          memoryId: "m-1",
          invocationRoleArn: "arn:aws:iam::123456789012:role/invoke",
          contextBucket: "paperclip-context",
          contextPrefix: "runner/",
          contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key-1",
          qualificationRevision: "aws-agentcore-harness-context-v2",
          defaultModel: "global.anthropic.claude-sonnet-4-6",
          eventExpiryDays: 90,
          defaultMaxEstimatedSessionCostUsd: 1.25,
        },
      },
    })).toMatchObject({
      provider: "aws_agentcore",
      model: "global.anthropic.claude-sonnet-4-6",
      agentCoreProfile: {
        profileId: "00000000-0000-4000-8000-000000000002",
        eventExpiryDays: 90,
      },
      maxEstimatedSessionCostUsd: 1.25,
      invocationLimits: {
        maxIterations: 8,
        maxOutputTokens: 2_048,
        timeoutSeconds: 30,
      },
    });
  });

  it.each([
    ["maxIterations", 0],
    ["maxIterations", 9],
    ["maxIterations", "8"],
    ["maxOutputTokens", 4_097],
    ["timeoutSeconds", 301],
  ])("rejects an unsafe AgentCore %s override", (field, value) => {
    expect(() => resolvePaperclipRunnerNativeProviderInput({
      backend: "aws_agentcore_harness_api",
      adapterConfig: {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-primary",
        agentCoreRetentionAcknowledged: true,
        [field]: value,
      },
      agentCoreProfile: {
        id: "00000000-0000-4000-8000-000000000002",
        profileKey: "agentcore-primary",
        configuration: {
          region: "us-east-1",
          accountId: "123456789012",
          harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-1",
          harnessVersion: "3",
          endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/e-1",
          endpointQualifier: "prod",
          agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/r-1",
          memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m-1",
          memoryId: "m-1",
          invocationRoleArn: "arn:aws:iam::123456789012:role/invoke",
          contextBucket: "paperclip-context",
          contextPrefix: "runner/",
          contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key-1",
          qualificationRevision: "aws-agentcore-harness-context-v2",
          defaultModel: "global.anthropic.claude-sonnet-4-6",
          eventExpiryDays: 90,
          defaultMaxEstimatedSessionCostUsd: 1.25,
        },
      },
    })).toThrow("must be an integer between");
  });

  it("rejects managed providers without retention acknowledgement or a matching stored profile", () => {
    expect(() => resolvePaperclipRunnerNativeProviderInput({
      backend: "claude_managed_agents_api",
      adapterConfig: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
      },
    })).toThrow("requires acknowledgement");

    expect(() => resolvePaperclipRunnerNativeProviderInput({
      backend: "aws_agentcore_harness_api",
      adapterConfig: {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-primary",
        agentCoreRetentionAcknowledged: true,
      },
    })).toThrow("does not match the adapter selection");
  });

  it("rejects managed provider model overrides outside the runner allowlist", () => {
    expect(() => resolvePaperclipRunnerNativeProviderInput({
      backend: "claude_managed_agents_api",
      adapterConfig: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
        model: "claude-opus-5",
      },
      managedProfile: {
        id: "00000000-0000-4000-8000-000000000001",
        profileKey: "managed-primary",
        anthropicAgentId: "agent_remote",
        agentVersion: "7",
        environmentId: "env_remote",
        betaVersion: "managed-agents-2026-04-01",
        defaultModel: "claude-sonnet-5",
        defaultMaxListCostCents: 100,
      },
    })).toThrow("requires exact model claude-sonnet-5");

    expect(() => resolvePaperclipRunnerNativeProviderInput({
      backend: "aws_agentcore_harness_api",
      adapterConfig: {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-primary",
        agentCoreRetentionAcknowledged: true,
        model: "global.anthropic.claude-opus-5",
      },
      agentCoreProfile: {
        id: "00000000-0000-4000-8000-000000000002",
        profileKey: "agentcore-primary",
        configuration: {
          region: "us-east-1",
          accountId: "123456789012",
          harnessArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/h-1",
          harnessVersion: "3",
          endpointArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/e-1",
          endpointQualifier: "prod",
          agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/r-1",
          memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/m-1",
          memoryId: "m-1",
          invocationRoleArn: "arn:aws:iam::123456789012:role/invoke",
          contextBucket: "paperclip-context",
          contextPrefix: "runner/",
          contextKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key-1",
          qualificationRevision: "aws-agentcore-harness-context-v2",
          defaultModel: "global.anthropic.claude-sonnet-4-6",
          eventExpiryDays: 90,
          defaultMaxEstimatedSessionCostUsd: 1.25,
        },
      },
    })).toThrow("requires exact model global.anthropic.claude-sonnet-4-6");
  });

  it("fails closed when the persisted backend and current provider disagree", () => {
    expect(() =>
      resolvePaperclipRunnerNativeProviderInput({
        backend: "opencode_server",
        adapterConfig: { provider: "codex" },
      }),
    ).toThrow("provider changed after this run selected its native backend");
  });

  it("rejects Pi before a native descriptor is persisted", () => {
    expect(() =>
      resolvePaperclipRunnerNativeProviderInput({
        backend: "acpx_runtime",
        adapterConfig: { provider: "acpx", acpxAgent: "pi", model: "pi-model" },
      }),
    ).toThrow("Pi is not available");
  });
});
