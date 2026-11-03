import path from "node:path";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { prepareManagedClaudePluginRuntime } from "./claude-config.js";
import { resolveClaudeRuntimeSettings } from "../runtime-settings.js";

const copyProfileIdentities = new WeakMap<Record<string, unknown>, { path: string; identity: string }>();

export function managedClaudeProfileEnvironmentIdentity(
  env: Readonly<Record<string, string>>,
  config: Record<string, unknown>,
): Record<string, string> {
  const binding = copyProfileIdentities.get(config);
  return binding && env.CLAUDE_CODE_PLUGIN_CACHE_DIR === binding.path
    ? { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: `<managed-claude-profile:${binding.identity}>` }
    : { ...env };
}

/** Applies imported profile assets to a managed, local ACP invocation. */
export async function prepareManagedClaudeAcpConfig(input: {
  config?: Record<string, unknown>;
  configEnv: unknown;
  managedAiHomeOverrides: unknown;
  processEnv: NodeJS.ProcessEnv;
  companyId: string;
  agentId: string;
  runId: string;
  excludedSkillNames?: string[];
}): Promise<{ env: Record<string, unknown>; importMessage?: string }> {
  if (input.config) copyProfileIdentities.delete(input.config);
  const env = parseObject(input.configEnv);
  const configDir = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR : "";
  const managedHomeOverrides = parseObject(input.managedAiHomeOverrides);
  const hasExplicitConfigDir = managedHomeOverrides.claudeConfigDir === true;
  const { profileImportMode: importMode, profileSourceDir } = resolveClaudeRuntimeSettings(input.config ?? {}, env);
  if (importMode !== "off" && hasExplicitConfigDir) {
    throw new Error(
      "Claude profile import cannot write into an explicitly configured CLAUDE_CONFIG_DIR. Disable profile import or remove the config directory override.",
    );
  }
  if (importMode === "copy" && managedHomeOverrides.home === true) {
    throw new Error("Claude profile copy mode requires Paperclip's temporary HOME. Choose cache mode or clear the HOME override.");
  }
  const managedPlugins = importMode === "off"
    ? { pluginRoot: null, skillCount: 0 }
    : await prepareManagedClaudePluginRuntime({
        env: input.processEnv,
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        configDir,
        sourceDir: input.config?.profileSourceDir !== undefined ? profileSourceDir : profileSourceDir || undefined,
        autoDiscoverSource: true,
        importMode,
        excludedSkillNames: input.excludedSkillNames,
      });

  const pluginRoot = managedPlugins.pluginRoot ?? path.join(configDir, "plugins");
  if (importMode === "copy" && input.config) {
    copyProfileIdentities.set(input.config, { path: pluginRoot, identity: managedPlugins.profileIdentity ?? "none" });
  }

  return {
    env: {
      ...env,
      ...(importMode !== "off" ? {
        ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1",
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
        CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginRoot,
      } : {}),
    },
    ...(managedPlugins.pluginRoot || managedPlugins.skillCount > 0
      ? { importMessage: `[paperclip] Imported ${managedPlugins.skillCount} personal Claude skills using ${importMode} mode for local ACP.\n` }
      : {}),
  };
}
