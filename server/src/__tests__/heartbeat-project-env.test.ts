import { describe, expect, it, vi } from "vitest";
import { buildSkillMentionHref } from "@valadrien-os/shared";
import {
  applyRunScopedMentionedSkillKeys,
  extractMentionedSkillIdsFromSources,
  resolveExecutionRunAdapterConfig,
} from "../services/heartbeat.ts";

describe("resolveExecutionRunAdapterConfig", () => {
  it("overlays project and routine env on top of agent env and unions secret keys", async () => {
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
        AGENT_ONLY: "agent-only",
        PROJECT_ONLY: "project-only",
        ROUTINE_ONLY: "routine-only",
      },
    });
    expect(Array.from(result.secretKeys).sort()).toEqual(["AGENT_SECRET", "PROJECT_SECRET", "ROUTINE_SECRET"]);
    expect(result.secretManifest.map((entry) => entry.secretId).sort()).toEqual([
      "secret-agent",
      "secret-project",
      "secret-routine",
    ]);
    expect(JSON.stringify(result.secretManifest)).not.toContain("agent-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("project-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("routine-only");
    expect(resolveEnvBindings.mock.calls[1]?.[2]).toMatchObject({
      consumerType: "routine",
      consumerId: "routine-1",
    });
  });

  it("drops ValadrienOs runtime-owned env before resolving agent, project, and routine overlays", async () => {
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
      executionRunConfig: {
        env: {
          VALADRIEN_OS_API_KEY: { type: "secret_ref", secretId: "secret-api-key", version: "latest" },
          VALADRIEN_OS_AGENT_ID: "spoofed-agent",
          AGENT_ONLY: "agent-only",
        },
      },
      projectEnv: {
        VALADRIEN_OS_API_KEY: "project-api-key",
        VALADRIEN_OS_COMPANY_ID: "spoofed-company",
        PROJECT_ONLY: "project-only",
      },
      routineEnv: {
        VALADRIEN_OS_API_KEY: "routine-api-key",
        VALADRIEN_OS_RUN_ID: "spoofed-run",
        ROUTINE_ONLY: "routine-only",
      },
      routineId: "routine-1",
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[1]).toEqual({
      env: {
        AGENT_ONLY: "agent-only",
      },
    });
    expect(resolveEnvBindings.mock.calls[0]?.[1]).toEqual({
      PROJECT_ONLY: "project-only",
    });
    expect(resolveEnvBindings.mock.calls[1]?.[1]).toEqual({
      ROUTINE_ONLY: "routine-only",
    });
    expect(result.resolvedConfig.env).toEqual({
      AGENT_ONLY: "agent-only",
      PROJECT_ONLY: "project-only",
      ROUTINE_ONLY: "routine-only",
    });
    expect(JSON.stringify(result.resolvedConfig.env)).not.toContain("VALADRIEN_OS_");
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
});

describe("extractMentionedSkillIdsFromSources", () => {
  it("collects explicit skill mention ids across issue sources", () => {
    const releaseHref = buildSkillMentionHref("skill-1", "release-changelog");
    const browserHref = buildSkillMentionHref("skill-2", "agent-browser");

    expect(
      extractMentionedSkillIdsFromSources([
        `Please use [/release-changelog](${releaseHref})`,
        `And also [/agent-browser](${browserHref})`,
        `Duplicate mention [/release-changelog](${releaseHref})`,
      ]),
    ).toEqual(["skill-1", "skill-2"]);
  });
});

describe("applyRunScopedMentionedSkillKeys", () => {
  it("adds mentioned skills without mutating the original config", () => {
    const originalConfig = {
      command: "codex",
      valadrienOsSkillSync: {
        desiredSkills: ["ValDola-stack/valadrien-os/valadrien-os"],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/release-changelog",
      "ValDola-stack/valadrien-os/valadrien-os",
      "company/company-1/release-changelog",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      valadrienOsSkillSync: {
        desiredSkills: [
          "ValDola-stack/valadrien-os/valadrien-os",
          "company/company-1/release-changelog",
        ],
      },
    });
    expect(originalConfig).toEqual({
      command: "codex",
      valadrienOsSkillSync: {
        desiredSkills: ["ValDola-stack/valadrien-os/valadrien-os"],
      },
    });
  });

  it("injects per-tenant provider keys, overriding the shared/agent env", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { ANTHROPIC_API_KEY: "shared-from-agent-config", AGENT_ONLY: "x" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({ env: {}, secretKeys: new Set<string>(), manifest: [] });
    const resolveProviderKeyOverrides = vi.fn().mockResolvedValue({
      env: { ANTHROPIC_API_KEY: "tenant-own-key" },
      secretKeys: new Set(["ANTHROPIC_API_KEY"]),
      manifest: [
        {
          configPath: "env.ANTHROPIC_API_KEY",
          envKey: "ANTHROPIC_API_KEY",
          secretId: "secret-tenant-anthropic",
          secretKey: "anthropic-api-key",
          version: 1,
          provider: "local_encrypted",
          outcome: "success",
        },
      ],
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "tenant-1",
      agentId: "agent-1",
      executionRunConfig: { env: { ANTHROPIC_API_KEY: "shared-from-agent-config" } },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings, resolveProviderKeyOverrides } as any,
    });

    // Tenant's own key wins over the agent/shared value.
    expect((result.resolvedConfig.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("tenant-own-key");
    expect((result.resolvedConfig.env as Record<string, string>).AGENT_ONLY).toBe("x");
    expect(result.secretKeys.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(resolveProviderKeyOverrides).toHaveBeenCalledWith("tenant-1");
    // The resolved key value never appears in the manifest (only metadata).
    expect(JSON.stringify(result.secretManifest)).not.toContain("tenant-own-key");
  });

  it("falls back to the shared key when the tenant has no provider-key override", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { ANTHROPIC_API_KEY: "shared-from-agent-config" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({ env: {}, secretKeys: new Set<string>(), manifest: [] });
    // No company secret for any provider key → empty override → shared key preserved.
    const resolveProviderKeyOverrides = vi
      .fn()
      .mockResolvedValue({ env: {}, secretKeys: new Set<string>(), manifest: [] });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "tenant-2",
      agentId: "agent-2",
      executionRunConfig: { env: { ANTHROPIC_API_KEY: "shared-from-agent-config" } },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings, resolveProviderKeyOverrides } as any,
    });

    expect((result.resolvedConfig.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("shared-from-agent-config");
    expect(result.secretKeys.has("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("does not crash when the resolver lacks resolveProviderKeyOverrides (back-compat)", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { FOO: "bar" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({ env: {}, secretKeys: new Set<string>(), manifest: [] });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "tenant-3",
      executionRunConfig: { env: { FOO: "bar" } },
      projectEnv: null,
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
    });

    expect((result.resolvedConfig.env as Record<string, string>).FOO).toBe("bar");
  });
});
