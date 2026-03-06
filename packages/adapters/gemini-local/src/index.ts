export const type = "gemini_local";
export const label = "Gemini (local)";
export const DEFAULT_GEMINI_LOCAL_MODEL = "gemini-2.5-pro";
export const DEFAULT_GEMINI_LOCAL_APPROVAL_MODE = "yolo";

export const models = [
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
];

export const agentConfigurationDoc = `# gemini_local agent configuration

Adapter: gemini_local

Core fields:
- cwd (string, optional): default absolute working directory for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- model (string, optional): Gemini model id (default: gemini-2.5-pro)
- promptTemplate (string, optional): run prompt template
- approvalMode (string, optional): "default", "auto_edit", or "yolo" (default: yolo)
- sandbox (boolean, optional): run in sandbox mode
- command (string, optional): defaults to "gemini"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Prompts are piped via stdin.
- Gemini outputs structured JSON via --output-format stream-json for real-time streaming.
- Session resume is supported via --resume with the session ID.
- GEMINI_API_KEY or Google OAuth login must be configured for authentication.
`;
