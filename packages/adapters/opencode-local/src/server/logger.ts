// Adapter-local logger for opencode_local.
//
// We deliberately do not pull in a third-party logger: this package has no
// other runtime dependency beyond @paperclipai/adapter-utils and picocolors,
// and adding pino/winston/etc. for ~50 log callsites would be over-scoped.
// Instead we surface structured one-line records via console.warn with a
// recognisable prefix so operators can grep for `opencode_local` logs without
// dragging a log library into every Paperclip adapter.
//
// The codebase already uses console.warn with `[paperclip]` prefixes for
// adapter-utils' own diagnostics (see sandbox-callback-bridge.ts,
// server-utils.ts, claude-local models.ts). We match that convention here.
//
// Levels:
// - debug: gated on PAPERCLIP_OPENCODE_DEBUG=1 (or NODE_ENV=test). High-volume
//   paths (entry/exit of execute(), classification branch chosen) emit at this
//   level so a normal production run stays quiet.
// - warn: always emitted. Reserved for failure paths where an operator should
//   have visibility (parse threw, classify threw, external call failed).
//
// Security: every call site MUST pass a structured second-arg whose keys are
// non-sensitive. Do not log API keys, tokens, raw provider error payloads
// that may include message contents, or full stdout/stderr (which may carry
// the assistant's working output). Use redaction helpers from
// `@paperclipai/adapter-utils/log-redaction` if a richer payload is needed.

const PREFIX = "[paperclip] opencode_local";
const DEBUG_ENV = "PAPERCLIP_OPENCODE_DEBUG";

function debugEnabled(): boolean {
  if (typeof process === "undefined") return false;
  if (process.env[DEBUG_ENV] === "1") return true;
  if (process.env[DEBUG_ENV] === "true") return true;
  if (process.env.NODE_ENV === "test") return true;
  return false;
}

function formatMessage(level: "debug" | "warn", scope: string, message: string): string {
  return `${PREFIX}:${level}${scope ? `:${scope}` : ""} ${message}`;
}

export interface OpenCodeAdapterLogger {
  debug(scope: string, message: string, meta?: Record<string, unknown>): void;
  warn(scope: string, message: string, meta?: Record<string, unknown>): void;
}

export const logger: OpenCodeAdapterLogger = {
  debug(scope, message, meta) {
    if (!debugEnabled()) return;
    // eslint-disable-next-line no-console
    console.warn(formatMessage("debug", scope, message), meta ?? {});
  },
  warn(scope, message, meta) {
    // eslint-disable-next-line no-console
    console.warn(formatMessage("warn", scope, message), meta ?? {});
  },
};
