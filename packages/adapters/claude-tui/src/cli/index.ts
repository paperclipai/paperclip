// claude-p output is byte-for-byte `claude -p` stream-json, so the CLI stream
// formatter is identical to claude_local.
export { printClaudeStreamEvent as printClaudeTuiStreamEvent } from "@paperclipai/adapter-claude-local/cli";
