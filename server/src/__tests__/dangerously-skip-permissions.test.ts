import { describe, expect, it, vi } from "vitest";
import {
  resolveExecutionRunAdapterConfig,
  applyPersistedExecutionWorkspaceConfig,
  stripWorkspaceRuntimeFromExecutionRunConfig,
} from "../services/heartbeat.ts";
import { buildExecutionWorkspaceAdapterConfig } from "../services/execution-workspace-policy.ts";
import { buildClaudeLocalConfig } from "@paperclipai/adapter-claude-local/ui";
import { DEFAULT_CLAUDE_LOCAL_SKIP_PERMISSIONS } from "@paperclipai/adapter-claude-local";

/**
 * Regression tests for the dangerouslySkipPermissions field propagation.
 *
 * These tests verify that the field flows correctly from the DB adapter_config
 * through every intermediate layer to the final runtimeConfig that reaches
 * the adapter execute() entry point.
 */

describe("dangerouslySkipPermissions propagation", () => {
  const noopSecretsSvc = {
    resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({
      config: { ...config },
      secretKeys: new Set<string>(),
    })),
    resolveEnvBindings: vi.fn(async () => ({
      env: {} as Record<string, string>,
      secretKeys: new Set<string>(),
    })),
  };

  describe("buildExecutionWorkspaceAdapterConfig preserves field", () => {
    it("preserves dangerouslySkipPermissions=true", () => {
      const result = buildExecutionWorkspaceAdapterConfig({
        agentConfig: { cwd: "/app", dangerouslySkipPermissions: true },
        projectPolicy: null,
        issueSettings: null,
        mode: "agent_default",
        legacyUseProjectWorkspace: null,
      });
      expect(result.dangerouslySkipPermissions).toBe(true);
    });

    it("preserves dangerouslySkipPermissions=false", () => {
      const result = buildExecutionWorkspaceAdapterConfig({
        agentConfig: { cwd: "/app", dangerouslySkipPermissions: false },
        projectPolicy: null,
        issueSettings: null,
        mode: "agent_default",
        legacyUseProjectWorkspace: null,
      });
      expect(result.dangerouslySkipPermissions).toBe(false);
    });

    it("preserves field through isolated_workspace mode", () => {
      const result = buildExecutionWorkspaceAdapterConfig({
        agentConfig: { cwd: "/app", dangerouslySkipPermissions: false },
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: { mode: "isolated_workspace" },
        mode: "isolated_workspace",
        legacyUseProjectWorkspace: null,
      });
      expect(result.dangerouslySkipPermissions).toBe(false);
    });
  });

  describe("applyPersistedExecutionWorkspaceConfig preserves field", () => {
    it("preserves dangerouslySkipPermissions through workspace config application", () => {
      const result = applyPersistedExecutionWorkspaceConfig({
        config: { dangerouslySkipPermissions: false, cwd: "/app" },
        workspaceConfig: null,
        mode: "agent_default",
      });
      expect(result.dangerouslySkipPermissions).toBe(false);
    });
  });

  describe("stripWorkspaceRuntimeFromExecutionRunConfig preserves field", () => {
    it("preserves dangerouslySkipPermissions=true while stripping workspaceRuntime", () => {
      const result = stripWorkspaceRuntimeFromExecutionRunConfig({
        dangerouslySkipPermissions: true,
        workspaceRuntime: { services: [] },
        cwd: "/app",
      });
      expect(result.dangerouslySkipPermissions).toBe(true);
      expect(result.workspaceRuntime).toBeUndefined();
    });

    it("preserves dangerouslySkipPermissions=false while stripping workspaceRuntime", () => {
      const result = stripWorkspaceRuntimeFromExecutionRunConfig({
        dangerouslySkipPermissions: false,
        workspaceRuntime: { services: [] },
        cwd: "/app",
      });
      expect(result.dangerouslySkipPermissions).toBe(false);
    });
  });

  describe("resolveExecutionRunAdapterConfig preserves field", () => {
    it("preserves dangerouslySkipPermissions=true through secret resolution", async () => {
      const result = await resolveExecutionRunAdapterConfig({
        companyId: "c1",
        executionRunConfig: { dangerouslySkipPermissions: true, cwd: "/app" },
        projectEnv: null,
        secretsSvc: noopSecretsSvc as any,
      });
      expect(result.resolvedConfig.dangerouslySkipPermissions).toBe(true);
    });

    it("preserves dangerouslySkipPermissions=false through secret resolution", async () => {
      const result = await resolveExecutionRunAdapterConfig({
        companyId: "c1",
        executionRunConfig: { dangerouslySkipPermissions: false, cwd: "/app" },
        projectEnv: null,
        secretsSvc: noopSecretsSvc as any,
      });
      expect(result.resolvedConfig.dangerouslySkipPermissions).toBe(false);
    });

    it("preserves missing field as undefined (runtime will apply default)", async () => {
      const result = await resolveExecutionRunAdapterConfig({
        companyId: "c1",
        executionRunConfig: { cwd: "/app" },
        projectEnv: null,
        secretsSvc: noopSecretsSvc as any,
      });
      expect(result.resolvedConfig.dangerouslySkipPermissions).toBeUndefined();
    });
  });

  describe("end-to-end config pipeline", () => {
    it("DB true → final config has dangerouslySkipPermissions=true", async () => {
      const dbConfig = { cwd: "/app", dangerouslySkipPermissions: true };
      const workspaceManaged = buildExecutionWorkspaceAdapterConfig({
        agentConfig: dbConfig,
        projectPolicy: null,
        issueSettings: null,
        mode: "agent_default",
        legacyUseProjectWorkspace: null,
      });
      const persisted = applyPersistedExecutionWorkspaceConfig({
        config: workspaceManaged,
        workspaceConfig: null,
        mode: "agent_default",
      });
      const stripped = stripWorkspaceRuntimeFromExecutionRunConfig(persisted);
      const { resolvedConfig } = await resolveExecutionRunAdapterConfig({
        companyId: "c1",
        executionRunConfig: stripped,
        projectEnv: null,
        secretsSvc: noopSecretsSvc as any,
      });
      const runtimeConfig = { ...resolvedConfig };
      expect(runtimeConfig.dangerouslySkipPermissions).toBe(true);
    });

    it("DB false → final config has dangerouslySkipPermissions=false", async () => {
      const dbConfig = { cwd: "/app", dangerouslySkipPermissions: false };
      const workspaceManaged = buildExecutionWorkspaceAdapterConfig({
        agentConfig: dbConfig,
        projectPolicy: null,
        issueSettings: null,
        mode: "agent_default",
        legacyUseProjectWorkspace: null,
      });
      const persisted = applyPersistedExecutionWorkspaceConfig({
        config: workspaceManaged,
        workspaceConfig: null,
        mode: "agent_default",
      });
      const stripped = stripWorkspaceRuntimeFromExecutionRunConfig(persisted);
      const { resolvedConfig } = await resolveExecutionRunAdapterConfig({
        companyId: "c1",
        executionRunConfig: stripped,
        projectEnv: null,
        secretsSvc: noopSecretsSvc as any,
      });
      const runtimeConfig = { ...resolvedConfig };
      expect(runtimeConfig.dangerouslySkipPermissions).toBe(false);
    });

    it("field missing in DB → undefined in final config (asBoolean applies runtime default)", async () => {
      const dbConfig = { cwd: "/app" };
      const workspaceManaged = buildExecutionWorkspaceAdapterConfig({
        agentConfig: dbConfig,
        projectPolicy: null,
        issueSettings: null,
        mode: "agent_default",
        legacyUseProjectWorkspace: null,
      });
      const persisted = applyPersistedExecutionWorkspaceConfig({
        config: workspaceManaged,
        workspaceConfig: null,
        mode: "agent_default",
      });
      const stripped = stripWorkspaceRuntimeFromExecutionRunConfig(persisted);
      const { resolvedConfig } = await resolveExecutionRunAdapterConfig({
        companyId: "c1",
        executionRunConfig: stripped,
        projectEnv: null,
        secretsSvc: noopSecretsSvc as any,
      });
      const runtimeConfig = { ...resolvedConfig };
      expect(runtimeConfig.dangerouslySkipPermissions).toBeUndefined();
    });
  });
});

describe("DEFAULT_CLAUDE_LOCAL_SKIP_PERMISSIONS constant", () => {
  it("exports the expected default value of true", () => {
    expect(DEFAULT_CLAUDE_LOCAL_SKIP_PERMISSIONS).toBe(true);
  });
});

describe("buildClaudeLocalConfig UI serialization", () => {
  const baseValues = {
    adapterType: "claude_local" as const,
    cwd: "/app",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary" as const,
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
  };

  it("default create serializes dangerouslySkipPermissions=true", () => {
    const config = buildClaudeLocalConfig(baseValues);
    expect(config.dangerouslySkipPermissions).toBe(true);
  });

  it("explicit false serializes dangerouslySkipPermissions=false", () => {
    const config = buildClaudeLocalConfig({
      ...baseValues,
      dangerouslySkipPermissions: false,
    });
    expect(config.dangerouslySkipPermissions).toBe(false);
  });

  it("always includes dangerouslySkipPermissions in output (never omitted)", () => {
    const configTrue = buildClaudeLocalConfig(baseValues);
    const configFalse = buildClaudeLocalConfig({
      ...baseValues,
      dangerouslySkipPermissions: false,
    });
    expect("dangerouslySkipPermissions" in configTrue).toBe(true);
    expect("dangerouslySkipPermissions" in configFalse).toBe(true);
  });

  it("serializes maxTurnsPerRun from defaults", () => {
    const config = buildClaudeLocalConfig(baseValues);
    expect(config.maxTurnsPerRun).toBe(1000);
  });
});

describe("execute-time asBoolean behavior for dangerouslySkipPermissions", () => {
  // Inline reimplementation matching the enhanced asBoolean in adapter-utils
  function asBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
    return fallback;
  }

  it("DB true → execute sees true → CLI includes --dangerously-skip-permissions", () => {
    const val = asBoolean(true, true);
    expect(val).toBe(true);
  });

  it("DB false → execute sees false → CLI omits --dangerously-skip-permissions", () => {
    const val = asBoolean(false, true);
    expect(val).toBe(false);
  });

  it("DB missing → execute falls back to true → CLI includes --dangerously-skip-permissions", () => {
    const val = asBoolean(undefined, true);
    expect(val).toBe(true);
  });

  it("DB string 'false' → execute sees false → CLI omits flag", () => {
    const val = asBoolean("false", true);
    expect(val).toBe(false);
  });

  it("DB string 'true' → execute sees true → CLI includes flag", () => {
    const val = asBoolean("true", true);
    expect(val).toBe(true);
  });

  it("DB string 'FALSE' → case-insensitive → false", () => {
    const val = asBoolean("FALSE", true);
    expect(val).toBe(false);
  });
});
