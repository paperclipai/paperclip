import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  isCodexLocalKnownModel,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "../index.js";

// Models that are NOT supported for ChatGPT subscription accounts with Codex.
// These fail with "unsupported model" errors when used via the Codex CLI.
// Fallback: if a known model fails at runtime, retry with gpt-5.3-codex-spark.
const UNSUPPORTED_CHATGPT_MODELS = new Set([
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5",
  "o3",
  "o4-mini",
  "gpt-5-mini",
  "gpt-5-nano",
  "o3-mini",
  "codex-mini-latest",
]);

// Models that require ChatGPT subscription (not API key).
// These are safe for ChatGPT accounts but not for API key accounts.
const CHATGPT_ONLY_MODELS = new Set([
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5",
  "o3",
  "o4-mini",
  "gpt-5-mini",
  "gpt-5-nano",
  "o3-mini",
  "codex-mini-latest",
]);

// Models that work with both ChatGPT subscription and API key accounts.
const UNIVERSAL_MODELS = new Set([
  "gpt-5.4",
  DEFAULT_CODEX_LOCAL_MODEL,
]);

/**
 * Detect if the configured model is likely unsupported for the current account type.
 * Returns true if the model is in the unsupported set (likely a ChatGPT account
 * using a non-spark model that fails with Codex CLI).
 */
function isLikelyUnsupportedModel(model: string): boolean {
  if (!model) return false;
  // gpt-5.3-codex (without -spark) is the most common failure case for ChatGPT accounts
  if (model === "gpt-5.3-codex") return true;
  // Other non-spark ChatGPT-only models
  if (CHATGPT_ONLY_MODELS.has(model) && !model.includes("spark")) return true;
  return false;
}

/**
 * Resolve a fallback model when the configured model fails.
 * Priority: gpt-5.3-codex-spark (cheap lane) > gpt-5.3-codex (default) > gpt-5.4
 */
function resolveFallbackModel(originalModel: string): string {
  // Spark is always the safest fallback for ChatGPT accounts
  return "gpt-5.3-codex-spark";
}

export type BuildCodexExecArgsResult = {
  args: string[];
  model: string;
  fastModeRequested: boolean;
  fastModeApplied: boolean;
  fastModeIgnoredReason: string | null;
  modelFallbackApplied: boolean;
  originalModel: string;
};

function readExtraArgs(config: unknown): string[] {
  const fromExtraArgs = asStringArray(asRecord(config).extraArgs);
  if (fromExtraArgs.length > 0) return fromExtraArgs;
  return asStringArray(asRecord(config).args);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatFastModeSupportedModels(): string {
  return `${CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS.join(", ")} or manually configured model IDs`;
}

export function buildCodexExecArgs(
  config: unknown,
  options: {
    resumeSessionId?: string | null;
    skipGitRepoCheck?: boolean;
    detectUnsupportedModel?: boolean; // Enable pre-flight unsupported model detection
  } = {},
): BuildCodexExecArgsResult {
  const record = asRecord(config);
  let model = asString(record.model, "").trim();
  const originalModel = model;
  const modelReasoningEffort = asString(
    record.modelReasoningEffort,
    asString(record.reasoningEffort, ""),
  ).trim();
  const search = asBoolean(record.search, false);
  const fastModeRequested = asBoolean(record.fastMode, false);
  let fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  const bypass = asBoolean(
    record.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(record.dangerouslyBypassSandbox, false),
  );
  const extraArgs = readExtraArgs(record);

  // Pre-flight: detect unsupported models and fallback
  let modelFallbackApplied = false;
  if (options.detectUnsupportedModel && isLikelyUnsupportedModel(model)) {
    const fallback = resolveFallbackModel(model);
    console.warn(
      `[codex-local] Model "${model}" is likely unsupported for this account type. ` +
      `Falling back to "${fallback}"`,
    );
    model = fallback;
    modelFallbackApplied = true;
    // Re-evaluate fast mode with the fallback model
    fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  }

  const args = ["exec", "--json"];
  if (options.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (search) args.unshift("--search");
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) args.push("--model", model);
  if (modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
  }
  if (fastModeApplied) {
    args.push("-c", 'service_tier="fast"', "-c", "features.fast_mode=true");
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  if (options.resumeSessionId) args.push("resume", options.resumeSessionId, "-");
  else args.push("-");

  return {
    args,
    model,
    fastModeRequested,
    fastModeApplied,
    fastModeIgnoredReason:
      fastModeRequested && !fastModeApplied
        ? `Configured fast mode is currently only supported on ${formatFastModeSupportedModels()}; Paperclip will ignore it for model ${model || "(default)"}.`
        : null,
    modelFallbackApplied,
    originalModel,
  };
}
