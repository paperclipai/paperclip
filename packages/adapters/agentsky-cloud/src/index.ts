import { renderAgentskyModelMatrix } from "./models.js";

export const type = "agentsky_cloud";
export const label = "AgentSky";

export const agentConfigurationDoc = `# agentsky_cloud agent configuration

Adapter: agentsky_cloud

Use when:
- You want Paperclip to drive a long-lived AgentSky cloud agent (agentsky.dev)
- You want a persistent remote agent with its own filesystem, memory, and context
- You want Paperclip to keep task state while AgentSky hosts the execution surface

Core fields:
- harness (string, optional, default "claude_code"): claude_code | codex | openclaw | hermes
- model (string, optional): must be compatible with the chosen harness; omit for the harness default:
${renderAgentskyModelMatrix()}
- agentSlug (string, optional): attach to a pre-existing AgentSky agent instead of auto-creating
  one; harness and model above are then ignored (the existing agent already has both)
- apiBaseUrl (string, optional, default "https://agentsky.dev"): override only for staging or
  self-hosted AgentSky
- instructionsFilePath (string, optional): agent instructions file prepended to the prompt
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): first-run-only bootstrap prompt template
- timeoutSec (number, optional, default 3600): max seconds to wait for the agent's turn
- env.AGENTSKY_API_TOKEN (string, required): AgentSky API token (ast_...)

Notes:
- There is no repoUrl: the AgentSky pod has a persistent filesystem. Name any repository the
  agent should work on directly in the prompt or goal text.
- The first heartbeat auto-creates an AgentSky agent + session with the configured harness/model
  and persists them; changing harness, model, or agentSlug provisions a fresh one.
- PAPERCLIP_* runtime values are delivered as a text note inside the wake prompt, not as
  environment variables in the agent's shell.
- The agent's final message each turn is the run report Paperclip records.
- Billing rides the AgentSky account's credits; an exhausted balance surfaces as a run failure
  with error code insufficient_credits.
`;
