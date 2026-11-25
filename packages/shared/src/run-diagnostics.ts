/**
 * Closed vocabulary of platform-owned runtime diagnostic codes observed inside
 * agent runs, including runs whose outer process still exited 0 ("succeeded").
 *
 * Privacy boundary: these codes are fixed, low-cardinality platform identifiers.
 * Never add customer text, paths, commands, or arbitrary error messages here.
 */
export const RUN_PLATFORM_DIAGNOSTIC_CODES = [
  "git_storage_guard_unavailable",
  "git_storage_limit",
  "github_capability_missing",
  "github_capability_rejected",
  "github_broker_unavailable",
  "sandbox_disk_full",
] as const;

export type RunPlatformDiagnosticCode = (typeof RUN_PLATFORM_DIAGNOSTIC_CODES)[number];

const DIAGNOSTIC_CODE_SET = new Set<string>(RUN_PLATFORM_DIAGNOSTIC_CODES);

export function isRunPlatformDiagnosticCode(value: unknown): value is RunPlatformDiagnosticCode {
  return typeof value === "string" && DIAGNOSTIC_CODE_SET.has(value);
}

const GIT_STORAGE_LIMIT_RE =
  /paperclip_git_storage_limit:[^\n]*(?:too little free disk space|too few free inodes|stopped at its storage budget)/i;
const GIT_STORAGE_GUARD_ANY_RE = /paperclip_git_storage_limit:/i;
const GIT_STORAGE_GUARD_REASON_RE = /\b(?:reason=git_storage_guard_unavailable|git=storage_guard_unavailable)\b/i;
const GITHUB_CAPABILITY_MISSING_RE = /Paperclip:\s*GitHub\s+capability_missing\b/i;
const GITHUB_CAPABILITY_REJECTED_RE = /Paperclip:\s*GitHub\s+capability_rejected\b/i;
const GITHUB_BROKER_UNAVAILABLE_RE =
  /Paperclip:\s*GitHub\s+(?:broker_response_unavailable\b|credential service is not reachable)/i;
const SANDBOX_DISK_FULL_RE = /\b(?:ENOSPC|EDQUOT)\b|No space left on device|Disk quota exceeded/i;

/**
 * Classify known platform guard/launcher diagnostic messages from run text.
 * Pure and deterministic; returns sorted unique diagnostic codes.
 */
export function detectRunPlatformDiagnostics(text: string): RunPlatformDiagnosticCode[] {
  if (!text) return [];
  const found = new Set<RunPlatformDiagnosticCode>();

  if (GIT_STORAGE_LIMIT_RE.test(text)) {
    found.add("git_storage_limit");
    found.add("sandbox_disk_full");
  }
  if (GIT_STORAGE_GUARD_REASON_RE.test(text)) {
    found.add("git_storage_guard_unavailable");
  } else if (GIT_STORAGE_GUARD_ANY_RE.test(text)) {
    // Check each matching line so a log with both a limit refusal and a
    // misconfigured guard refusal records both codes accurately.
    for (const line of text.split(/\r?\n/)) {
      if (GIT_STORAGE_GUARD_ANY_RE.test(line) && !GIT_STORAGE_LIMIT_RE.test(line)) {
        found.add("git_storage_guard_unavailable");
        break;
      }
    }
  }
  if (GITHUB_CAPABILITY_MISSING_RE.test(text)) {
    found.add("github_capability_missing");
  }
  if (GITHUB_CAPABILITY_REJECTED_RE.test(text)) {
    found.add("github_capability_rejected");
  }
  if (GITHUB_BROKER_UNAVAILABLE_RE.test(text)) {
    found.add("github_broker_unavailable");
  }
  if (SANDBOX_DISK_FULL_RE.test(text)) {
    found.add("sandbox_disk_full");
  }

  return [...found].sort();
}
