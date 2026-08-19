import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSkillMentionHref } from "@paperclipai/shared";
import {
  LOW_TRUST_REVIEW_PRESET,
  applyRunScopedMentionedSkillKeys,
  buildReferencedProjectRunObservability,
  buildRunWorkspaceHints,
  extractMentionedSkillIdsFromSources,
  resolveAdditionalProjectWorkspace,
  resolveAdditionalRunWorkspaces,
  resolveExecutionRunAdapterConfig,
  type ResolveAdditionalProjectWorkspaceDeps,
  type ResolveAdditionalRunWorkspacesOptions,
  type ResolvedAdditionalWorkspace,
  type RunReferencedProject,
} from "../services/heartbeat.ts";
import type { AuthorizationActor, AuthorizationDecision } from "../services/authorization.ts";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.ts";

describe("resolveExecutionRunAdapterConfig", () => {
  it("overlays environment, project, and routine env on top of agent env and unions secret keys", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: {
        env: {
          SHARED_KEY: "agent",
          AGENT_ONLY: "agent-only",
        },
        other: "value",
      },
      secretKeys: new Set(["AGENT_SECRET"]),
      manifest: [
        {
          configPath: "env.AGENT_SECRET",
          envKey: "AGENT_SECRET",
          secretId: "secret-agent",
          secretKey: "agent-secret",
          version: 1,
          provider: "local_encrypted",
          outcome: "success",
        },
      ],
    });
    const resolveEnvBindings = vi
      .fn()
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "environment",
          ENV_ONLY: "environment-only",
        },
        secretKeys: new Set(["ENV_SECRET"]),
        manifest: [
          {
            configPath: "env.ENV_SECRET",
            envKey: "ENV_SECRET",
            secretId: "secret-environment",
            secretKey: "environment-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      })
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "project",
          PROJECT_ONLY: "project-only",
        },
        secretKeys: new Set(["PROJECT_SECRET"]),
        manifest: [
          {
            configPath: "env.PROJECT_SECRET",
            envKey: "PROJECT_SECRET",
            secretId: "secret-project",
            secretKey: "project-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      })
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "routine",
          ROUTINE_ONLY: "routine-only",
        },
        secretKeys: new Set(["ROUTINE_SECRET"]),
        manifest: [
          {
            configPath: "env.ROUTINE_SECRET",
            envKey: "ROUTINE_SECRET",
            secretId: "secret-routine",
            secretKey: "routine-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { SHARED_KEY: "agent" } },
      environmentId: "environment-1",
      environmentEnv: { SHARED_KEY: "environment" },
      projectEnv: { SHARED_KEY: "project" },
      routineEnv: { SHARED_KEY: "routine" },
      routineId: "routine-1",
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig).toMatchObject({
      other: "value",
      env: {
        SHARED_KEY: "routine",
        ENV_ONLY: "environment-only",
        AGENT_ONLY: "agent-only",
        PROJECT_ONLY: "project-only",
        ROUTINE_ONLY: "routine-only",
      },
    });
    expect(Array.from(result.secretKeys).sort()).toEqual(["AGENT_SECRET", "ENV_SECRET", "PROJECT_SECRET", "ROUTINE_SECRET"]);
    expect(result.secretManifest.map((entry) => entry.secretId).sort()).toEqual([
      "secret-agent",
      "secret-environment",
      "secret-project",
      "secret-routine",
    ]);
    expect(JSON.stringify(result.secretManifest)).not.toContain("agent-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("environment-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("project-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("routine-only");
    expect(resolveEnvBindings.mock.calls[0]?.[2]).toMatchObject({
      consumerType: "environment",
      consumerId: "environment-1",
    });
    expect(resolveEnvBindings.mock.calls[2]?.[2]).toMatchObject({
      consumerType: "routine",
      consumerId: "routine-1",
    });
  });

  it("drops PAPERCLIP_API_KEY bindings but forwards other PAPERCLIP_-named env to resolution", async () => {
    const resolveAdapterConfigForRuntime = vi.fn(async (_companyId, config: Record<string, unknown>) => ({
      config: {
        ...config,
        env: { ...(config.env as Record<string, unknown>) },
      },
      secretKeys: new Set<string>(),
      manifest: [],
    }));
    const resolveEnvBindings = vi.fn(async (_companyId, env: Record<string, unknown>) => ({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      secretKeys: new Set<string>(),
      manifest: [],
    }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      environmentId: "environment-1",
      environmentEnv: {
        PAPERCLIP_API_KEY: "environment-api-key",
        PAPERCLIP_CLOUD_PROVIDER_TOKEN_ENV: "environment-cloud",
        ENV_ONLY: "environment-only",
      },
      executionRunConfig: {
        env: {
          PAPERCLIP_API_KEY: { type: "secret_ref", secretId: "secret-api-key", version: "latest" },
          PAPERCLIP_CLOUD_PROVIDER_TOKEN_AGENT: "agent-cloud",
          AGENT_ONLY: "agent-only",
        },
      },
      projectEnv: {
        PAPERCLIP_API_KEY: "project-api-key",
        PAPERCLIP_CLOUD_PROVIDER_TOKEN_PROJECT: "project-cloud",
        PROJECT_ONLY: "project-only",
      },
      routineEnv: {
        PAPERCLIP_API_KEY: "routine-api-key",
        PAPERCLIP_CLOUD_PROVIDER_TOKEN_ROUTINE: "routine-cloud",
        ROUTINE_ONLY: "routine-only",
      },
      routineId: "routine-1",
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(resolveEnvBindings.mock.calls[0]?.[1]).toEqual({
      PAPERCLIP_CLOUD_PROVIDER_TOKEN_ENV: "environment-cloud",
      ENV_ONLY: "environment-only",
    });
    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[1]).toEqual({
      env: {
        PAPERCLIP_CLOUD_PROVIDER_TOKEN_AGENT: "agent-cloud",
        AGENT_ONLY: "agent-only",
      },
    });
    expect(resolveEnvBindings.mock.calls[1]?.[1]).toEqual({
      PAPERCLIP_CLOUD_PROVIDER_TOKEN_PROJECT: "project-cloud",
      PROJECT_ONLY: "project-only",
    });
    expect(resolveEnvBindings.mock.calls[2]?.[1]).toEqual({
      PAPERCLIP_CLOUD_PROVIDER_TOKEN_ROUTINE: "routine-cloud",
      ROUTINE_ONLY: "routine-only",
    });
    expect(result.resolvedConfig.env).toEqual({
      PAPERCLIP_CLOUD_PROVIDER_TOKEN_ENV: "environment-cloud",
      ENV_ONLY: "environment-only",
      PAPERCLIP_CLOUD_PROVIDER_TOKEN_AGENT: "agent-cloud",
      AGENT_ONLY: "agent-only",
      PAPERCLIP_CLOUD_PROVIDER_TOKEN_PROJECT: "project-cloud",
      PROJECT_ONLY: "project-only",
      PAPERCLIP_CLOUD_PROVIDER_TOKEN_ROUTINE: "routine-cloud",
      ROUTINE_ONLY: "routine-only",
    });
    expect(JSON.stringify(result.resolvedConfig.env)).not.toContain("PAPERCLIP_API_KEY");
  });

  it("skips project env resolution when the project has no bindings", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn();

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({ AGENT_ONLY: "agent-only" });
    expect(result.secretManifest).toEqual([]);
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("passes low-trust allowed secret binding ids into all runtime secret contexts", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: {} },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: {},
      secretKeys: new Set<string>(),
      manifest: [],
    });

    await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      environmentId: "environment-1",
      projectId: "project-1",
      routineId: "routine-1",
      executionRunConfig: { env: {} },
      environmentEnv: { ENVIRONMENT_FLAG: "plain" },
      projectEnv: { PROJECT_FLAG: "plain" },
      routineEnv: { ROUTINE_FLAG: "plain" },
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
          allowedSecretBindingIds: ["binding-1"],
        },
        sourcePresets: {},
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[0]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[1]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[2]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
  });

  it("blocks required missing user secrets before runtime env resolution", async () => {
    const resolveAdapterConfigForRuntime = vi.fn();
    const resolveEnvBindings = vi.fn();
    const collectMissingRuntimeBindings = vi.fn(async (_companyId, _env, context) =>
      context.consumerType === "agent"
        ? [
            {
              consumerType: "agent",
              consumerId: "agent-1",
              configPath: "env.GITHUB_TOKEN",
              envKey: "GITHUB_TOKEN",
              bindingType: "user_secret_ref",
              secretId: null,
              secretName: null,
              userSecretDefinitionId: "definition-1",
              userSecretDefinitionKey: "github_token",
              userSecretDefinitionName: "GitHub token",
              responsibleUserId: context.responsibleUserId,
              errorCode: "user_secret_missing",
            },
          ]
        : [],
    );

    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      responsibleUserId: "user-1",
      executionRunConfig: {
        env: {
          GITHUB_TOKEN: { type: "user_secret_ref", key: "github_token", required: true },
        },
      },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
        collectMissingRuntimeBindings,
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      resultJson: {
        configurationIncomplete: {
          reason: "secret_binding_missing",
          companyId: "company-1",
          agentId: "agent-1",
          issueId: "issue-1",
          missingBindings: [
            expect.objectContaining({
              bindingType: "user_secret_ref",
              userSecretDefinitionKey: "github_token",
              responsibleUserId: "user-1",
            }),
          ],
        },
      },
    });
    expect(collectMissingRuntimeBindings.mock.calls[0]?.[2]).toMatchObject({
      responsibleUserId: "user-1",
    });
    expect(resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("rejects inline sensitive env values for low-trust runs", async () => {
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: {
        env: {
          OPENAI_API_KEY: "inline-secret",
        },
      },
      projectEnv: null,
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
        },
        sourcePresets: {},
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as any,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "low_trust_inline_sensitive_env_denied" },
    });
  });

  it("fails push-capability preflight when no GitHub write credential is bound at any supported scope", async () => {
    const getByNameInsensitive = vi.fn().mockResolvedValue(null);
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: { PROJECT_ONLY: "project-only" },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation:
          "No GH_TOKEN/GITHUB_TOKEN binding at agent, project, environment, or routine scope; no company secret named GITHUB_TOKEN, GH_TOKEN, or PAPERCLIP_GITHUB_TOKEN.",
        fallbackSecretNames: ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"],
        fallbackInjectionEnvKey: "GH_TOKEN",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
        getByNameInsensitive,
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      message: expect.stringMatching(/agent, project, environment, or routine scope.*GITHUB_TOKEN, GH_TOKEN, or PAPERCLIP_GITHUB_TOKEN/),
      resultJson: {
        configurationIncomplete: {
          reason: "push_write_credential_missing",
          requiredEnvKeys: ["GH_TOKEN", "GITHUB_TOKEN"],
          requiredScopes: ["agent", "project", "environment", "routine"],
          missingBindings: [],
        },
      },
    });
    expect(getByNameInsensitive.mock.calls.map((call) => call[1])).toEqual([
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "PAPERCLIP_GITHUB_TOKEN",
    ]);
  });

  it("does not accept a lowercase GitHub credential binding key", async () => {
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      environmentId: "environment-1",
      routineId: "routine-1",
      executionRunConfig: { env: { gh_token: "agent-token" } },
      environmentEnv: { gh_token: "environment-token" },
      projectEnv: { gh_token: "project-token" },
      routineEnv: { gh_token: "routine-token" },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation:
          "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at agent, project, environment, or routine scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      resultJson: {
        configurationIncomplete: {
          reason: "push_write_credential_missing",
        },
      },
    });
  });

  it("passes push-capability preflight when a project-scoped GitHub credential is configured", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { GH_TOKEN: "github-token" },
      secretKeys: new Set(["GH_TOKEN"]),
      manifest: [],
    });
    const collectMissingRuntimeBindings = vi.fn().mockResolvedValue([]);

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      projectId: "project-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: { GH_TOKEN: { type: "plain", value: "github-token" } },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation:
          "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at agent, project, environment, or routine scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
        collectMissingRuntimeBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      AGENT_ONLY: "agent-only",
      GH_TOKEN: "github-token",
    });
    expect(resolveEnvBindings).toHaveBeenCalledOnce();
    expect(collectMissingRuntimeBindings).toHaveBeenCalledTimes(2);
    expect(collectMissingRuntimeBindings.mock.calls[1]?.[2]).toMatchObject({
      consumerType: "project",
      consumerId: "project-1",
    });
  });

  it("passes push-capability preflight for an environment-scoped GitHub credential", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { GH_TOKEN: "environment-token" },
      secretKeys: new Set(["GH_TOKEN"]),
      manifest: [],
    });
    const collectMissingRuntimeBindings = vi.fn().mockResolvedValue([]);

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      environmentId: "environment-1",
      environmentEnv: { GH_TOKEN: { type: "plain", value: "environment-token" } },
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation:
          "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at agent, project, environment, or routine scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
        collectMissingRuntimeBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      GH_TOKEN: "environment-token",
      AGENT_ONLY: "agent-only",
    });
    expect(resolveEnvBindings).toHaveBeenCalledOnce();
    expect(collectMissingRuntimeBindings.mock.calls[0]?.[2]).toMatchObject({
      consumerType: "environment",
      consumerId: "environment-1",
    });
  });

  it("passes push-capability preflight for a routine-scoped GitHub credential", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { GITHUB_TOKEN: "routine-token" },
      secretKeys: new Set(["GITHUB_TOKEN"]),
      manifest: [],
    });
    const collectMissingRuntimeBindings = vi.fn().mockResolvedValue([]);

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      routineId: "routine-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      routineEnv: { GITHUB_TOKEN: { type: "plain", value: "routine-token" } },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation:
          "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at agent, project, environment, or routine scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
        collectMissingRuntimeBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      AGENT_ONLY: "agent-only",
      GITHUB_TOKEN: "routine-token",
    });
    expect(resolveEnvBindings).toHaveBeenCalledOnce();
    expect(collectMissingRuntimeBindings.mock.calls[1]?.[2]).toMatchObject({
      consumerType: "routine",
      consumerId: "routine-1",
    });
  });

  it("auto-injects a lowercase well-known company secret through the audited secret-ref path", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveInjectedEnvBindingForRuntime = vi.fn().mockResolvedValue({
      env: { GH_TOKEN: "resolved-token" },
      secretKeys: new Set(["GH_TOKEN"]),
      manifest: [{
        configPath: "env.GH_TOKEN",
        envKey: "GH_TOKEN",
        secretId: "secret-lowercase",
        bindingId: null,
        secretKey: "gh_token",
        version: 1,
        provider: "local_encrypted",
        outcome: "success",
      }],
    });
    const getByNameInsensitive = vi.fn(async (_companyId: string, name: string) =>
      name === "GH_TOKEN"
        ? { id: "secret-lowercase", name: "gh_token" }
        : null,
    );

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation: "No GitHub credential found.",
        fallbackSecretNames: ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"],
        fallbackInjectionEnvKey: "GH_TOKEN",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        resolveInjectedEnvBindingForRuntime,
        getByNameInsensitive,
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      AGENT_ONLY: "agent-only",
      GH_TOKEN: "resolved-token",
    });
    expect(result.secretKeys).toEqual(new Set(["GH_TOKEN"]));
    expect(result.secretManifest).toEqual([
      expect.objectContaining({
        configPath: "env.GH_TOKEN",
        secretId: "secret-lowercase",
        outcome: "success",
      }),
    ]);
    expect(resolveAdapterConfigForRuntime).toHaveBeenCalledWith(
      "company-1",
      { env: { AGENT_ONLY: "agent-only" } },
      expect.any(Object),
      expect.any(Object),
    );
    expect(resolveInjectedEnvBindingForRuntime).toHaveBeenCalledWith(
      "company-1",
      "GH_TOKEN",
      {
        type: "secret_ref",
        secretId: "secret-lowercase",
        version: "latest",
      },
      expect.objectContaining({
        consumerType: "run",
        consumerId: "run-1",
        heartbeatRunId: "run-1",
      }),
      null,
    );
    expect(JSON.stringify(resolveInjectedEnvBindingForRuntime.mock.calls[0]?.[2])).not.toContain("resolved-token");
  });

  it("does not satisfy the well-known-secret tier outside a low-trust binding allowlist", async () => {
    const resolveInjectedEnvBindingForRuntime = vi.fn();
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: { env: {} },
      projectEnv: null,
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
          allowedSecretBindingIds: ["allowed-binding"],
        },
        sourcePresets: {},
      },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation: "No GitHub credential found.",
        fallbackSecretNames: ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"],
        fallbackInjectionEnvKey: "GH_TOKEN",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
        resolveInjectedEnvBindingForRuntime,
        getByNameInsensitive: vi.fn().mockResolvedValue({ id: "secret-1", name: "gh_token" }),
        listBindings: vi.fn().mockResolvedValue([{
          id: "allowed-binding",
          targetType: "project",
          targetId: "other-project",
          configPath: "env.GH_TOKEN",
        }]),
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      resultJson: {
        configurationIncomplete: {
          reason: "push_write_credential_missing",
        },
      },
    });
    expect(resolveInjectedEnvBindingForRuntime).not.toHaveBeenCalled();
  });

  it("injects a low-trust fallback only through an allowlisted binding for the active target and env path", async () => {
    const resolveInjectedEnvBindingForRuntime = vi.fn().mockResolvedValue({
      env: { GH_TOKEN: "resolved-token" },
      secretKeys: new Set(["GH_TOKEN"]),
      manifest: [{ secretId: "secret-1", bindingId: "allowed-binding", outcome: "success" }],
    });
    await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      executionRunConfig: { env: {} },
      projectEnv: null,
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
          allowedSecretBindingIds: ["allowed-binding"],
        },
        sourcePresets: {},
      },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation: "No GitHub credential found.",
        fallbackSecretNames: ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"],
        fallbackInjectionEnvKey: "GH_TOKEN",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn().mockResolvedValue({
          config: { env: {} },
          secretKeys: new Set<string>(),
          manifest: [],
        }),
        resolveEnvBindings: vi.fn(),
        resolveInjectedEnvBindingForRuntime,
        getByNameInsensitive: vi.fn().mockResolvedValue({ id: "secret-1", name: "gh_token" }),
        listBindings: vi.fn().mockResolvedValue([{
          id: "allowed-binding",
          targetType: "agent",
          targetId: "agent-1",
          configPath: "env.GH_TOKEN",
        }]),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });

    expect(resolveInjectedEnvBindingForRuntime).toHaveBeenCalledWith(
      "company-1",
      "GH_TOKEN",
      expect.objectContaining({ type: "secret_ref", secretId: "secret-1" }),
      expect.objectContaining({ consumerType: "run", consumerId: "run-1" }),
      {
        bindingId: "allowed-binding",
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.GH_TOKEN",
      },
    );
  });

  it("does not authorize a GH_TOKEN injection with an allowlisted GITHUB_TOKEN binding", async () => {
    const resolveInjectedEnvBindingForRuntime = vi.fn();
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      executionRunConfig: { env: {} },
      projectEnv: null,
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
          allowedSecretBindingIds: ["allowed-binding"],
        },
        sourcePresets: {},
      },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation: "No GitHub credential found.",
        fallbackSecretNames: ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"],
        fallbackInjectionEnvKey: "GH_TOKEN",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
        resolveInjectedEnvBindingForRuntime,
        getByNameInsensitive: vi.fn().mockResolvedValue({ id: "secret-1", name: "gh_token" }),
        listBindings: vi.fn().mockResolvedValue([{
          id: "allowed-binding",
          targetType: "agent",
          targetId: "agent-1",
          configPath: "env.GITHUB_TOKEN",
        }]),
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      resultJson: {
        configurationIncomplete: {
          reason: "push_write_credential_missing",
        },
      },
    });
    expect(resolveInjectedEnvBindingForRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["agent", "empty string", { executionRunConfig: { env: { GH_TOKEN: "" } } }],
    ["agent", "empty plain binding", { executionRunConfig: { env: { GITHUB_TOKEN: { type: "plain", value: "" } } } }],
    ["project", "empty string", { projectEnv: { GH_TOKEN: "" } }],
    ["project", "empty plain binding", { projectEnv: { GITHUB_TOKEN: { type: "plain", value: "" } } }],
    ["environment", "empty string", { environmentEnv: { GH_TOKEN: "" } }],
    ["environment", "empty plain binding", { environmentEnv: { GITHUB_TOKEN: { type: "plain", value: "" } } }],
    ["routine", "empty string", { routineEnv: { GH_TOKEN: "" } }],
    ["routine", "empty plain binding", { routineEnv: { GITHUB_TOKEN: { type: "plain", value: "" } } }],
  ])("fails closed for an explicit %s-scoped %s instead of injecting a company secret", async (_scope, _binding, scopeConfig) => {
    const getByNameInsensitive = vi.fn().mockResolvedValue({ id: "secret-1", name: "GH_TOKEN" });
    const resolveInjectedEnvBindingForRuntime = vi.fn();

    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      projectId: "project-1",
      environmentId: "environment-1",
      routineId: "routine-1",
      executionRunConfig: { env: {} },
      projectEnv: null,
      ...scopeConfig,
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation: "No GitHub credential found.",
        fallbackSecretNames: ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"],
        fallbackInjectionEnvKey: "GH_TOKEN",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
        resolveInjectedEnvBindingForRuntime,
        getByNameInsensitive,
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      resultJson: {
        configurationIncomplete: {
          reason: "push_write_credential_missing",
        },
      },
    });
    expect(getByNameInsensitive).not.toHaveBeenCalled();
    expect(resolveInjectedEnvBindingForRuntime).not.toHaveBeenCalled();
  });

  it("skips well-known-secret injection when a supported-scope binding exists", async () => {
    const getByNameInsensitive = vi.fn();
    const resolveInjectedEnvBindingForRuntime = vi.fn();
    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      environmentId: "environment-1",
      environmentEnv: { GH_TOKEN: { type: "plain", value: "environment-token" } },
      executionRunConfig: { env: {} },
      projectEnv: null,
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project", "environment", "routine"],
        reason: "push_write_credential_missing",
        remediation: "No GitHub credential found.",
        fallbackSecretNames: ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"],
        fallbackInjectionEnvKey: "GH_TOKEN",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn().mockResolvedValue({
          config: { env: {} },
          secretKeys: new Set<string>(),
          manifest: [],
        }),
        resolveEnvBindings: vi.fn().mockResolvedValue({
          env: { GH_TOKEN: "environment-token" },
          secretKeys: new Set(["GH_TOKEN"]),
          manifest: [],
        }),
        resolveInjectedEnvBindingForRuntime,
        getByNameInsensitive,
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({ GH_TOKEN: "environment-token" });
    expect(getByNameInsensitive).not.toHaveBeenCalled();
    expect(resolveInjectedEnvBindingForRuntime).not.toHaveBeenCalled();
  });
});

describe("resolveExecutionRunAdapterConfig codex_local credential pre-dispatch gate", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function stubManagedCodexEnv(options: { seedSharedAuth: boolean }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-gate-"));
    cleanupDirs.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    await fs.mkdir(sharedCodexHome, { recursive: true });
    if (options.seedSharedAuth) {
      await fs.writeFile(
        path.join(sharedCodexHome, "auth.json"),
        '{"OPENAI_API_KEY":"sk-shared"}\n',
        "utf8",
      );
    }
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", sharedCodexHome);
    const managedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    return { root, managedAgentHome };
  }

  it("does not gate sandbox-destined runs on host credentials — the sandbox image may carry its own login", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    await expect(
      resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "codex_local",
        issueId: "issue-1",
        responsibleUserId: "user-1",
        environmentDriver: "sandbox",
        executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
        projectEnv: null,
        secretsSvc: {
          resolveAdapterConfigForRuntime,
          resolveEnvBindings: vi.fn(),
          collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
        } as any,
      }),
    ).resolves.toMatchObject({
      resolvedConfig: expect.objectContaining({ command: "codex" }),
    });
  });

  it("surfaces a configuration-incomplete blocker when a managed home has no auth and OPENAI_API_KEY is empty", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    await expect(
      resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "codex_local",
        issueId: "issue-1",
        responsibleUserId: "user-1",
        executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
        projectEnv: null,
        secretsSvc: {
          resolveAdapterConfigForRuntime,
          resolveEnvBindings: vi.fn(),
          collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
        } as any,
      }),
    ).rejects.toMatchObject({
      code: "configuration_incomplete",
      message: expect.stringContaining("no Codex credentials available"),
      resultJson: {
        configurationIncomplete: {
          reason: "codex_credentials_missing",
          adapterType: "codex_local",
          companyId: "company-1",
          agentId: "agent-1",
          issueId: "issue-1",
          responsibleUserId: "user-1",
          requiredEnvKeys: ["OPENAI_API_KEY"],
        },
      },
    });
    // The blocker message must not leak any secret value.
    await expect(
      resolveExecutionRunAdapterConfig({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "codex_local",
        executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
        projectEnv: null,
        secretsSvc: {
          resolveAdapterConfigForRuntime,
          resolveEnvBindings: vi.fn(),
          collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
        } as any,
      }).catch((err) => err.message),
    ).resolves.not.toContain("sk-");
  });

  it("dispatches normally when a per-agent OPENAI_API_KEY is resolved", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "sk-agent-resolved" } },
      secretKeys: new Set(["OPENAI_API_KEY"]),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "codex_local",
      executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: { type: "secret_ref" } } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });
    expect(result.resolvedConfig.env).toMatchObject({ OPENAI_API_KEY: "sk-agent-resolved" });
  });

  it("dispatches normally when the shared host home carries subscription auth", async () => {
    const { managedAgentHome } = await stubManagedCodexEnv({ seedSharedAuth: true });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "codex_local",
      executionRunConfig: { command: "codex", env: { CODEX_HOME: managedAgentHome, OPENAI_API_KEY: "" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });
    expect(result.resolvedConfig.command).toBe("codex");
  });

  it("does not gate non-codex adapters", async () => {
    await stubManagedCodexEnv({ seedSharedAuth: false });
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { command: "claude", env: { OPENAI_API_KEY: "" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      adapterType: "claude_local",
      executionRunConfig: { command: "claude", env: { OPENAI_API_KEY: "" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings: vi.fn(),
        collectMissingRuntimeBindings: vi.fn().mockResolvedValue([]),
      } as any,
    });
    expect(result.resolvedConfig.command).toBe("claude");
  });
});

describe("extractMentionedSkillIdsFromSources", () => {
  it("collects UUID skill mention ids across issue sources", () => {
    const releaseSkillId = "11111111-1111-4111-8111-111111111111";
    const browserSkillId = "22222222-2222-4222-8222-222222222222";
    const releaseHref = buildSkillMentionHref(releaseSkillId, "release-changelog");
    const browserHref = buildSkillMentionHref(browserSkillId, "agent-browser");

    expect(
      extractMentionedSkillIdsFromSources([
        `Please use [/release-changelog](${releaseHref})`,
        `And also [/agent-browser](${browserHref})`,
        `Duplicate mention [/release-changelog](${releaseHref})`,
      ]),
    ).toEqual([releaseSkillId, browserSkillId]);
  });

  it("ignores legacy non-UUID skill mention ids before runtime database lookup", () => {
    const validSkillId = "33333333-3333-4333-8333-333333333333";
    const validHref = buildSkillMentionHref(validSkillId, "greploop");
    const legacyHref = buildSkillMentionHref("skill-greploop", "greploop");

    expect(
      extractMentionedSkillIdsFromSources([
        `Use [/greploop](${legacyHref}) and [/prcheckloop](${validHref})`,
      ]),
    ).toEqual([validSkillId]);
  });
});

describe("applyRunScopedMentionedSkillKeys", () => {
  it("adds mentioned skills without mutating the original config", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/release-changelog",
      "paperclipai/paperclip/paperclip",
      "company/company-1/release-changelog",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          "paperclipai/paperclip/paperclip",
          "company/company-1/release-changelog",
        ],
      },
    });
    expect(originalConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    });
  });

  it("preserves existing version pins when adding mentioned skills", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          { key: "company/company-1/release-changelog", versionId: "version-1" },
        ],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/security-review",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          { key: "company/company-1/release-changelog", versionId: "version-1" },
          { key: "company/company-1/security-review", versionId: null },
        ],
      },
    });
  });
});

describe("resolveAdditionalRunWorkspaces", () => {
  const companyId = "company-1";
  const issueId = "issue-1";

  const allowDecision: AuthorizationDecision = {
    allowed: true,
    action: "project:read",
    reason: "allow_company_agent",
    explanation: "test allow",
  };

  // Build injectable dependencies. Every mentioned project is available and authorized by default.
  function buildOptions(
    overrides: Partial<ResolveAdditionalRunWorkspacesOptions> & { mentionedIds?: string[] },
  ): ResolveAdditionalRunWorkspacesOptions {
    const mentionedIds = overrides.mentionedIds ?? [];
    const actor: AuthorizationActor = {
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    };
    const issues: ResolveAdditionalRunWorkspacesOptions["issues"] = {
      findMentionedProjectIds: async () => mentionedIds,
    };
    const projects: ResolveAdditionalRunWorkspacesOptions["projects"] = {
      listByIds: async (_companyId, ids) =>
        ids.map((id) => ({ id })) as unknown as Awaited<
          ReturnType<ResolveAdditionalRunWorkspacesOptions["projects"]["listByIds"]>
        >,
    };
    const access: ResolveAdditionalRunWorkspacesOptions["access"] = {
      decide: async () => allowDecision,
    };
    const resolveProjectWorkspace = async (
      project: RunReferencedProject,
    ): Promise<ResolvedAdditionalWorkspace> => ({
      cwd: `/managed/${project.projectId}`,
      projectId: project.projectId,
      workspaceId: `${project.projectId}-ws`,
      repoUrl: null,
      repoRef: null,
    });
    return {
      enabled: true,
      companyId,
      actor,
      issues,
      projects,
      access,
      resolveProjectWorkspace,
      ...overrides,
    };
  }

  it("resolves additionalWorkspaces for each mentioned project when the sync flag is ON", async () => {
    const options = buildOptions({ mentionedIds: ["project-a", "project-b"] });

    const result = await resolveAdditionalRunWorkspaces(issueId, null, options);

    expect(result.additionalWorkspaces).toEqual([
      {
        cwd: "/managed/project-a",
        projectId: "project-a",
        workspaceId: "project-a-ws",
        repoUrl: null,
        repoRef: null,
      },
      {
        cwd: "/managed/project-b",
        projectId: "project-b",
        workspaceId: "project-b-ws",
        repoUrl: null,
        repoRef: null,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("returns empty additionalWorkspaces when the sync flag is OFF (anchor-only, unchanged)", async () => {
    let mentionLookups = 0;
    let workspaceResolves = 0;
    const options = buildOptions({
      enabled: false,
      mentionedIds: ["project-a", "project-b"],
      issues: {
        findMentionedProjectIds: async () => {
          mentionLookups += 1;
          return ["project-a", "project-b"];
        },
      },
      resolveProjectWorkspace: async (project) => {
        workspaceResolves += 1;
        return {
          cwd: `/managed/${project.projectId}`,
          projectId: project.projectId,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
        };
      },
    });

    const result = await resolveAdditionalRunWorkspaces(issueId, null, options);

    expect(result).toEqual({ additionalWorkspaces: [], warnings: [], failures: [] });
    // The flag-off path must be inert: no mention lookup and no workspace resolution run.
    expect(mentionLookups).toBe(0);
    expect(workspaceResolves).toBe(0);
  });

  it("isolates a failing mentioned-project clone with a warning, run still resolves", async () => {
    const options = buildOptions({
      mentionedIds: ["project-a", "project-b"],
      resolveProjectWorkspace: async (project) => {
        if (project.projectId === "project-a") {
          throw new Error("clone exploded");
        }
        return {
          cwd: `/managed/${project.projectId}`,
          projectId: project.projectId,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
        };
      },
    });

    const result = await resolveAdditionalRunWorkspaces(issueId, null, options);

    expect(result.additionalWorkspaces).toEqual([
      {
        cwd: "/managed/project-b",
        projectId: "project-b",
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("project-a");
    expect(result.warnings[0]).toContain("clone exploded");
    expect(result.failures).toEqual([{ projectId: "project-a", reason: "resolution" }]);
  });

  it("aggregates per-layer warnings onto the run's surfaced warnings", async () => {
    // Two valid projects sync; one is dropped by authorization and one fails to resolve. The run
    // still resolves, and both dropped projects are named in the surfaced warnings, one per layer.
    const options = buildOptions({
      mentionedIds: ["project-a", "project-b", "denied-project", "broken-project"],
      access: {
        decide: async (input) =>
          input.scope?.projectId === "denied-project"
            ? { allowed: false, action: "project:read", reason: "deny_no_grant", explanation: "denied" }
            : allowDecision,
      },
      resolveProjectWorkspace: async (project) => {
        if (project.projectId === "broken-project") {
          throw new Error("clone exploded");
        }
        return {
          cwd: `/managed/${project.projectId}`,
          projectId: project.projectId,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
        };
      },
    });

    const result = await resolveAdditionalRunWorkspaces(issueId, null, options);

    expect(result.additionalWorkspaces.map((workspace) => workspace.projectId)).toEqual([
      "project-a",
      "project-b",
    ]);
    // Each dropped project is named in a surfaced warning, across both layers.
    expect(result.warnings.some((warning) => warning.includes("denied-project"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("broken-project"))).toBe(true);
    // The structured failures carry the layer that dropped each project.
    expect(result.failures).toEqual([
      { projectId: "denied-project", reason: "authorization" },
      { projectId: "broken-project", reason: "resolution" },
    ]);
  });

  it("skips referenced-project work on a remote target and warns when the issue mentions a project", async () => {
    let mentionLookups = 0;
    let workspaceResolves = 0;
    const options = buildOptions({
      executionTargetIsRemote: true,
      mentionedIds: ["project-a", "project-b"],
      issues: {
        findMentionedProjectIds: async () => {
          mentionLookups += 1;
          return ["project-a", "project-b"];
        },
      },
      resolveProjectWorkspace: async (project) => {
        workspaceResolves += 1;
        return {
          cwd: `/managed/${project.projectId}`,
          projectId: project.projectId,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
        };
      },
    });

    const result = await resolveAdditionalRunWorkspaces(issueId, null, options);

    expect(result.additionalWorkspaces).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("local execution target");
    // The remote path drops every referenced project at the staging layer. Each dropped project
    // keeps a structured failure so the requested-vs-synced accounting counts the whole set and the
    // run still emits its structured sync log.
    expect(result.failures).toEqual([
      { projectId: "project-a", reason: "staging" },
      { projectId: "project-b", reason: "staging" },
    ]);
    // The remote path must skip the per-project clone work whose result the target cannot receive.
    expect(mentionLookups).toBe(1);
    expect(workspaceResolves).toBe(0);
  });

  it("drops a duplicate remote referenced mention to a single staging failure and ignores the anchor", async () => {
    const options = buildOptions({
      executionTargetIsRemote: true,
      mentionedIds: ["anchor-project", "project-a", "project-a"],
    });

    const result = await resolveAdditionalRunWorkspaces(issueId, "anchor-project", options);

    // The anchor is not a referenced drop, and a repeated mention counts once.
    expect(result.failures).toEqual([{ projectId: "project-a", reason: "staging" }]);
    expect(result.warnings).toHaveLength(1);
  });

  it("stays silent on a remote target when the issue mentions no referenced project", async () => {
    const options = buildOptions({
      executionTargetIsRemote: true,
      mentionedIds: [],
    });

    const result = await resolveAdditionalRunWorkspaces(issueId, null, options);

    expect(result).toEqual({ additionalWorkspaces: [], warnings: [], failures: [] });
  });
});

describe("buildReferencedProjectRunObservability", () => {
  it("emits referenced_projects_requested vs referenced_projects_synced with failure reason", () => {
    const observability = buildReferencedProjectRunObservability({
      syncedProjectIds: ["project-a"],
      failures: [
        { projectId: "project-b", reason: "authorization" },
        { projectId: "project-c", reason: "resolution" },
        { projectId: "project-d", reason: "staging" },
      ],
    });

    // Requested is the synced count plus every dropped project, so the counts reconcile.
    expect(observability.referenced_projects_requested).toBe(4);
    expect(observability.referenced_projects_synced).toBe(1);
    expect(observability.referenced_project_failures).toEqual([
      { project_id: "project-b", reason: "authorization" },
      { project_id: "project-c", reason: "resolution" },
      { project_id: "project-d", reason: "staging" },
    ]);
  });

  it("emits zero counts and no failures when no project is referenced", () => {
    const observability = buildReferencedProjectRunObservability({
      syncedProjectIds: [],
      failures: [],
    });

    expect(observability.referenced_projects_requested).toBe(0);
    expect(observability.referenced_projects_synced).toBe(0);
    expect(observability.referenced_project_failures).toEqual([]);
  });
});

describe("buildRunWorkspaceHints", () => {
  const anchorHints = [
    { workspaceId: "anchor-ws", cwd: "/anchor", repoUrl: "https://example.test/anchor.git", repoRef: "main" },
  ];

  it("returns only the anchor hints when no referenced project resolves (flag OFF, inert)", () => {
    const hints = buildRunWorkspaceHints({ workspaceHints: anchorHints, additionalWorkspaces: [] });

    expect(hints).toEqual(anchorHints);
  });

  it("appends each referenced project workspace so the agent sees its path", () => {
    const hints = buildRunWorkspaceHints({
      workspaceHints: anchorHints,
      additionalWorkspaces: [
        {
          cwd: "/managed/project-b",
          projectId: "project-b",
          workspaceId: "project-b-ws",
          repoUrl: "https://example.test/b.git",
          repoRef: "main",
        },
        // The hint builder passes each field through unchanged, including a null workspaceId.
        { cwd: "/managed/project-c", projectId: "project-c", workspaceId: null, repoUrl: null, repoRef: null },
      ],
    });

    expect(hints).toEqual([
      { workspaceId: "anchor-ws", cwd: "/anchor", repoUrl: "https://example.test/anchor.git", repoRef: "main" },
      {
        workspaceId: "project-b-ws",
        cwd: "/managed/project-b",
        repoUrl: "https://example.test/b.git",
        repoRef: "main",
        projectId: "project-b",
      },
      { workspaceId: null, cwd: "/managed/project-c", repoUrl: null, repoRef: null, projectId: "project-c" },
    ]);
  });
});

describe("resolveAdditionalProjectWorkspace", () => {
  const companyId = "company-1";

  function referencedProject(projectId: string): RunReferencedProject {
    return { projectId, project: { id: projectId } as RunReferencedProject["project"] };
  }

  type WorkspaceRow = Awaited<ReturnType<ResolveAdditionalProjectWorkspaceDeps["loadProjectWorkspaceRows"]>>[number];

  function workspaceRow(overrides: Partial<WorkspaceRow>): WorkspaceRow {
    return { id: "workspace-x", cwd: null, repoUrl: null, repoRef: null, ...overrides } as WorkspaceRow;
  }

  // Build deps whose managed and configured resolvers are pure, so no database or filesystem runs.
  function buildDeps(
    overrides: Partial<ResolveAdditionalProjectWorkspaceDeps>,
  ): ResolveAdditionalProjectWorkspaceDeps {
    return {
      loadProjectWorkspaceRows: async () => [],
      resolveConfiguredOrManagedProjectCwd: async (input) => ({ cwd: input.cwd ?? "/unset", warning: null }),
      ensureManagedProjectWorkspace: async (input) => ({
        cwd: `/managed/${input.projectId}`,
        warning: null,
      }),
      directoryHasContents: async () => true,
      ...overrides,
    };
  }

  it("throws instead of creating an empty managed directory when the project has no workspace rows", async () => {
    let ensureCalls = 0;
    const deps = buildDeps({
      loadProjectWorkspaceRows: async () => [],
      ensureManagedProjectWorkspace: async (input) => {
        ensureCalls += 1;
        return { cwd: `/managed/${input.projectId}`, warning: null };
      },
    });

    await expect(
      resolveAdditionalProjectWorkspace({ companyId, project: referencedProject("project-b") }, deps),
    ).rejects.toThrow(/project-b/);
    // The fallback must not fabricate an empty managed directory for a project with no real source.
    expect(ensureCalls).toBe(0);
  });

  it("throws when a workspace row supplies neither a checkout directory nor a repository URL", async () => {
    let ensureCalls = 0;
    const deps = buildDeps({
      loadProjectWorkspaceRows: async () => [workspaceRow({ id: "ws-empty", cwd: null, repoUrl: null })],
      resolveConfiguredOrManagedProjectCwd: async (input) => ({ cwd: input.cwd ?? "/unset", warning: null }),
      // directoryHasContents returns true for any path; the row must still be skipped before this runs.
      directoryHasContents: async () => true,
      ensureManagedProjectWorkspace: async (input) => {
        ensureCalls += 1;
        return { cwd: `/managed/${input.projectId}`, warning: null };
      },
    });

    await expect(
      resolveAdditionalProjectWorkspace({ companyId, project: referencedProject("project-c") }, deps),
    ).rejects.toThrow(/project-c/);
    // The row without a real source neither resolves a checkout nor triggers a managed fallback.
    expect(ensureCalls).toBe(0);
  });

  it("throws when a configured checkout directory exists but has no content", async () => {
    let ensureCalls = 0;
    const deps = buildDeps({
      loadProjectWorkspaceRows: async () => [
        workspaceRow({ id: "ws-empty-dir", cwd: "/checkout/empty", repoUrl: null }),
      ],
      resolveConfiguredOrManagedProjectCwd: async (input) => ({ cwd: input.cwd ?? "/unset", warning: null }),
      // The configured directory exists but holds no content, so it is not a realized workspace.
      directoryHasContents: async () => false,
      ensureManagedProjectWorkspace: async (input) => {
        ensureCalls += 1;
        return { cwd: `/managed/${input.projectId}`, warning: null };
      },
    });

    await expect(
      resolveAdditionalProjectWorkspace({ companyId, project: referencedProject("project-d") }, deps),
    ).rejects.toThrow(/project-d/);
    // An empty configured directory must not mask a missing workspace, and the row has no
    // repository URL, so the managed fallback never runs.
    expect(ensureCalls).toBe(0);
  });

  it("returns the first workspace row whose directory has content", async () => {
    const deps = buildDeps({
      loadProjectWorkspaceRows: async () => [
        workspaceRow({ id: "ws-1", cwd: "/checkout/a", repoUrl: "https://example.test/a.git", repoRef: "main" }),
      ],
      resolveConfiguredOrManagedProjectCwd: async (input) => ({ cwd: input.cwd ?? "/unset", warning: null }),
      directoryHasContents: async (cwd) => cwd === "/checkout/a",
    });

    const result = await resolveAdditionalProjectWorkspace({ companyId, project: referencedProject("project-a") }, deps);

    expect(result).toEqual({
      cwd: "/checkout/a",
      projectId: "project-a",
      workspaceId: "ws-1",
      repoUrl: "https://example.test/a.git",
      repoRef: "main",
    });
  });

  it("clones into the managed directory when configured rows point at missing paths", async () => {
    let ensuredRepoUrl: string | null | undefined;
    const deps = buildDeps({
      loadProjectWorkspaceRows: async () => [
        workspaceRow({ id: "ws-1", cwd: "/checkout/missing", repoUrl: "https://example.test/a.git", repoRef: "release" }),
      ],
      resolveConfiguredOrManagedProjectCwd: async (input) => ({ cwd: input.cwd ?? "/unset", warning: null }),
      directoryHasContents: async () => false,
      ensureManagedProjectWorkspace: async (input) => {
        ensuredRepoUrl = input.repoUrl;
        return { cwd: `/managed/${input.projectId}`, warning: null };
      },
    });

    const result = await resolveAdditionalProjectWorkspace({ companyId, project: referencedProject("project-a") }, deps);

    expect(result).toEqual({
      cwd: "/managed/project-a",
      projectId: "project-a",
      workspaceId: "ws-1",
      repoUrl: "https://example.test/a.git",
      repoRef: "release",
    });
    // The fallback clone reuses the repository URL from the first configured workspace row.
    expect(ensuredRepoUrl).toBe("https://example.test/a.git");
  });
});

describe("resolveManagedProjectWorkspaceDir isolation", () => {
  it("resolves distinct, non-nested managed dirs for two projects", () => {
    const companyId = "company-1";
    const dirA = resolveManagedProjectWorkspaceDir({ companyId, projectId: "project-a", repoName: null });
    const dirB = resolveManagedProjectWorkspaceDir({ companyId, projectId: "project-b", repoName: null });

    expect(dirA).not.toBe(dirB);
    // Neither directory is a path prefix of the other: append a separator so a shared leading
    // string (for example "project-a" vs "project-ab") never reads as nesting.
    expect(`${dirB}${path.sep}`.startsWith(`${dirA}${path.sep}`)).toBe(false);
    expect(`${dirA}${path.sep}`.startsWith(`${dirB}${path.sep}`)).toBe(false);
  });

  it("keeps a project id that prefixes another project id in a sibling, non-nested dir", () => {
    const companyId = "company-1";
    const dir = resolveManagedProjectWorkspaceDir({ companyId, projectId: "project", repoName: null });
    const dirLonger = resolveManagedProjectWorkspaceDir({ companyId, projectId: "project-extra", repoName: null });

    expect(`${dirLonger}${path.sep}`.startsWith(`${dir}${path.sep}`)).toBe(false);
    expect(`${dir}${path.sep}`.startsWith(`${dirLonger}${path.sep}`)).toBe(false);
  });
});
