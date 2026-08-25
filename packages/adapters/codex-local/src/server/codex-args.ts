import { asBoolean, asString, asStringArray } from "@paperclipai/adapter-utils/server-utils";
import {
  CODEX_LOCAL_FAST_MODE_SUPPORTED_MODELS,
  isCodexLocalFastModeSupported,
  normalizeCodexModel,
} from "../index.js";

const SKIP_GIT_REPO_CHECK_FLAG = "--skip-git-repo-check";

export type BuildCodexExecArgsResult = {
  args: string[];
  model: string;
  fastModeRequested: boolean;
  fastModeApplied: boolean;
  fastModeIgnoredReason: string | null;
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
    restricted?: boolean;
  } = {},
): BuildCodexExecArgsResult {
  const record = asRecord(config);
  const restricted = options.restricted === true;
  const model = normalizeCodexModel(asString(record.model, ""));
  const modelReasoningEffort = asString(
    record.modelReasoningEffort,
    asString(record.reasoningEffort, ""),
  ).trim();
  const search = !restricted && asBoolean(record.search, false);
  const fastModeRequested = asBoolean(record.fastMode, false);
  const fastModeApplied = fastModeRequested && isCodexLocalFastModeSupported(model);
  const bypass = !restricted && asBoolean(
    record.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(record.dangerouslyBypassSandbox, false),
  );
  const extraArgs = readExtraArgs(record);
  if (restricted && extraArgs.length > 0) {
    throw new Error(
      "runtimeToolPolicy blind_judge does not allow Codex adapter extraArgs because they can override the required isolation flags.",
    );
  }

  const args = ["exec", "--json"];
  // Codex rejects a repeated `--skip-git-repo-check` ("cannot be used multiple
  // times"). The adapter injects this flag for sandbox execution, so when an
  // operator's extraArgs already carry it the injection would abort the run
  // with exit code 2. Skip the injection in that case and let the operator's
  // copy stand.
  if (options.skipGitRepoCheck && !extraArgs.includes(SKIP_GIT_REPO_CHECK_FLAG)) {
    args.push(SKIP_GIT_REPO_CHECK_FLAG);
  }
  if (restricted) {
    args.push(
      "--strict-config",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
    );
    for (const feature of [
      "apps",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "goals",
      "image_generation",
      "in_app_browser",
      "multi_agent",
      "multi_agent_v2",
      "plugins",
      "remote_plugin",
      "shell_snapshot",
      "shell_tool",
      "unified_exec",
      "view_image",
      "workspace_dependencies",
    ]) {
      args.push("--disable", feature);
    }
  }
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
  if (options.resumeSessionId && !restricted) args.push("resume", options.resumeSessionId, "-");
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
  };
}
