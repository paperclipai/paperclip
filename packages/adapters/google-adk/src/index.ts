export const type = "google_adk";
export const label = "Google ADK";
export const DEFAULT_GOOGLE_ADK_COMMAND = "adk";
export const DEFAULT_GOOGLE_ADK_MODEL = "";

export const models = [
  { id: "", label: "Agent-defined" },
  { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
  { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
  { id: "gemini-2.0-flash", label: "gemini-2.0-flash" },
];

export const agentConfigurationDoc = `# google_adk agent configuration

Adapter: google_adk

Use when:
- You already have an ADK agent and want Bizbox to invoke it directly through the ADK CLI
- You want a minimal Bizbox integration with one ADK path field plus normal local env overrides
- Your agent should keep its behavior in ADK code, not in Bizbox-specific adapter logic

Don't use when:
- You need webhook-style remote invocation (use http or openclaw_gateway)
- You want Bizbox to run a generic local coding CLI instead of an ADK agent project
- The ADK CLI is not installed on the Bizbox host

Core fields:
- agentPath (string, required): absolute path to the ADK agent entry. For Python this is usually the agent folder; for TypeScript it may be the agent file or project entry accepted by \`adk run\`
- instructionsFilePath (string, optional): absolute path to a markdown file prepended to the Bizbox wake prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): default model passed as \`--default_llm_model\` when the ADK agent does not set one explicitly
- command (string, optional): defaults to "adk"
- extraArgs (string[], optional): additional CLI args appended to \`adk run\`
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Bizbox invokes ADK with \`adk run --jsonl <agentPath> <query>\`.
- This adapter is intentionally thin: your agent logic, tools, and workflow stay in ADK.
- Bizbox keeps ADK session/artifact storage under the Bizbox home directory instead of writing into the agent project by default.
- Authentication usually comes from ADK-compatible environment variables such as \`GOOGLE_API_KEY\`, but ADK can also target other configured model backends depending on your agent/runtime setup.
`;
