export const type = "cursor_cloud";
export const label = "Cursor Cloud";

export const agentConfigurationDoc = `# cursor_cloud agent configuration

Adapter: cursor_cloud

Use when:
- You want Paperclip to run Cursor Cloud Agents through the official Cursor SDK
- You want durable remote Cursor agent sessions across Paperclip heartbeats
- You want Paperclip to keep task state while Cursor handles remote code execution

Core fields:
- repoUrl (string, required): Git repository URL Cursor should open
- repoStartingRef (string, optional): starting ref for the repo
- repoPullRequestUrl (string, optional): PR URL to attach the agent to
- runtimeEnvType (string, optional): cloud | pool | machine
- runtimeEnvName (string, optional): named cloud/pool/machine target
- workOnCurrentBranch (boolean, optional): continue work on current branch
- autoCreatePR (boolean, optional): let Cursor auto-create a PR
- skipReviewerRequest (boolean, optional): suppress reviewer request on auto-created PRs
- instructionsFilePath (string, optional): agent instructions file prepended to the prompt
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): first-run-only bootstrap prompt template
- model (string, optional): Cursor model id; omit to use the account default
- env.CURSOR_API_KEY (string, required): Cursor API key
- env.* (optional): additional env vars injected into the cloud agent shell

Notes:
- Paperclip reuses the durable Cursor agent across heartbeats when the repo/runtime identity still matches.
- Each Paperclip heartbeat maps to a Cursor run on that durable agent.
- Paperclip injects PAPERCLIP_* runtime env vars into the cloud agent shell through Cursor SDK cloud envVars.
- Paperclip remains the source of truth for issue/task state; Cursor provides the remote execution surface.
`;
