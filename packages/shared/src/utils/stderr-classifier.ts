/**
 * Classifies individual stderr lines from agent runs.
 *
 * "benign" lines are known-noisy patterns that do not indicate a real
 * failure — they should be surfaced as warnings, not errors, in the UI.
 * "error" lines are everything else: unknown or genuinely fatal.
 */

export type StderrLineClass = "benign" | "error";

/**
 * Named pattern groups for known benign stderr noise.
 * Each entry includes a human-readable label shown in UI tooltips.
 */
export const BENIGN_STDERR_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // MCP transport authentication noise (rmcp Rust library logs)
  // e.g. "2024-... WARN rmcp::transport::worker ... invalid_token"
  {
    name: "mcp_auth_noise",
    pattern: /rmcp::/,
  },
  // Node.js DEP-prefixed deprecation warnings
  {
    name: "node_deprecation",
    pattern: /\(node:\d+\)\s+(DEP\d+|ExperimentalWarning)/,
  },
  // Generic Node.js ExperimentalWarning (some versions omit the DEP code)
  {
    name: "node_experimental",
    pattern: /ExperimentalWarning/,
  },
  // Codex CLI session/context debug output (not errors)
  {
    name: "codex_session_debug",
    pattern: /\[codex\]\s+(?:session|context|loaded|saving)/i,
  },
  // Deno/Node install script telemetry or update notices
  {
    name: "update_notice",
    pattern: /A new (?:version|release) of .* is available/i,
  },
  // Rust `tracing` crate log lines (INFO/DEBUG/WARN from known benign crates)
  {
    name: "rust_tracing_info",
    pattern: / (INFO|DEBUG|TRACE) [\w:]+: /,
  },
  // Claude/Codex CLI session persistence and cwd mismatch messages emitted to stderr
  {
    name: "paperclip_session_cwd_mismatch",
    pattern: /\[paperclip\] (?:Claude|Codex) session "[^"]+" was saved/i,
  },
  // Claude-local instructions file fallback logs are informational
  {
    name: "paperclip_instructions_fallback",
    pattern: /\[paperclip\] Configured instructionsFilePath .* was not readable/i,
  },
  // Paperclip internal retry/warning prefixed lines
  {
    name: "paperclip_retry",
    pattern: /\[paperclip\] (?:retrying|session unavailable|waiting)/i,
  },
  // Codex shell snapshot cleanup warnings are noisy but non-fatal.
  {
    name: "codex_shell_snapshot_cleanup",
    pattern: /codex_core::shell_snapshot: Failed to delete shell snapshot/i,
  },
  // MCP OAuth/token auth failures from optional integrations are noisy but
  // should not count as runtime errors for the agent itself.
  {
    name: "mcp_oauth_auth_required",
    pattern: /AuthRequired\(AuthRequiredError|Missing or invalid access token/i,
  },
];

/**
 * Classify a single stderr line.
 *
 * Returns "benign" if the line matches any known-benign pattern,
 * "error" otherwise.
 */
export function classifyStderrLine(line: string): StderrLineClass {
  for (const { pattern } of BENIGN_STDERR_PATTERNS) {
    if (pattern.test(line)) return "benign";
  }
  return "error";
}

export interface StderrStats {
  /** Lines matching a known-benign pattern */
  benignCount: number;
  /** Lines that are unclassified (potentially real errors) */
  errorCount: number;
  /** Total non-empty stderr lines processed */
  totalCount: number;
}

/**
 * Scan a multi-line stderr chunk and accumulate classification counts.
 * Call repeatedly as chunks arrive; pass the running accumulator each time.
 */
export function accumulateStderrStats(chunk: string, acc: StderrStats = { benignCount: 0, errorCount: 0, totalCount: 0 }): StderrStats {
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    acc.totalCount++;
    if (classifyStderrLine(trimmed) === "benign") {
      acc.benignCount++;
    } else {
      acc.errorCount++;
    }
  }
  return acc;
}
