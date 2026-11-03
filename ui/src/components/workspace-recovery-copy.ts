import { t } from "@/i18n";

const LOCAL_ERRORS = {
  taskChanged: { message: "The task changed. Refresh and try again.", key: "oct26Transcript.taskChanged" },
  taskChangedWhileSaving: { message: "The task changed while saving. Refresh to check its current state.", key: "oct26Transcript.taskChangedWhileSaving" },
} as const;

/** Only locally constructed errors have display codes; server messages stay literal. */
export class WorkspaceRecoveryUiError extends Error {
  constructor(readonly code: keyof typeof LOCAL_ERRORS) {
    super(LOCAL_ERRORS[code].message);
  }
}

export type WorkspaceRecoveryDisplayError =
  | { kind: "local"; code: keyof typeof LOCAL_ERRORS }
  | { kind: "external"; message: string }
  | { kind: "fallback" };

export function workspaceRecoveryDisplayError(cause: unknown): WorkspaceRecoveryDisplayError {
  return cause instanceof WorkspaceRecoveryUiError ? { kind: "local", code: cause.code }
    : cause instanceof Error ? { kind: "external", message: cause.message } : { kind: "fallback" };
}

export function workspaceRecoveryErrorText(error: WorkspaceRecoveryDisplayError, fallbackKey: "oct26Transcript.retryFailed" | "oct19Voice.branchRepairFallback"): string {
  return error.kind === "local" ? t(LOCAL_ERRORS[error.code].key)
    : error.kind === "external" ? error.message : t(fallbackKey);
}
