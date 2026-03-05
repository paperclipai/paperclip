export const type = "gemini_local";
export const label = "Gemini CLI (local)";

export const models = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
  { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite Preview" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" }
];

export const agentConfigurationDoc = `# gemini_local agent configuration

Adapter: gemini_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- model (string, optional): Gemini model id
- yolo (boolean, optional): pass --yolo to auto-approve all tool calls
- sandbox (boolean, optional): pass --sandbox to run in Docker/Podman sandbox
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "gemini"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
