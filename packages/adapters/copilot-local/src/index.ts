export const type = "copilot_local";
export const label = "GitHub Copilot (local)";

export const DEFAULT_COPILOT_LOCAL_MODEL = "gpt-5.4";

// Fallback Copilot model catalog used when live SDK discovery is unavailable.
export const models: Array<{ id: string; label: string }> = [
  { id: "gpt-5.4", label: "gpt-5.4 (default)" },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { id: "gpt-5.2", label: "gpt-5.2" },
  { id: "gpt-5.2-codex", label: "gpt-5.2-codex" },
  { id: "gpt-5-mini", label: "gpt-5-mini" },
  { id: "gpt-4.1", label: "gpt-4.1" },
  { id: "claude-opus-4.7", label: "claude-opus-4.7" },
  { id: "claude-opus-4.6", label: "claude-opus-4.6" },
  { id: "claude-opus-4.5", label: "claude-opus-4.5" },
  { id: "claude-sonnet-4.6", label: "claude-sonnet-4.6" },
  { id: "claude-sonnet-4.5", label: "claude-sonnet-4.5" },
  { id: "claude-sonnet-4", label: "claude-sonnet-4" },
  { id: "claude-haiku-4.5", label: "claude-haiku-4.5" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

Use when:
- You want Paperclip to drive GitHub Copilot through the official \`@github/copilot-sdk\`
- You want session resume across heartbeats without shelling out to \`copilot -p\`
- You want SDK-backed model discovery with a static fallback catalog when discovery is unavailable

Don't use when:
- You need raw OpenAI/Anthropic API key billing (use codex_local or claude_local)
- You need provider/model routing or reasoning variants (use opencode_local)
- You need webhook / external invocation (use openclaw_gateway or http)

Core fields:
- cwd (string, optional): absolute working directory passed to the SDK session as \`workingDirectory\`
- model (string, optional): Copilot model id; defaults to ${DEFAULT_COPILOT_LOCAL_MODEL} when omitted
- promptTemplate (string, optional): heartbeat prompt template; default mirrors other adapters
- bootstrapPromptTemplate (string, optional): prepended on the first run only
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to every prompt
- command (string, optional): CLI executable override for the SDK; when omitted, the SDK uses its bundled Copilot CLI
- extraArgs (string[], optional): additional CLI args inserted before SDK-managed flags
- env (object, optional): environment variables or Paperclip secret refs (for example GH_TOKEN or GITHUB_TOKEN)
- timeoutSec (number, optional): run timeout in seconds (0 = no timeout)
- graceSec (number, optional): retained for config compatibility; ignored by SDK-backed runs

Notes:
- Paperclip starts a Copilot SDK client per run and uses \`createSession()\` / \`resumeSession()\` for execution.
- Sessions are resumed only when the stored session cwd matches the current cwd.
- Paperclip runtime skills are exposed through the SDK \`skillDirectories\` setting using a temporary skill bundle.
- Usage, premium requests, and code change metrics come from SDK session events (\`assistant.usage\` and \`session.shutdown\`).
`;
