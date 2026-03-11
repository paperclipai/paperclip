export const type = "acpx_sidecar";
export const label = "ACPX Sidecar";

export const models = [
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro High" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "gpt-4", label: "GPT-4" },
];

export const agentConfigurationDoc = `# acpx_sidecar agent configuration

Adapter: acpx_sidecar

This adapter sends Paperclip heartbeats to an external sidecar service that shells out to \`acpx\`.
The sidecar, not the main Paperclip container, owns the official CLI runtime and session state.

Core fields:
- url (string, required): sidecar base URL (for example http://sidecar-gemini-shared:8730)
- agentCommand (string, optional): ACPX runtime name (for example gemini, claude, codex, openclaw)
- customAgentCommand (string, optional): raw ACP server command passed via \`acpx --agent\`; use this for custom ACP shims such as DeerFlow
- cwd (string, optional): sidecar-local working directory for session scoping
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): model/config value applied with \`acpx <agent> set model <value>\`
- sessionNameTemplate (string, optional): template for ACPX session name, defaults to paperclip-{{agent.id}}-{{runtime.taskKey}}
- headers (object, optional): extra HTTP headers sent to the sidecar
- extraArgs (string[], optional): additional ACPX flags inserted before the runtime command
- timeoutSec (number, optional): prompt timeout in seconds

Notes:
- Paperclip keeps only lightweight adapter session metadata; ACPX keeps runtime sessions in the sidecar container.
- The sidecar should expose \`GET /health\`, \`GET /status\`, and \`POST /run\`.
- \`POST /run\` should support JSON with \`args\`, optional \`stdin\`, optional \`cwd\`, and optional \`timeout\`.
- When \`customAgentCommand\` is set, the adapter invokes \`acpx --agent "<command>" ...\` and does not require \`agentCommand\`.
- This is intended for dedicated runtime containers so official CLIs do not run in the main Paperclip container.`;
