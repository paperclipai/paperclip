export const type = "lm_studio_local";
export const label = "LM Studio (local)";
export const DEFAULT_LM_STUDIO_BASE_URL = "http://localhost:1234";
export const DEFAULT_LM_STUDIO_API_KEY = "lm-studio";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# lm_studio_local agent configuration

Adapter: lm_studio_local

Runs the Codex CLI pointed at a local LM Studio server via OPENAI_BASE_URL.

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to stdin prompt at runtime
- model (string, required): LM Studio model id (discovered from LM Studio /v1/models endpoint)
- baseUrl (string, optional): LM Studio server URL (default: http://localhost:1234)
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "codex"
- extraArgs (string[], optional): additional CLI args

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- LM Studio provides an OpenAI-compatible API; the Codex binary is used as the underlying runner.
- OPENAI_BASE_URL is set to <baseUrl>/v1 and OPENAI_API_KEY to a placeholder value.
- Model names come from LM Studio's /v1/models endpoint (the id field).
`;
