import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "jcode_local";
export const label = "JCode";

export const SANDBOX_INSTALL_COMMAND = `set -euo pipefail
if command -v brew >/dev/null 2>&1; then
  brew tap 1jehuang/jcode
  brew install jcode
else
  tmpdir="$(mktemp -d)"
  git clone --depth 1 https://github.com/1jehuang/jcode.git "$tmpdir/jcode"
  cd "$tmpdir/jcode"
  cargo build --release
  scripts/install_release.sh
fi`;

export const models: Array<{ id: string; label: string }> = [];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# jcode_local agent configuration

Adapter: jcode_local

Use when:
- You want Paperclip to run jcode (the high-performance Rust coding agent) locally as the agent runtime
- You want multi-provider support (Claude, OpenAI, Gemini, Copilot, etc.) through jcode's OAuth/login system
- You want jcode session resume across heartbeats via --resume
- You want jcode's memory, swarm, and browser automation features

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- jcode CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected into the system prompt
- promptTemplate (string, optional): user prompt template passed to jcode run
- model (string, optional): model id to use with jcode (passed via --model)
- command (string, optional): defaults to "jcode"
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- jcode supports many providers via OAuth and API keys. Use \`jcode login --provider <name>\` to configure.
- jcode reads MCP config from .mcp.json and ~/.claude.json (Claude Code compatible).
- jcode sessions support --resume for continuation across heartbeats.
- Output is parsed from jcode's --ndjson streaming format.
- jcode is built in Rust and has significantly lower memory usage than Node.js-based agents.
`;
