export const type = "hermes_local";
export const label = "Hermes (local)";
export const DEFAULT_HERMES_LOCAL_MODEL = "gpt-5.4";

export const models = [
  { id: DEFAULT_HERMES_LOCAL_MODEL, label: DEFAULT_HERMES_LOCAL_MODEL },
];

export const agentConfigurationDoc = `# hermes_local agent configuration

Adapter: hermes_local

Use when:
- You want Paperclip to invoke the local Hermes CLI as an agent runtime.
- You want a Paperclip-managed Hermes employee on the same machine.

Core fields:
- cwd (string, optional): absolute working directory fallback for the Hermes process
- instructionsFilePath (string, optional): absolute path to markdown instructions prepended to the query prompt at runtime
- model (string, optional): Hermes chat model id (passed as -m)
- provider (string, optional): Hermes provider override (passed as --provider)
- promptTemplate (string, optional): run prompt template
- toolsets (string|string[], optional): Hermes toolsets passed as -t (comma-separated if array)
- command (string, optional): defaults to "hermes"
- extraArgs (string[], optional): additional Hermes CLI args injected before -q
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- verbose (boolean, optional): pass -v to Hermes

Notes:
- Paperclip auto-injects Paperclip skills into ~/.hermes/skills when missing.
- Session resume uses \
\`hermes --resume <sessionId>\` under the hood for long-lived agent continuity.
- Paperclip run auth is passed via PAPERCLIP_* environment variables, including PAPERCLIP_API_KEY for local JWTs.
`;
