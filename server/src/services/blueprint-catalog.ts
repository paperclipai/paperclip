import type { Db } from "@paperclipai/db";
import {
  INITIAL_READY_AGENT_BLUEPRINTS,
  readyAgentBlueprintToVersion,
  type BlueprintVersion,
} from "@paperclipai/shared";

export type BlueprintCatalogOptions = {
  enabled?: boolean;
  versions?: BlueprintVersion[];
  providerKeyResolver?: () => readonly string[];
};

export type BlueprintCatalogService = ReturnType<typeof blueprintCatalogService>;

export function isBlueprintCatalogEnabled(): boolean {
  return process.env.EAOS_BLUEPRINTS_ENABLED === "true";
}

export function resolveProviderKeys(): string[] {
  const keys: string[] = [];
  const candidates: Array<[string, string]> = [
    ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
    ["OPENAI_API_KEY", "OPENAI_API_KEY"],
    ["XAI_API_KEY", "XAI_API_KEY"],
    ["GROK_API_KEY", "GROK_API_KEY"],
    ["AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
  ];
  for (const [envName, providerName] of candidates) {
    if (process.env[envName] && process.env[envName]!.trim().length > 0) {
      keys.push(providerName);
    }
  }
  return keys;
}

function defaultVersions(): BlueprintVersion[] {
  return INITIAL_READY_AGENT_BLUEPRINTS.map((blueprint) => readyAgentBlueprintToVersion(blueprint));
}

export function blueprintCatalogService(_db: Db, options: BlueprintCatalogOptions = {}) {
  const enabledOverride = options.enabled;
  const providedVersions = options.versions ?? defaultVersions();
  const providerKeyResolver = options.providerKeyResolver ?? resolveProviderKeys;

  function isEnabled(): boolean {
    if (typeof enabledOverride === "boolean") return enabledOverride;
    return isBlueprintCatalogEnabled();
  }

  function listVersions(): BlueprintVersion[] {
    if (!isEnabled()) return [];
    return providedVersions.filter((version) => version.status !== "deprecated");
  }

  function getByRef(ref: string): BlueprintVersion | null {
    if (!isEnabled()) return null;
    return providedVersions.find((version) => version.ref === ref) ?? null;
  }

  function getProviderKeys(): readonly string[] {
    return providerKeyResolver();
  }

  return {
    isEnabled,
    listVersions,
    getByRef,
    getProviderKeys,
  };
}
