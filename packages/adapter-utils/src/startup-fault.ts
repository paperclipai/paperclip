import { createHash } from "node:crypto";

export const ADAPTER_STARTUP_FAULT_ERROR_CODE = "adapter_startup_fault";

export type StartupFaultKind =
  | "worktree_requires_git_repository"
  | "startup_diagnostic_without_agent_output";

export type StartupFaultScope = {
  adapterType?: string | null;
  effectiveConfigFingerprint?: string | null;
};

export const STARTUP_FAULT_DIAGNOSTIC: Record<StartupFaultKind, string> = {
  worktree_requires_git_repository: "--worktree requires being inside a git repository",
  startup_diagnostic_without_agent_output: "startup diagnostic without agent output",
};

export type StartupFaultEvidence = {
  kind: StartupFaultKind;
  fingerprint: string;
  diagnostic: string;
};

const WORKTREE_STARTUP_LINE_RE = /^(x\s+)?--worktree requires being inside a git repository\b/i;
const WORKTREE_CD_LINE_RE = /^cd into your project repo first\b/i;
const HERMES_STARTUP_BANNER_RE = /^\[hermes\]\s+Starting Hermes Agent\b/i;
const HERMES_EXIT_BANNER_RE = /^\[hermes\]\s+Exit code:/i;
const HERMES_WARNING_RE = /^\[hermes\]\s+Warning:/i;
const UNKNOWN_TOOLSETS_WARNING_RE = /^Warning:\s+Unknown toolsets:/i;

function normalizeDiagnosticLine(line: string) {
  return line.trim().replace(/\s+/g, " ");
}

function readNonEmpty(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isStartupBannerOrWarningLine(line: string) {
  return (
    HERMES_WARNING_RE.test(line)
    || UNKNOWN_TOOLSETS_WARNING_RE.test(line)
    || HERMES_STARTUP_BANNER_RE.test(line)
    || HERMES_EXIT_BANNER_RE.test(line)
  );
}

function isStartupDiagnosticOnlyLine(line: string) {
  return WORKTREE_STARTUP_LINE_RE.test(line) || WORKTREE_CD_LINE_RE.test(line);
}

function stripStartupNoiseFromText(text: string) {
  return text
    .split("\n")
    .map((line) => normalizeDiagnosticLine(line))
    .filter(Boolean)
    .filter((line) => !isStartupBannerOrWarningLine(line) && !isStartupDiagnosticOnlyLine(line))
    .join("\n")
    .trim();
}

function hasPositiveStartupEvidence(input: {
  sessionId?: string | null;
  response?: string | null;
}) {
  if (readNonEmpty(input.sessionId)) return true;
  const response = readNonEmpty(input.response);
  if (!response) return false;
  return stripStartupNoiseFromText(response).length > 0;
}

function collectDiagnosticLines(stdout: string, stderr: string) {
  const lines = `${stdout}\n${stderr}`
    .split("\n")
    .map((line) => normalizeDiagnosticLine(line))
    .filter(Boolean)
    .filter((line) => !isStartupBannerOrWarningLine(line));
  return lines;
}

function findWorktreeStartupDiagnosticLine(input: {
  stdout: string;
  stderr: string;
  response?: string | null;
}) {
  const combinedStdout = [
    input.stdout,
    readNonEmpty(input.response) ?? "",
  ].filter(Boolean).join("\n");
  return collectDiagnosticLines(combinedStdout, input.stderr).find(
    (line) => WORKTREE_STARTUP_LINE_RE.test(line) || WORKTREE_CD_LINE_RE.test(line),
  ) ?? null;
}

function fingerprintStartupFault(
  kind: StartupFaultKind,
  diagnostic: string,
  scope?: StartupFaultScope,
) {
  const digest = createHash("sha256")
    .update([
      kind,
      normalizeDiagnosticLine(diagnostic),
      readNonEmpty(scope?.adapterType) ?? "",
      readNonEmpty(scope?.effectiveConfigFingerprint) ?? "",
    ].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `startup_fault:v1:${kind}:${digest}`;
}

function readConfigObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readStartupFaultIssueAdapterConfig(assigneeAdapterOverrides: unknown) {
  return readConfigObject(readConfigObject(assigneeAdapterOverrides).adapterConfig);
}

export function readStartupFaultModelProfileAdapterConfig(
  runtimeConfig: unknown,
  assigneeAdapterOverrides: unknown,
) {
  const profileKey = readConfigObject(assigneeAdapterOverrides).modelProfile;
  if (typeof profileKey !== "string" || profileKey.trim().length === 0) return {};
  const profiles = readConfigObject(readConfigObject(runtimeConfig).modelProfiles);
  return readConfigObject(readConfigObject(profiles[profileKey]).adapterConfig);
}

export function hashStartupFaultConfigIdentity(input: {
  adapterType?: string | null;
  adapterConfig?: unknown;
  modelProfileAdapterConfig?: unknown;
  issueAdapterConfig?: unknown;
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      adapterType: readNonEmpty(input.adapterType) ?? "",
      adapterConfig: {
        ...readConfigObject(input.adapterConfig),
        ...readConfigObject(input.modelProfileAdapterConfig),
        ...readConfigObject(input.issueAdapterConfig),
      },
    }))
    .digest("hex")
    .slice(0, 24);
}

export function classifyAdapterStartupOutput(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  sessionId?: string | null;
  response?: string | null;
  worktreeMode?: boolean;
  adapterType?: string | null;
  effectiveConfigFingerprint?: string | null;
}): StartupFaultEvidence | null {
  if (input.timedOut) return null;

  const exitCode = input.exitCode ?? 0;
  if (exitCode !== 0) return null;
  if (hasPositiveStartupEvidence(input)) return null;

  const scope: StartupFaultScope = {
    adapterType: input.adapterType,
    effectiveConfigFingerprint: input.effectiveConfigFingerprint,
  };

  const worktreeLine = findWorktreeStartupDiagnosticLine(input);
  if (worktreeLine) {
    const kind: StartupFaultKind = "worktree_requires_git_repository";
    const diagnostic = STARTUP_FAULT_DIAGNOSTIC[kind];
    return {
      kind,
      diagnostic,
      fingerprint: fingerprintStartupFault(kind, diagnostic, scope),
    };
  }

  const diagnosticLines = collectDiagnosticLines(input.stdout, input.stderr);
  if (diagnosticLines.length === 0) return null;

  const kind: StartupFaultKind = "startup_diagnostic_without_agent_output";
  const diagnostic = STARTUP_FAULT_DIAGNOSTIC[kind];
  return {
    kind,
    diagnostic,
    fingerprint: fingerprintStartupFault(kind, diagnostic, scope),
  };
}
