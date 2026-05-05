export const type = "hermes_profile";
export const label = "Hermes Profile";

export const agentConfigurationDoc = `# hermes_profile agent configuration

Adapter: hermes_profile

Use when:
- You want employee Paperclip agents to run isolated in individual Hermes profiles
- You need profile-level skill isolation without sharing the root Hermes instance
- You want per-profile skill inventories (read-only from ~/.hermes/profiles/<profile>/skills)

Don't use when:
- You want the standard shared Hermes instance (use hermes_local)
- You need model selection or billing tracking (hermes_profile has no model config)

Core fields:
- profile (string, required): Hermes profile name (2-32 chars; lowercase letters, digits, underscores, hyphens; must be allowlisted)
- allowedProfiles (string[], optional): override the default profile allowlist; defaults to ["aster","cleo","devin","fiona","stella"]
- persistSession (boolean, optional): resume the last Hermes session across heartbeats; defaults to true
- cwd (string, optional): working directory for the profile wrapper; defaults to ~/.hermes/profiles/<profile>/workspace
- paperclipApiUrl (string, optional): override the Paperclip API URL injected as PAPERCLIP_API_URL

Prompt template fields:
- promptTemplate (string, optional): template for the run prompt; supports {{taskId}}, {{taskTitle}}, {{taskBody}}, {{commentId}}, {{agentName}}, {{profile}}, {{agentId}}, {{companyId}}, {{runId}}, {{paperclipApiUrl}}; also supports {{#taskId}}...{{/taskId}} and {{#noTask}}...{{/noTask}} conditional blocks

Toolset fields:
- toolsets (string, optional): comma-separated toolset names passed as -t to the profile wrapper
- enabledToolsets (string[], optional): array form; merged with toolsets if both present
- source (string, optional): --source flag passed to hermes; defaults to "paperclip"
- yolo (boolean, optional): pass --yolo to hermes; defaults to true
- quiet (boolean, optional): pass -Q (suppress hermes UI output) to hermes; defaults to true
- extraArgs (string[], optional): additional CLI args appended to the wrapper invocation

Operational fields:
- timeoutSec (number, optional): run timeout in seconds; 0 means no timeout (default)
- graceSec (number, optional): SIGTERM grace period before SIGKILL; defaults to 10
- env (object, optional): KEY=VALUE environment variables merged into the wrapper process env

Environment variables injected automatically:
- HERMES_PROFILE: the configured profile name
- PAPERCLIP_ADAPTER_TYPE: hermes_profile
- PAPERCLIP_RUN_ID, PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, PAPERCLIP_API_KEY
- PAPERCLIP_TASK_ID, PAPERCLIP_WAKE_REASON, PAPERCLIP_WAKE_COMMENT_ID, PAPERCLIP_LINKED_ISSUE_IDS

Notes:
- The profile wrapper must exist at ~/.hermes/profiles/<profile>/bin/hermes-profile-wrapper.sh
- Skills are discovered read-only from ~/.hermes/profiles/<profile>/skills/**/SKILL.md
- syncSkills is a no-op: profile-local skills are never mutated by Paperclip
- Session IDs are extracted from stdout (session_id: <id>) and persisted in sessionParams
`;
