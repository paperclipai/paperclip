import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "qwen_local";
export const label = "Qwen (local / vLLM)";

// Pinned to verified Alibaba release.
export const SANDBOX_INSTALL_COMMAND = "npm install -g @qwen-code/qwen-code@0.15.9";

export const DEFAULT_QWEN_LOCAL_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";

export function isValidQwenModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
}

export const models: Array<{ id: string; label: string }> = [
  { id: DEFAULT_QWEN_LOCAL_MODEL, label: "Qwen3.6 35B-A3B FP8 (default)" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# qwen_local agent configuration

Adapter: qwen_local

Use when:
- You serve a Qwen (or any OpenAI-compatible) model on a vLLM endpoint reachable from the Paperclip host (commonly DGX over Tailscale)
- You want Paperclip to drive the official \`@qwen-code/qwen-code\` CLI as the agent runtime
- You need tool-calling / multi-turn agent behavior, not just bare chat completions

Don't use when:
- The endpoint is not OpenAI-compatible (use a custom adapter)
- You only need one-shot HTTP chat (use the generic \`http\` adapter)
- The \`qwen\` CLI is not installed on the execution target (install: \`${"npm install -g @qwen-code/qwen-code@0.15.9"}\`)

Required fields:
- baseUrl (string): vLLM OpenAI-compatible endpoint, e.g. \`http://dgx:8000/v1\`
- apiKey (string): bearer token for the vLLM endpoint; use a stub like \`sk-local\` if vLLM is unauthenticated

Core fields:
- model (string, optional): served model id; defaults to \`Qwen/Qwen3.6-35B-A3B-FP8\`
- cwd (string, optional): default working directory for the agent process
- approvalMode (string, optional): qwen-code approval mode; defaults to \`yolo\` for unattended Paperclip runs
- command (string, optional): override the \`qwen\` binary path
- extraArgs (string[], optional): additional CLI args appended to every invocation

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = no timeout)
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Inference routes through env vars (\`OPENAI_BASE_URL\`, \`OPENAI_API_KEY\`, \`OPENAI_MODEL\`); the API key is never passed as a CLI flag, so it stays out of process listings.
- Runs use: \`qwen "<prompt>" -o stream-json --auth-type openai --include-partial-messages --bare --channel SDK -y -m <model>\`.
- Default concurrency limit is 20 in-flight runs per agent (Paperclip-wide setting).
- Phase 2 v0.1: session resume across heartbeats is not yet wired (planned for Phase 2.5).
`;
