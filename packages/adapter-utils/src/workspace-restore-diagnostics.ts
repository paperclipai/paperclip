import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeProgressSink } from "./runtime-progress.js";

type RestorePhase = "workspace" | "asset";
const RESTORE_STEPS = new Set([
  "git_export", "git_import", "workspace_transfer", "workspace_extract",
  "directory_merge", "git_integration", "index_reset", "git_ref_cleanup", "asset_restore",
] as const);
export type WorkspaceRestoreStep = typeof RESTORE_STEPS extends Set<infer T> ? T : never;
const GIT_COMMANDS = new Set([
  "rev_parse", "symbolic_ref", "merge_base", "merge_tree", "commit_tree", "update_ref", "log",
] as const);
export type WorkspaceRestoreGitCommand = typeof GIT_COMMANDS extends Set<infer T> ? T : never;
const GIT_FAILURE_KINDS = new Set([
  "merge_conflict", "invalid_object", "ref_conflict", "permission_denied", "unknown",
] as const);
type GitFailureKind = typeof GIT_FAILURE_KINDS extends Set<infer T> ? T : never;
export interface WorkspaceRestoreDiagnostic {
  phase: RestorePhase;
  step?: WorkspaceRestoreStep;
  errorCode: string;
  httpStatus?: number;
  exitCode?: number;
  gitCommand?: WorkspaceRestoreGitCommand;
  gitFailureKind?: GitFailureKind;
}
const ERROR_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EXDEV", "ENOTDIR", "EISDIR",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);
type ErrorDiagnostic = Pick<WorkspaceRestoreDiagnostic, "errorCode" | "httpStatus" | "exitCode">;
interface DiagnosticScope {
  active: boolean;
  sequence: number;
  failures: Map<unknown, {
    sequence: number;
    step?: WorkspaceRestoreStep;
    gitCommand?: WorkspaceRestoreGitCommand;
    gitFailureKind?: GitFailureKind;
  }>;
}
const activeDiagnostic = new AsyncLocalStorage<DiagnosticScope>();
// Never attach a raw cause to an error just to retain a numeric Git exit code.
const wrappedDiagnostics = new WeakMap<object, ErrorDiagnostic>();
const restoreDiagnostics = new WeakMap<object, WorkspaceRestoreDiagnostic>();
const diagnosticCapture = new AsyncLocalStorage<WeakMap<object, WorkspaceRestoreDiagnostic>>();

/** Keep each settlement's diagnostic receipt isolated across asynchronous work. */
export function withWorkspaceRestoreDiagnosticCapture<T>(operation: () => Promise<T>): Promise<T> {
  return diagnosticCapture.run(new WeakMap(), operation);
}

function readField(value: Record<string, unknown>, key: string): unknown {
  try { return value[key]; } catch { return undefined; }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value : undefined;
}

/** Inspect bounded stderr only in memory; never persist Git text or arguments. */
function gitFailureKind(command: WorkspaceRestoreGitCommand, error: unknown): GitFailureKind {
  if (!error || typeof error !== "object") return "unknown";
  const value = error as Record<string, unknown>;
  const code = readField(value, "code");
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (readField(value, "killed") || readField(value, "signal")) return "unknown";
  const stderr = readField(value, "stderr");
  const text = typeof stderr === "string" ? stderr.slice(0, 16 * 1024) : "";
  if (command === "update_ref" && /cannot lock ref '[^'\r\n]+': is at [a-f0-9]{40,64} but expected [a-f0-9]{40,64}(?:\s|$)/m.test(text)) {
    return "ref_conflict";
  }
  if (/^fatal: (?:bad object |Not a valid object name |not a valid object name |Not a valid commit name )/m.test(text)
      || (command === "merge_tree" && /^merge-tree: [a-f0-9]{40,64} - not something we can merge\s*$/m.test(text))) {
    return "invalid_object";
  }
  // merge-tree --write-tree prints the merged tree before reporting conflicts.
  // Exit 1 alone is insufficient: some Git versions also use it for bad objects.
  const stdout = readField(value, "stdout");
  if (command === "merge_tree" && code === 1 && typeof stdout === "string"
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})\r?\n/.test(stdout.slice(0, 66))) return "merge_conflict";
  return "unknown";
}

/** Annotate the original thrown error in its restore scope; never change it. */
export async function withWorkspaceRestoreGitCommand<T>(command: WorkspaceRestoreGitCommand, operation: () => Promise<T>): Promise<T> {
  const scope = activeDiagnostic.getStore();
  if (!scope?.active || !GIT_COMMANDS.has(command)) return await operation();
  const started = scope.sequence;
  try {
    return await operation();
  } catch (error) {
    // A ref transaction can fail in its nested branch-identity probe. Retain
    // that more specific command, while later retries get fresh attribution.
    if (scope.active && (scope.failures.get(error)?.sequence ?? -1) <= started) scope.failures.set(error, {
      sequence: ++scope.sequence, gitCommand: command, gitFailureKind: gitFailureKind(command, error),
    });
    throw error;
  }
}

/** Only fixed codes and bounded numbers may enter the company-readable run log. */
function diagnostic(error: unknown): ErrorDiagnostic {
  const result: ErrorDiagnostic = { errorCode: "unknown" };
  let current = error;
  // SDKs wrap transport errors in a cause. Bound traversal, including cycles.
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const value = current as Record<string, unknown>;
    const saved = wrappedDiagnostics.get(value);
    const code = saved?.errorCode !== "unknown" && saved?.errorCode !== undefined
      ? saved.errorCode : readField(value, "code");
    if (result.errorCode === "unknown" && typeof code === "string" && ERROR_CODES.has(code)) {
      result.errorCode = code;
    }
    const status = saved?.httpStatus ?? boundedInteger(readField(value, "status"), 400, 599)
      ?? boundedInteger(readField(value, "statusCode"), 400, 599);
    if (result.httpStatus === undefined && status !== undefined) {
      result.httpStatus = status;
    }
    const exitCode = saved?.exitCode ?? boundedInteger(readField(value, "exitCode"), 1, 255) ?? boundedInteger(code, 1, 255);
    if (result.exitCode === undefined && exitCode !== undefined) {
      result.exitCode = exitCode;
    }
    current = readField(value, "cause");
  }
  return result;
}

/** Retain bounded fields across an existing error wrapper, without a raw cause. */
export function preserveWorkspaceRestoreErrorDiagnostic<T extends object>(wrapper: T, source: unknown): T {
  wrappedDiagnostics.set(wrapper, diagnostic(source));
  const scope = activeDiagnostic.getStore();
  const failure = scope?.active ? scope.failures.get(source) : undefined;
  if (failure) scope!.failures.set(wrapper, failure);
  return wrapper;
}

/** Decode persisted adapter metadata; never copy arbitrary properties or text. */
export function sanitizeWorkspaceRestoreDiagnostic(value: unknown): WorkspaceRestoreDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const phase = readField(record, "phase");
  if (phase !== "workspace" && phase !== "asset") return undefined;
  const step = readField(record, "step");
  const code = readField(record, "errorCode");
  const httpStatus = boundedInteger(readField(record, "httpStatus"), 400, 599);
  const exitCode = boundedInteger(readField(record, "exitCode"), 1, 255);
  const gitCommand = readField(record, "gitCommand");
  const gitFailureKind = readField(record, "gitFailureKind");
  const hasGitCommand = phase === "workspace" && step === "git_integration"
    && typeof gitCommand === "string" && GIT_COMMANDS.has(gitCommand as WorkspaceRestoreGitCommand);
  return {
    phase,
    ...(typeof step === "string" && RESTORE_STEPS.has(step as WorkspaceRestoreStep)
      ? { step: step as WorkspaceRestoreStep } : {}),
    errorCode: typeof code === "string" && ERROR_CODES.has(code) ? code : "unknown",
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(hasGitCommand ? {
      gitCommand: gitCommand as WorkspaceRestoreGitCommand,
      gitFailureKind: typeof gitFailureKind === "string" && GIT_FAILURE_KINDS.has(gitFailureKind as GitFailureKind)
        ? gitFailureKind as GitFailureKind : "unknown",
    } : {}),
  };
}

export function getWorkspaceRestoreDiagnostic(error: unknown): WorkspaceRestoreDiagnostic | undefined {
  return error && typeof error === "object"
    ? sanitizeWorkspaceRestoreDiagnostic((diagnosticCapture.getStore() ?? restoreDiagnostics).get(error)) : undefined;
}

/** Preserve the scheduler-selected task's snapshot when errors share identity. */
export function recordWorkspaceRestoreDiagnostic(error: unknown, diagnostic: WorkspaceRestoreDiagnostic | undefined): void {
  const safe = sanitizeWorkspaceRestoreDiagnostic(diagnostic);
  if (error && typeof error === "object") {
    const receipts = diagnosticCapture.getStore() ?? restoreDiagnostics;
    if (safe) receipts.set(error, safe);
    else receipts.delete(error);
  }
  const scope = activeDiagnostic.getStore();
  if (scope?.active) {
    if (safe?.step) scope.failures.set(error, {
      sequence: ++scope.sequence, step: safe.step,
      ...(safe.gitCommand ? { gitCommand: safe.gitCommand, gitFailureKind: safe.gitFailureKind } : {}),
    });
    else scope.failures.delete(error);
  }
}

/** Record only the failing step. Successful cleanup must not replace evidence. */
export async function withWorkspaceRestoreStep<T>(step: WorkspaceRestoreStep, operation: () => Promise<T>): Promise<T> {
  const scope = activeDiagnostic.getStore();
  if (!scope?.active) return await operation();
  const started = scope.sequence;
  try {
    return await operation();
  } catch (error) {
    // A nested step owns its failure. A caught/retried error may be thrown again
    // by a later step, so identity alone cannot identify the current failure.
    if (scope.active) {
      const failure = scope.failures.get(error);
      if (failure && failure.sequence > started) {
        failure.step ??= step;
      } else {
        scope.failures.set(error, { sequence: ++scope.sequence, step });
      }
    }
    throw error;
  }
}

/** Add evidence without changing the thrown error, restore policy, or task ordering. */
export async function withWorkspaceRestoreDiagnostics<T>(
  phase: RestorePhase,
  operation: () => Promise<T>,
  onProgress?: RuntimeProgressSink,
  onDiagnostic?: (diagnostic: WorkspaceRestoreDiagnostic) => void,
): Promise<T> {
  // A nested repository restore propagates to its enclosing workspace task.
  // That task owns the diagnostic. Independent parallel tasks retain their own
  // async scopes, so two failed tasks still produce two diagnostic lines.
  const parent = activeDiagnostic.getStore();
  const scope: DiagnosticScope = { active: true, sequence: 0, failures: new Map() };
  return await activeDiagnostic.run(scope, async () => {
    try {
      return await operation();
    } catch (error) {
      const failure = scope.failures.get(error);
      const step = failure?.step;
      const fields = { phase, ...(step ? { step } : {}), ...diagnostic(error),
        ...(phase === "workspace" && step === "git_integration" && failure?.gitCommand
          ? { gitCommand: failure.gitCommand, gitFailureKind: failure.gitFailureKind } : {}),
      };
      recordWorkspaceRestoreDiagnostic(error, fields);
      if (parent?.active && step) parent.failures.set(error, { ...failure, sequence: ++parent.sequence, step });
      try {
        onDiagnostic?.({ ...fields });
      } catch { /* Diagnostic consumers cannot replace a restore failure. */ }
      try {
        if (!parent?.active) await onProgress?.(`[paperclip] Workspace restore diagnostic: ${JSON.stringify(fields)}\n`);
      } catch {
        // A broken log sink must not replace a restore failure or relax its safety classification.
      }
      throw error;
    } finally {
      scope.active = false;
      scope.failures.clear();
    }
  });
}
