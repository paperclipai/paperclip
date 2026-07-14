import { parseObject } from "../adapters/utils.js";
import { CLAUDE_LOCAL_ADAPTER_TYPE } from "./claude-quota-guard.js";

export const LOCAL_ADAPTER_SETUP_FAILURE_CODE = "acpx_session_init_failed";
export const LOCAL_ADAPTER_SETUP_RECOVERY_CAUSE = "adapter_setup_failed";
export const MANUAL_SAFE_RUN_CONTEXT_KEY = "manualSafeRun";

type LocalAdapterSetupFailureInput = {
  adapterType?: string | null;
  errorCode?: string | null;
  error?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  resultJson?: unknown;
};

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function lower(value: string | null | undefined) {
  return value?.toLowerCase() ?? "";
}

function collectFailureEvidenceText(input: LocalAdapterSetupFailureInput) {
  const result = parseObject(input.resultJson);
  return [
    input.errorCode,
    input.error,
    input.stdoutExcerpt,
    input.stderrExcerpt,
    readNonEmptyString(result.summary),
    readNonEmptyString(result.errorMessage),
    readNonEmptyString(result.message),
    readNonEmptyString(result.phase),
    readNonEmptyString(result.cause),
  ]
    .map((value) => lower(value))
    .filter((value) => value.length > 0)
    .join("\n");
}

export function isClaudeLocalAdapterSetupFailure(input: LocalAdapterSetupFailureInput) {
  if (input.adapterType !== CLAUDE_LOCAL_ADAPTER_TYPE) return false;
  if (input.errorCode === LOCAL_ADAPTER_SETUP_FAILURE_CODE) return true;

  const evidence = collectFailureEvidenceText(input);
  if (!evidence) return false;

  const mentionsMissingFile = evidence.includes("enoent") || evidence.includes("no such file or directory");
  const mentionsSessionSetup = evidence.includes("ensure_session") ||
    evidence.includes("session init") ||
    evidence.includes("session initialization");
  const mentionsWrapperPath = evidence.includes("wrapper") || evidence.includes(".sh");
  const mentionsSpawn = evidence.includes("spawn");

  return mentionsMissingFile && (mentionsSessionSetup || mentionsWrapperPath || mentionsSpawn);
}

export function isManualSafeRunContextSnapshot(contextSnapshot: Record<string, unknown> | null | undefined) {
  return contextSnapshot?.[MANUAL_SAFE_RUN_CONTEXT_KEY] === true;
}
