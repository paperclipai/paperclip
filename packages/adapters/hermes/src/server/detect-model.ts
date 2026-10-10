/**
 * Detect the current model and provider from the user's Hermes config.
 *
 * Reads ~/.hermes/config.yaml and extracts the default model,
 * provider, base_url, api_key presence, and api_mode settings.
 *
 * Also provides provider resolution logic that merges explicit config,
 * Hermes config detection, and model-name prefix inference.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { MODEL_PREFIX_PROVIDER_HINTS, VALID_PROVIDERS } from "../shared/constants.js";

export interface DetectedModel {
  /** Model name from config (e.g. "gpt-5.4", "anthropic/claude-sonnet-4") */
  model: string;
  /** Provider name from config (e.g. "copilot", "zai"). May be empty. */
  provider: string;
  /** Base URL override from config (e.g. "https://api.githubcopilot.com"). May be empty. */
  baseUrl: string;
  /** Whether Hermes config includes a non-empty API key. */
  hasApiKey: boolean;
  /** API mode from config (e.g. "chat_completions", "codex_responses"). May be empty. */
  apiMode: string;
  /** Where the detection came from */
  source: "config";
}

/**
 * Read the Hermes config file and extract the default model config.
 */
export async function detectModel(
  configPath?: string,
): Promise<DetectedModel | null> {
  const filePath = configPath ?? join(homedir(), ".hermes", "config.yaml");

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  return parseModelFromConfig(content);
}

/**
 * Parse model.default, model.provider, model.base_url, model.api_key, and model.api_mode
 * from raw YAML content. Uses simple regex parsing to avoid a YAML dependency.
 */
export function parseModelFromConfig(content: string): DetectedModel | null {
  const lines = content.split("\n");
  let model = "";
  let provider = "";
  let baseUrl = "";
  let hasApiKey = false;
  let apiMode = "";
  let inModelSection = false;
  let modelSectionIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const indent = line.length - line.trimStart().length;

    // Track model: section (indent 0)
    if (/^model:\s*$/.test(trimmed) && indent === 0) {
      inModelSection = true;
      modelSectionIndent = 0;
      continue;
    }

    // We left the model section if indent drops back to the section level or below
    if (inModelSection && indent <= modelSectionIndent && trimmed && !trimmed.startsWith("#")) {
      inModelSection = false;
    }

    if (inModelSection) {
      const match = trimmed.match(/^\s*(\w+)\s*:\s*(.+)$/);
      if (match) {
        const key = match[1];
        const val = match[2].trim().replace(/#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
        if (key === "default") model = val;
        if (key === "provider") provider = val;
        if (key === "base_url") baseUrl = val;
        if (key === "api_key") hasApiKey = val.length > 0;
        if (key === "api_mode") apiMode = val;
      }
    }
  }

  if (!model) return null;

  return { model, provider, baseUrl, hasApiKey, apiMode, source: "config" };
}

/**
 * Infer a provider from the model name using prefix-based hints.
 *
 * For example:
 *   "gpt-5.4"       → "copilot"
 *   "claude-sonnet-4" → "anthropic"
 *   "glm-5-turbo"   → "zai"
 *
 * Returns undefined if no hint matches (caller should fall back to "auto").
 */
export function inferProviderFromModel(model: string): string | undefined {
  const lower = model.toLowerCase();

  // Strip provider/ prefix if present (e.g. "anthropic/claude-sonnet-4")
  const bareName = lower.includes("/") ? lower.split("/").pop()! : lower;

  for (const [prefix, hint] of MODEL_PREFIX_PROVIDER_HINTS) {
    if (bareName.startsWith(prefix)) {
      return hint;
    }
  }

  return undefined;
}

/**
 * Resolve the correct provider for a model, using a priority chain:
 *
 *   1. Explicit provider from adapterConfig (highest priority — user override)
 *   2. Provider from Hermes config file — ONLY if the config model matches
 *      the requested model (otherwise the config provider is for a different model)
 *   3. If Hermes config matches the requested model but uses runtime settings that
 *      the adapter cannot represent directly, return "auto" and let Hermes resolve it itself
 *   4. Provider inferred from model name prefix
 *   5. "auto" (let Hermes figure it out — lowest priority)
 *
 * Always returns a valid provider string.
 * The `resolvedFrom` field indicates which source was used, useful for logging.
 */
export function resolveProvider(options: {
  /** Explicit provider from adapterConfig (user override) */
  explicitProvider?: string | null;
  /** Provider detected from Hermes config file */
  detectedProvider?: string;
  /** Model name from Hermes config file (to check consistency) */
  detectedModel?: string;
  /** Base URL detected from Hermes config file */
  detectedBaseUrl?: string;
  /** Whether Hermes config includes a non-empty API key */
  detectedHasApiKey?: boolean;
  /** API mode detected from Hermes config file */
  detectedApiMode?: string;
  /** Model name to infer from if no explicit/detected provider */
  model?: string;
}): { provider: string; resolvedFrom: string } {
  const {
    explicitProvider,
    detectedProvider,
    detectedModel,
    detectedBaseUrl,
    detectedHasApiKey,
    detectedApiMode,
    model,
  } = options;

  // 1. Explicit provider from adapterConfig — user override, always wins
  if (explicitProvider && (VALID_PROVIDERS as readonly string[]).includes(explicitProvider)) {
    return { provider: explicitProvider, resolvedFrom: "adapterConfig" };
  }

  const supportedProviders = VALID_PROVIDERS as readonly string[];
  const configMatchesRequestedModel =
    !!detectedModel &&
    !!model &&
    detectedModel.toLowerCase() === model.toLowerCase();

  // 2. Provider from Hermes config file — but ONLY if the config model matches
  //    the requested model. Otherwise the config provider is for a different model
  //    and would cause exactly the kind of routing bug we're fixing.
  if (
    configMatchesRequestedModel &&
    !!detectedProvider &&
    supportedProviders.includes(detectedProvider)
  ) {
    return { provider: detectedProvider, resolvedFrom: "hermesConfig" };
  }

  const hasRuntimeSignals = !!detectedBaseUrl || !!detectedHasApiKey || !!detectedApiMode;

  // 3a. Matching Hermes config with an unsupported provider (for example "custom")
  //     should not fall through to model-name inference, because that can route to
  //     the wrong provider entirely. Defer back to Hermes's own runtime resolution.
  if (configMatchesRequestedModel && !!detectedProvider && !supportedProviders.includes(detectedProvider)) {
    return {
      provider: "auto",
      resolvedFrom: `hermesConfigUnsupported:${detectedProvider}`,
    };
  }

  // 3b. Matching Hermes config may omit provider entirely while still specifying
  //     enough runtime information (base_url, api_key, api_mode) for Hermes itself.
  //     In that case, also defer to Hermes instead of doing a wrong prefix inference.
  if (configMatchesRequestedModel && !detectedProvider && hasRuntimeSignals) {
    return {
      provider: "auto",
      resolvedFrom: "hermesConfigRuntime",
    };
  }

  // 4. Infer from model name prefix
  if (model) {
    const inferred = inferProviderFromModel(model);
    if (inferred) {
      return { provider: inferred, resolvedFrom: "modelInference" };
    }
  }

  // 5. Let Hermes auto-detect
  return { provider: "auto", resolvedFrom: "auto" };
}
