export const type = "local";
export const label = "Local OpenAI-compatible";
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:1234/v1";
export const DEFAULT_LOCAL_MODEL = "qwen/qwen3-coder-30b";

export const models = [
  { id: DEFAULT_LOCAL_MODEL, label: "Qwen3 Coder 30B" },
];

export const agentConfigurationDoc = `# local agent configuration

Adapter: local

Core fields:
- model (string, required): OpenAI-compatible chat model id
- baseUrl (string, optional): OpenAI-compatible base URL; defaults to http://localhost:1234/v1
- apiKey (string, optional): bearer token for the local endpoint when required
- maxTurns (number, optional): passed through to the claude_local fallback as maxTurnsPerRun
- instructionsFilePath (string, required): absolute path to a markdown instructions file injected at runtime
- promptTemplate (string, optional): run prompt template

Operational fields:
- timeoutSec (number, optional): request timeout in seconds

Notes:
- Paperclip sends one /chat/completions request per heartbeat.
- When local inference is unavailable, Paperclip transparently runs the heartbeat through claude_local with the same instructionsFilePath and maxTurns.
`;
