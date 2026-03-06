export const type = "openclaw";
export const label = "OpenClaw";

// Static models for v1 — matches our OpenClaw agent config
export const models = [
  { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6 (via OpenClaw)" },
  { id: "openai-codex/gpt-5.4", label: "GPT 5.4 (via OpenClaw)" },
];

export const agentConfigurationDoc = `
# OpenClaw Adapter Configuration

Connect to an OpenClaw gateway to orchestrate AI agents.

## Configuration Fields

- **gatewayUrl** (string, required): WebSocket URL of the OpenClaw gateway. Default: \`ws://127.0.0.1:5555\`
- **agentId** (string, required): The agent identifier to use. Examples: "main", "researcher"
- **authToken** (string, optional): Authentication token for the gateway. Required for non-local deployments.
- **timeoutSec** (number, optional): Maximum execution time in seconds. Default: 120

## Example

\`\`\`json
{
  "gatewayUrl": "ws://127.0.0.1:5555",
  "agentId": "main",
  "timeoutSec": 120
}
\`\`\`
`;
