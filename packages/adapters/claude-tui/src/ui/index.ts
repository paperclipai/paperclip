// claude-p stdout is byte-for-byte `claude -p` stream-json, so the transcript
// parser is identical to claude_local.
export { parseClaudeStdoutLine as parseClaudeTuiStdoutLine } from "@paperclipai/adapter-claude-local/ui";
export { buildClaudeTuiConfig } from "./build-config.js";
