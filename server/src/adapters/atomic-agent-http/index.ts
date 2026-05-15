import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const agentConfigurationDoc = `# atomic_agent_http

Paperclip → [atomic-agent](https://github.com/AtomicBot-ai/atomic-agent) via OpenAI-compatible \`POST /v1/chat/completions\` (one macro-turn per heartbeat).

## Prerequisites

1. Run llama.cpp \`llama-server\` (or \`atomic-agent models start\`).
2. Run \`atomic-agent serve --host 127.0.0.1 --port 8787 --cwd /path/to/work\` (add \`--api-key\` if you lock the HTTP API).

## adapterConfig

- **baseUrl** (string, required): e.g. \`http://127.0.0.1:8787\` (no trailing \`/v1\` required).
- **model** (string, optional): model id as reported by \`GET {baseUrl}/v1/models\`. If omitted, the adapter uses the first id returned by that endpoint when the heartbeat runs.
- **apiKey** (string, optional): Bearer token for \`atomic-agent serve\` when \`--api-key\` is set.
- **timeoutMs** (number, optional): HTTP timeout; default 600000 (10 minutes) because a single completion may include many tool steps.
- **maxTokens** (number, optional): maps to \`max_tokens\` on the chat request.
- **systemPromptAppend** (string, optional): extra system instructions after the default Paperclip operator preamble.

## Notes

- Approvals and browser tools run inside atomic-agent on the machine where \`serve\` listens, not inside Paperclip.
- Token/cost reporting follows \`usage\` from the chat completion when present; billing is treated as local (\`fixed\` / \`llama_local\`).
`;

export const atomicAgentHttpAdapter: ServerAdapterModule = {
  type: "atomic_agent_http",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc,
};
