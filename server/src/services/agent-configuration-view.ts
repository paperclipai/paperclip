import type {
  AgentConfigurationAccess,
  AgentConfigurationView,
} from "@paperclipai/shared";

/**
 * Top-level key names of a config object, never values. Safe to expose to a
 * caller who cannot read the config itself.
 */
export function configurationKeyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

/**
 * Adds an explicit, symmetric redaction signal to an agent read.
 *
 * Before this, a restricted read returned `adapterConfig: {}` with a 200 and no
 * marker, which is indistinguishable from a genuinely empty config. The result
 * was ~28 issues filed on the false premise "agent X has an empty
 * adapterConfig". Now `configurationAccess` always says which case it is and
 * `adapterConfigKeys` always reports the real top-level key names, so "is this
 * agent configured?" is answerable without the values.
 *
 * The generic constraint is on the two config fields only, because the service
 * returns drizzle rows whose enum columns are wider than `Agent`. The return
 * type still guarantees the marker, so a response built through here cannot
 * drop it.
 */
export function withConfigurationAccess<
  T extends { adapterConfig: unknown; runtimeConfig: unknown },
>(
  agent: T,
  access: AgentConfigurationAccess,
): T & AgentConfigurationView {
  return {
    ...agent,
    adapterConfig: access === "full" ? agent.adapterConfig : {},
    runtimeConfig: access === "full" ? agent.runtimeConfig : {},
    configurationAccess: access,
    adapterConfigKeys: configurationKeyNames(agent.adapterConfig),
    runtimeConfigKeys: configurationKeyNames(agent.runtimeConfig),
  };
}

/** A read whose config values the caller is permitted to see. */
export function withFullConfigurationAccess<
  T extends { adapterConfig: unknown; runtimeConfig: unknown },
>(agent: T): T & AgentConfigurationView {
  return withConfigurationAccess(agent, "full");
}
