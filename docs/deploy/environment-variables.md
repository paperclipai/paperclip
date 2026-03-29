---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration or injects into Paperclip-managed agent processes.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `HOST` | `127.0.0.1` | Server host binding |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

For Paperclip-managed local agent processes, the server injects a core runtime env on every heartbeat. Wake-specific and workspace-specific vars are conditional: if the current run does not carry that context, Paperclip omits the variable instead of setting a placeholder value.

### Core Runtime Context

| Variable | When Present | Description |
|----------|--------------|-------------|
| `PAPERCLIP_AGENT_ID` | Always on Paperclip-managed local process runs | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Always on Paperclip-managed local process runs | Company ID |
| `PAPERCLIP_API_URL` | Always on Paperclip-managed local process runs | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | Always on Paperclip-managed local process runs | Short-lived JWT the agent can use for API auth during this run |
| `PAPERCLIP_RUN_ID` | Always on Paperclip-managed local process runs | Current heartbeat run ID |

### Wake Context

| Variable | When Present | Description |
|----------|--------------|-------------|
| `PAPERCLIP_TASK_ID` | When the wake is associated with a task/issue | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | When the wake has an explicit trigger reason | Wake trigger reason (for example `issue_assigned` or `issue_comment_mentioned`) |
| `PAPERCLIP_WAKE_COMMENT_ID` | When a specific issue comment triggered the wake | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | When the wake was triggered by an approval resolution | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | When the wake was triggered by an approval resolution | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | When the wake carries linked-issue context | Comma-separated linked issue IDs |

### Workspace Context

These vars are present only when Paperclip resolved a workspace for the run. `PAPERCLIP_WORKSPACE_CWD` is the safest field to use for the current working directory; the remaining fields are workspace metadata and git-provenance hints that may be absent when Paperclip cannot determine them.

| Variable | When Present | Description |
|----------|--------------|-------------|
| `PAPERCLIP_WORKSPACE_CWD` | When Paperclip resolved a workspace or workspace fallback for the process | The working directory selected for the agent process |
| `PAPERCLIP_WORKSPACE_SOURCE` | When Paperclip resolved a workspace | Why that workspace was selected; current values include `project_primary`, `task_session`, and `agent_home` |
| `PAPERCLIP_WORKSPACE_STRATEGY` | When Paperclip resolved a workspace with a known realization strategy | How Paperclip realized the workspace, such as `project_primary` or `git_worktree` |
| `PAPERCLIP_WORKSPACE_ID` | When the resolved workspace maps to a tracked Paperclip workspace record | Stable Paperclip workspace ID |
| `PAPERCLIP_WORKSPACE_REPO_URL` | When the workspace has repo metadata | Repo remote URL associated with the active workspace |
| `PAPERCLIP_WORKSPACE_REPO_REF` | When the workspace has a known repo/base ref | Repo ref Paperclip used while resolving the workspace |
| `PAPERCLIP_WORKSPACE_BRANCH` | When the workspace is associated with a branch-backed checkout | Intended branch for the active workspace |
| `PAPERCLIP_WORKSPACE_OBSERVED_BRANCH` | When Paperclip can inspect the checkout before launch | Branch actually observed in the checkout at process start |
| `PAPERCLIP_WORKSPACE_OBSERVED_HEAD` | When Paperclip can inspect the checkout before launch | HEAD commit actually observed in the checkout at process start |
| `PAPERCLIP_WORKSPACE_WORKTREE_PATH` | When Paperclip knows the realized worktree/root path | Root path of the realized workspace checkout; this may differ from `PAPERCLIP_WORKSPACE_CWD` if the process runs in a nested directory |
| `PAPERCLIP_WORKSPACES_JSON` | When the adapter receives one or more workspace hints | JSON array of resolved/available workspace hints for the run; useful for debugging workspace routing or multi-workspace setups |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |
