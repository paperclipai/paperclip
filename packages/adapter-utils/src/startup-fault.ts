import { createHash } from "node:crypto";

export const ADAPTER_STARTUP_FAULT_ERROR_CODE = "adapter_startup_fault";

export type StartupFaultKind =
  | "worktree_requires_git_repository"
  | "startup_diagnostic_without_agent_output";

export type StartupFaultEvidence = {
  kind: StartupFaultKind;
  fingerprint: string;
  diagnostic: string;
};

const WORKTREE_REQUIRES_GIT_RE = /--worktree requires being inside a git repository|requires being inside a git repository|cd into your project repo first/i;
const HERMES_STARTUP_BANNER_RE = /^\[hermes\]\s+Starting Hermes Agent\b/i;
const HERMES_EXIT_BANNER_RE = /^\[hermes\]\s+Exit code:/i;
const HERMES_WARNING_RE = /^\[hermes\]\s+Warning:/i;
const UNKNOWN_TOOLSETS_WARNING_RE = /^Warning:\s+Unknown toolsets:/i;

function normalizeDiagnosticLine(line: string) {
  return line.trim().replace(/\s+/g, " ");
}

function hasPositiveStartupEvidence(input: {
  sessionId?: string | null;
  response?: string | null;
}) {
  if (readNonEmpty(input.sessionId)) return true;
  const response = readNonEmpty(input.response);
  if (!response) return false;
  const normalized = normalizeDiagnosticLine(response);
  if (HERMES_STARTUP_BANNER_RE.test(normalized)) return false;
  if (HERMES_EXIT_BANNER_RE.test(normalized)) return false;
  if (WORKTREE_REQUIRES_GIT_RE.test(normalized)) return false;
  return normalized.length >= 24;
}

function readNonEmpty(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function collectDiagnosticLines(stdout: string, stderr: string) {
  const lines = `${stdout}\n${stderr}`
    .split("\n")
    .map((line) => normalizeDiagnosticLine(line))
    .filter(Boolean)
    .filter((line) => !HERMES_WARNING_RE.test(line))
    .filter((line) => !UNKNOWN_TOOLSETS_WARNING_RE.test(line))
    .filter((line) => !HERMES_STARTUP_BANNER_RE.test(line))
    .filter((line) => !HERMES_EXIT_BANNER_RE.test(line));
  return lines;
}

function fingerprintStartupFault(kind: StartupFaultKind, diagnostic: string) {
  const digest = createHash("sha256")
    .update(`${kind}:${normalizeDiagnosticLine(diagnostic)}`)
    .digest("hex")
    .slice(0, 24);
  return `startup_fault:v1:${kind}:${digest}`;
}

export function classifyAdapterStartupOutput(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  sessionId?: string | null;
  response?: string | null;
  worktreeMode?: boolean;
}): StartupFaultEvidence | null {
  if (input.timedOut) return null;

  const combined = `${input.stdout}\n${input.stderr}`;
  const worktreeMatch = combined.match(WORKTREE_REQUIRES_GIT_RE);
  if (worktreeMatch) {
    const diagnostic = collectDiagnosticLines(input.stdout, input.stderr).find((line) =>
      WORKTREE_REQUIRES_GIT_RE.test(line),
    ) ?? worktreeMatch[0];
    const kind: StartupFaultKind = "worktree_requires_git_repository";
    return {
      kind,
      diagnostic,
      fingerprint: fingerprintStartupFault(kind, diagnostic),
    };
  }

  const exitCode = input.exitCode ?? 0;
  if (exitCode !== 0) return null;
  if (hasPositiveStartupEvidence(input)) return null;

  const diagnosticLines = collectDiagnosticLines(input.stdout, input.stderr);
  if (diagnosticLines.length === 0) return null;

  const diagnostic = diagnosticLines.slice(0, 5).join("\n");
  const kind: StartupFaultKind = "startup_diagnostic_without_agent_output";
  return {
    kind,
    diagnostic,
    fingerprint: fingerprintStartupFault(kind, diagnostic),
  };
}
