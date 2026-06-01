export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";

// claude-p emits byte-for-byte `claude -p` stream-json, so the session codec
// and parse helpers are identical to claude_local. Re-export them so the host
// registry can wire claude_tui without depending on claude_local directly.
export {
  sessionCodec,
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "@paperclipai/adapter-claude-local/server";
