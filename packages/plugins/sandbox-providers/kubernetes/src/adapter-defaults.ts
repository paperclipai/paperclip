import type { AdapterRegistryEntry } from "./adapter-registry.js";

export interface AdapterDefaults {
  runtimeImage: string;
  envKeys: string[];
  allowFqdns: string[];
  probeCommand: string[];
  /** Non-secret env injected as the base layer for the Job (process-env wins on top). */
  defaultEnv?: Record<string, string>;
}

const REGISTRY: Record<string, AdapterDefaults> = {
  claude_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["claude", "--version"],
  },
  codex_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-codex:v1",
    envKeys: ["OPENAI_API_KEY"],
    allowFqdns: ["api.openai.com"],
    probeCommand: ["codex", "--version"],
  },
  gemini_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-gemini:v1",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    allowFqdns: ["generativelanguage.googleapis.com"],
    probeCommand: ["gemini", "--version"],
  },
  cursor_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-cursor:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com"],
    probeCommand: ["cursor-agent", "--version"],
  },
  opencode_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-opencode:v1",
    envKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    allowFqdns: ["api.anthropic.com", "api.openai.com", "openrouter.ai"],
    probeCommand: ["opencode", "--version"],
  },
  pi_local: {
    runtimeImage: "ghcr.io/paperclipai/agent-runtime-pi:v1",
    envKeys: ["ANTHROPIC_API_KEY"],
    allowFqdns: ["api.anthropic.com"],
    probeCommand: ["pi", "--version"],
  },
};

export const KNOWN_ADAPTER_TYPES: ReadonlySet<string> = new Set(Object.keys(REGISTRY));

function fromRegistryEntry(entry: AdapterRegistryEntry): AdapterDefaults {
  // Only runtimeImage is strictly required. The array fields are optional and
  // default to []: the operator emits them with `omitempty`, so a genuinely
  // empty allowFqdns/envKeys/probeCommand arrives as undefined, which is valid
  // (no extra egress / no forwarded secrets / no probe), NOT an error.
  if (!entry.runtimeImage) {
    throw new Error(
      `Adapter "${entry.adapterType}" is missing required runtime field: runtimeImage`,
    );
  }
  return {
    runtimeImage: entry.runtimeImage,
    envKeys: entry.envKeys ?? [],
    allowFqdns: entry.allowFqdns ?? [],
    probeCommand: entry.probeCommand ?? [],
    defaultEnv: entry.defaultEnv,
  };
}

/**
 * Resolve the runtime defaults for an adapter. When a `registry` is supplied it
 * is authoritative (replace semantics): the type MUST be present and complete,
 * else this throws. With no registry, falls back to the built-in REGISTRY.
 */
export function getAdapterDefaults(
  adapterType: string,
  registry?: readonly AdapterRegistryEntry[],
): AdapterDefaults {
  if (registry && registry.length > 0) {
    const entry = registry.find((e) => e.adapterType === adapterType);
    if (!entry) {
      throw new Error(`Adapter "${adapterType}" is not in the configured adapter registry`);
    }
    return fromRegistryEntry(entry);
  }
  const defaults = REGISTRY[adapterType];
  if (!defaults) {
    throw new Error(`Unknown adapter type: ${adapterType}`);
  }
  return defaults;
}

/** Stable error code for a rejected lease that lacked a required per-run adapter. */
export const RUN_ADAPTER_REQUIRED_CODE = "run_adapter_required" as const;

/**
 * Thrown when strict per-run adapter resolution is enabled but the lease did not
 * carry a per-run adapter type. Falling back to the environment's configured
 * default adapter would be unsafe: the default is a global env value that may be
 * a DIFFERENT harness than the agent will run, so the sandbox image would not
 * match the CLI the server exec's (a gemini agent landing on the opencode image).
 */
export class RunAdapterRequiredError extends Error {
  readonly code = RUN_ADAPTER_REQUIRED_CODE;
  constructor(configAdapterType: string) {
    super(
      `per-run adapter type is required for per-run sandbox execution but was not supplied; refusing to fall back to the environment default adapter "${configAdapterType}", which may be a different harness than the agent will run (the sandbox runtime image would not match the executed CLI)`,
    );
    this.name = "RunAdapterRequiredError";
  }
}

export interface ResolveRunAdapterTypeOptions {
  /**
   * Force rejection of a lease that carries no per-run adapter, for ANY pool
   * (throw {@link RunAdapterRequiredError} instead of falling back to the
   * environment default). This is an explicit operator override on top of the
   * automatic mixed-pool safety below — use it to require the per-run adapter
   * even in a single-adapter environment. Defaults to false.
   */
  requireRunAdapter?: boolean;
  /**
   * The set of adapter types the environment is configured to serve (the
   * enabled entries of the plugin's `adapters` registry). When this declares
   * MORE THAN ONE distinct adapter the environment is a mixed-harness pool, and
   * a lease with no per-run adapter is rejected automatically — falling back to
   * the single env-default image would route e.g. a gemini run onto the
   * opencode image. Absent, empty, or a single distinct entry means an
   * effectively single-adapter environment, where the env-default fallback is
   * safe (and connectivity probes that carry no per-run adapter keep working).
   */
  configuredAdapterTypes?: readonly string[];
}

/**
 * Resolve the adapter type for a single run: prefer the run's adapter (the agent's,
 * from the lease params) so one environment can serve mixed harnesses; fall back to
 * the environment's configured default adapter when the run does not specify one.
 *
 * The image the plugin picks MUST match the harness the server exec's. Never
 * substitute a different harness for an absent per-run adapter:
 *   - A MIXED-harness pool (`configuredAdapterTypes` declares more than one
 *     distinct adapter) rejects the lease automatically — no operator flag
 *     needed — because the single env-default image could belong to a different
 *     harness than the agent will run.
 *   - `options.requireRunAdapter` forces the same rejection for any pool.
 * A single-adapter environment (or one with no declared registry) still falls
 * back to the env default, preserving single-adapter setups and probes.
 */
export function resolveRunAdapterType(
  runAdapterType: string | null | undefined,
  configAdapterType: string,
  options: ResolveRunAdapterTypeOptions = {},
): string {
  const trimmed = typeof runAdapterType === "string" ? runAdapterType.trim() : "";
  if (trimmed.length > 0) {
    return trimmed;
  }
  // Per-run adapter absent. Determine whether the environment is a mixed-harness
  // pool from its configured adapter set: more than one distinct enabled adapter
  // means the single env-default fallback could pick a DIFFERENT harness's image.
  const distinctConfiguredAdapters = new Set(
    (options.configuredAdapterTypes ?? [])
      .map((type) => (typeof type === "string" ? type.trim() : ""))
      .filter((type) => type.length > 0),
  );
  const isMixedHarnessPool = distinctConfiguredAdapters.size > 1;
  if (options.requireRunAdapter || isMixedHarnessPool) {
    throw new RunAdapterRequiredError(configAdapterType);
  }
  return configAdapterType;
}

/**
 * Build the per-run env for the Job: the non-secret `defaultEnv` is the base
 * and the process-env values (the secret API keys named by `envKeys`) override
 * it. Pure for testability.
 */
export function buildAdapterEnv(
  defaults: AdapterDefaults,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ...(defaults.defaultEnv ?? {}) };
  for (const k of defaults.envKeys) {
    const v = processEnv[k];
    if (v) out[k] = v;
  }
  return out;
}
