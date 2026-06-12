export const type = "minimax_local";
export const label = "MiniMax Local";
export const DEFAULT_MINIMAX_LOCAL_MODEL = "MiniMax-M3";
export const DEFAULT_MINIMAX_LOCAL_BASE_URL = "https://api.minimax.io/v1";
export const DEFAULT_MINIMAX_LOCAL_TEMPERATURE = 0.2;
export const DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS = 2048;
export const DEFAULT_MINIMAX_LOCAL_STRIP_THINK = true;
export const DEFAULT_MINIMAX_SECRET_ID = "0a43cc1f-41ff-414b-b2b5-1ac3d3064ec9";

export const models = [
  { id: "MiniMax-M3", label: "MiniMax-M3" },
  { id: "MiniMax-M2.7", label: "MiniMax-M2.7" },
  { id: "MiniMax-M2.7-highspeed", label: "MiniMax-M2.7-highspeed" },
];

export const agentConfigurationDoc = `# minimax_local agent configuration

Adapter: minimax_local

Use when:
- You want Paperclip to call the MiniMax OpenAI-compatible API directly
- You want a first-class MiniMax adapter instead of routing through OpenCode
- You need a lightweight heartbeat adapter that renders prompt context server-side

Don't use when:
- You need a local coding-agent CLI with interactive tool execution
- You need webhook-style external invocation (use http or openclaw_gateway)

Core fields:
- model (string, optional): defaults to MiniMax-M3
- primaryModel (string, optional): defaults to model
- baseUrl (string, optional): defaults to https://api.minimax.io/v1
- temperature (number, optional): defaults to 0.2
- max_completion_tokens or maxTokens (number, optional): defaults to 2048
- stripThink (boolean, optional): defaults to true
- cwd / workingDirectory (string, optional): working-directory context used for prompt rendering and instructions resolution
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- promptTemplate (string, optional): heartbeat prompt template
- env.MINIMAX_API_KEY (string or secret ref, recommended): MiniMax API key
- env.MINIMAX_API_KEY_FILE (string, optional): file path fallback containing the API key

Notes:
- The adapter calls POST /chat/completions on the configured MiniMax base URL.
- By default, <think>...</think> blocks are removed from the final assistant text before Paperclip stores the result.
- Environment tests run a tiny "Reply with exactly: OK" completion and never echo secret values.
`;
