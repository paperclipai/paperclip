import { DEFAULT_MODEL } from "../shared/constants.js";

const HERMES_MOA_PRESET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MOA_PROFILE_BINDINGS_KEY = "moaProfileBindings";

export interface HermesModelSelection {
  model: string;
  provider?: string;
  moaPreset?: string;
}

function configuredModel(config: Record<string, unknown>): string {
  return typeof config.model === "string" && config.model.length > 0
    ? config.model
    : DEFAULT_MODEL;
}

function configuredProvider(config: Record<string, unknown>): string | undefined {
  return typeof config.provider === "string" && config.provider.trim().length > 0
    ? config.provider
    : undefined;
}

function readProfileBindings(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function resolveHermesMoaPreset(
  config: Record<string, unknown>,
  profile: string,
): string | null {
  const bindings = readProfileBindings(config[MOA_PROFILE_BINDINGS_KEY]);
  if (!bindings || !Object.prototype.hasOwnProperty.call(bindings, profile)) {
    return null;
  }

  const preset = bindings[profile];
  return typeof preset === "string" && HERMES_MOA_PRESET_PATTERN.test(preset)
    ? preset
    : null;
}

/** The adapter's profile-to-model selection point. */
export function resolveHermesModelSelection(
  config: Record<string, unknown>,
  profile: string,
): HermesModelSelection {
  const moaPreset = resolveHermesMoaPreset(config, profile);
  if (moaPreset) {
    return {
      model: `moa:${moaPreset}`,
      provider: "moa",
      moaPreset,
    };
  }

  const selection: HermesModelSelection = {
    model: configuredModel(config),
  };
  const provider = configuredProvider(config);
  if (provider) selection.provider = provider;
  return selection;
}
