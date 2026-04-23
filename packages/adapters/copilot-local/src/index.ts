export const type = "copilot_local";
export const label = "GitHub Copilot (local)";

export const models: Array<{ id: string; label: string }> = [
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6 (via Copilot)" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6 (via Copilot)" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5 (via Copilot)" },
  { id: "gpt-5.4", label: "GPT-5.4 (via Copilot)" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini (via Copilot)" },
  { id: "gpt-5.2", label: "GPT-5.2 (via Copilot)" },
  { id: "gpt-5-mini", label: "GPT-5 Mini (via Copilot)" },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex (via Copilot)" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex (via Copilot)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (via Copilot)" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

## Prerequisites
- GitHub Copilot CLI installed: \`npm install -g @github/copilot\` (Node 22+)
- Active Copilot subscription (Pro+, Business, Enterprise) — or BYOK configuration
- Authenticated: \`copilot login\` (or \`copilot login --host <ghe-hostname>\` for GHE)

## Config Fields
- **model** — Copilot model to use (e.g. claude-sonnet-4.6, gpt-5.4)
- **cwd** — Working directory for the agent
- **command** — CLI binary name (default: "copilot")
- **gheHost** — GitHub Enterprise hostname (e.g. "mycompany.ghe.com")
- **effort** — Reasoning effort: low, medium, high (default: medium)
- **dangerouslySkipPermissions** (boolean, optional, default true) — pass --allow-all-tools to Copilot CLI; defaults to true because Paperclip runs Copilot in headless -s mode where interactive permission prompts cannot be answered. Set to false to restrict Copilot to its default toolset
- **isolateSession** — If true, starts a fresh session each run (no --resume)
- **byokBaseUrl** — BYOK: Custom OpenAI-compatible endpoint URL
- **byokApiKey** — BYOK: API key for custom endpoint

## Environment Variables
- \`COPILOT_GITHUB_TOKEN\` — Override GitHub token for Copilot auth
- \`COPILOT_PROVIDER_BASE_URL\` — BYOK endpoint (set via byokBaseUrl config)
- \`COPILOT_PROVIDER_API_KEY\` — BYOK API key (set via byokApiKey config)
- \`COPILOT_OFFLINE\` — Set to "true" for air-gapped mode
- \`GH_HOST\` — GitHub Enterprise hostname override
`;
