import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
} from "../index.js";

export type BuildCodexExecArgsResult = {
  args: string[];
  model: string;
  fastModeRequested: boolean;
  fastModeApplied: boolean;
  fastModeIgnoredReason: string | null;
  reasoningEffortNormalizedReason: string | null;
  reasoningEffortIgnoredReason: string | null;
};

const CODEX_SUPPORTED_REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
]);

const CODEX_REASONING_EFFORT_ALIASES: Record<string, string> = {
  xhigh: "high",
};

type NormalizedReasoningEffort = {
  effort: string;
  ignoredReason: string | null;
  normalizedReason: string | null;
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

function normalizeModelReasoningEffort(
  modelReasoningEffort: string,
): NormalizedReasoningEffort {
  if (!modelReasoningEffort) {
    return { effort: "", ignoredReason: null, normalizedReason: null };
  }
  const normalizedInput = modelReasoningEffort.trim().toLowerCase();
  const aliasedEffort = Object.prototype.hasOwnProperty.call(
    CODEX_REASONING_EFFORT_ALIASES,
    normalizedInput,
  )
    ? CODEX_REASONING_EFFORT_ALIASES[normalizedInput]
    : normalizedInput;
  if (!CODEX_SUPPORTED_REASONING_EFFORTS.has(aliasedEffort)) {
    return {
      effort: "",
      ignoredReason: `Ignored unsupported modelReasoningEffort "${modelReasoningEffort}". Supported values: minimal, low, medium, high.`,
      normalizedReason: null,
    };
  }
  return {
    effort: aliasedEffort,
    ignoredReason: null,
    normalizedReason:
      aliasedEffort !== normalizedInput
        ? `Normalized modelReasoningEffort "${modelReasoningEffort}" to "${aliasedEffort}" for Codex exec compatibility.`
        : null,
  };
}

export function buildCodexExecArgs(
  config: unknown,
  options: { resumeSessionId?: string | null } = {},
): BuildCodexExecArgsResult {
  const record = asRecord(config);
  const model = asString(record.model, "").trim();
  const rawModelReasoningEffort = asString(
    record.modelReasoningEffort,
    asString(record.reasoningEffort, ""),
  ).trim();
  const modelReasoningEffort = normalizeModelReasoningEffort(rawModelReasoningEffort);
  const search = asBoolean(record.search, false);
  const fastModeRequested = asBoolean(record.fastMode, false);
  const fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  const bypass = asBoolean(
    record.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(record.dangerouslyBypassSandbox, false),
  );
  const extraArgs = readExtraArgs(record);

  const args = ["exec", "--json"];
  if (search) args.unshift("--search");
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (model) args.push("--model", model);
  if (modelReasoningEffort.effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort.effort)}`);
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
    reasoningEffortNormalizedReason: modelReasoningEffort.normalizedReason,
    reasoningEffortIgnoredReason: modelReasoningEffort.ignoredReason,
  };
}
