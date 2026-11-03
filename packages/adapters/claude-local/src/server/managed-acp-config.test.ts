import { describe, expect, it, vi } from "vitest";

const { prepareManagedClaudePluginRuntime } = vi.hoisted(() => ({
  prepareManagedClaudePluginRuntime: vi.fn(async () => ({ pluginRoot: null as string | null, skillCount: 0, profileIdentity: "fixture-identity" })),
}));

vi.mock("./claude-config.js", () => ({ prepareManagedClaudePluginRuntime }));

import { managedClaudeProfileEnvironmentIdentity, prepareManagedClaudeAcpConfig } from "./managed-acp-config.js";

describe("prepareManagedClaudeAcpConfig", () => {
  it("uses profile content for copy-mode identity while launching with the real per-run path", async () => {
    async function prepare(runId: string, revision: string) {
      const config = { profileImportMode: "copy" };
      const pluginRoot = `C:/managed/${runId}/provider/plugins`;
      prepareManagedClaudePluginRuntime.mockResolvedValueOnce({ pluginRoot, skillCount: 1, profileIdentity: revision });
      const result = await prepareManagedClaudeAcpConfig({
        config, configEnv: { CLAUDE_CONFIG_DIR: `C:/managed/${runId}/provider` },
        managedAiHomeOverrides: {}, processEnv: {}, companyId: "company", agentId: "agent", runId,
      });
      const env = { CLAUDE_CODE_PLUGIN_CACHE_DIR: result.env.CLAUDE_CODE_PLUGIN_CACHE_DIR as string, KEEP_SETTING: "preserved" };
      const identity = managedClaudeProfileEnvironmentIdentity(env, config);
      expect(env.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe(pluginRoot);
      expect(identity.KEEP_SETTING).toBe("preserved");
      expect(managedClaudeProfileEnvironmentIdentity(env, { ...config })).toEqual(env);
      expect(managedClaudeProfileEnvironmentIdentity({ ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: "C:/explicit/cache" }, config).CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe("C:/explicit/cache");
      return identity;
    }
    expect(await prepare("second", "v1")).toEqual(await prepare("first", "v1"));
    expect(await prepare("third", "v2")).not.toEqual(await prepare("first", "v1"));
    prepareManagedClaudePluginRuntime.mockClear();
  });
  it("uses typed import settings ahead of legacy environment values", async () => {
    prepareManagedClaudePluginRuntime.mockClear();
    await prepareManagedClaudeAcpConfig({
      config: { profileImportMode: "copy", profileSourceDir: "C:/trusted-profile" },
      configEnv: { CLAUDE_CONFIG_DIR: "C:/managed/provider", PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: "cache" },
      managedAiHomeOverrides: {}, processEnv: {}, companyId: "company-1", agentId: "agent-1", runId: "run-1",
    });
    expect(prepareManagedClaudePluginRuntime).toHaveBeenCalledWith(expect.objectContaining({ importMode: "copy", sourceDir: "C:/trusted-profile" }));
    prepareManagedClaudePluginRuntime.mockClear();
  });
  it.each([undefined, ""])("preserves the source override distinction for ACP: %s", async (sourceDir) => {
    prepareManagedClaudePluginRuntime.mockClear();
    await prepareManagedClaudeAcpConfig({
      config: { profileImportMode: "cache", ...(sourceDir !== undefined ? { profileSourceDir: sourceDir } : {}) },
      configEnv: { CLAUDE_CONFIG_DIR: "C:/managed/provider" },
      managedAiHomeOverrides: {}, processEnv: {}, companyId: "company", agentId: "agent", runId: "run",
    });
    expect(prepareManagedClaudePluginRuntime).toHaveBeenCalledWith(expect.objectContaining({ sourceDir }));
    prepareManagedClaudePluginRuntime.mockClear();
  });
  it("preserves Paperclip's default ACP environment when profile import is off", async () => {
    const env = {
      CLAUDE_CONFIG_DIR: "C:/managed/provider",
      CLAUDE_CODE_PLUGIN_CACHE_DIR: "C:/existing/plugin-cache",
    };

    const result = await prepareManagedClaudeAcpConfig({
      configEnv: env,
      managedAiHomeOverrides: {},
      processEnv: {},
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    expect(result.env).toEqual(env);
    expect(prepareManagedClaudePluginRuntime).not.toHaveBeenCalled();
  });

  it("excludes skills already selected by Paperclip from imported personal skills", async () => {
    prepareManagedClaudePluginRuntime.mockClear();

    await prepareManagedClaudeAcpConfig({
      configEnv: {
        CLAUDE_CONFIG_DIR: "C:/managed/provider",
        PAPERCLIP_CLAUDE_PLUGIN_IMPORT_MODE: "cache",
      },
      managedAiHomeOverrides: {},
      processEnv: {},
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      excludedSkillNames: ["careconnections"],
    });

    expect(prepareManagedClaudePluginRuntime).toHaveBeenCalledWith(expect.objectContaining({
      excludedSkillNames: ["careconnections"],
      importMode: "cache",
    }));
  });
});
