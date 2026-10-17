export const type = "qoder_cloud_agents";
export const label = "Qoder Cloud Agents";

export const DEFAULT_QODER_API_BASE_URL = "https://api.qoder.com";
export const DEFAULT_QODER_CLOUD_AGENTS_MODEL = "ultimate";

export const agentConfigurationDoc = `# qoder_cloud_agents agent configuration

Adapter: qoder_cloud_agents

Use when:
- You want Paperclip to run Qoder Cloud Agents through the Qoder Managed API
- You want durable remote Qoder sessions across Paperclip heartbeats
- You want Paperclip to keep task state while Qoder handles remote code execution

Core fields:
- apiBaseUrl (string, optional): Qoder API base URL; defaults to ${DEFAULT_QODER_API_BASE_URL} (China region: https://api.qoder.com.cn)
- qoderAgentId (string, optional): existing Qoder agent ID (agent_...); omit to let Paperclip create and reuse a managed Qoder agent
- environmentId (string, optional): Qoder environment ID (env_...); omit to use the account's first Qoder-hosted (cloud) environment, creating "default" when none exists
- repoUrl (string, optional): Git repository URL Qoder should clone into the session
- repoStartingRef (string, optional): branch Qoder should check out
- repoMountPath (string, optional): clone path inside the container; defaults to /data/workspace/<repo>
- timeoutSec (number, optional): cancel the Qoder turn after this many seconds; 0 disables the limit
- instructionsFilePath (string, optional): agent instructions file prepended to the prompt
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): first-run-only bootstrap prompt template
- model (string, optional): Qoder model id for the managed agent; defaults to ${DEFAULT_QODER_CLOUD_AGENTS_MODEL}. Ignored when qoderAgentId is set
- env.QODER_ACCESS_TOKEN (string, required): Qoder personal access token (PAT) or service account token (SAT)
- env.QODER_REPO_TOKEN (string, optional): token Qoder uses to clone or push the repository
- env.* (optional): additional env vars injected into the Qoder session

Notes:
- Paperclip reuses the Qoder session across heartbeats while the agent, environment, repository and env vars still match.
- Each Paperclip heartbeat maps to one user.message turn on that session.
- Qoder fixes session env vars at session creation, so run-scoped values (PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID, ...) travel in the prompt instead of the shell environment.
- The managed Qoder agent allows every built-in tool. A turn that stops for tool confirmation is cancelled and reported as a failed run.
- Qoder container storage is temporary; the agent must commit and push work it needs to keep.
- Paperclip remains the source of truth for issue/task state; Qoder provides the remote execution surface.
`;
