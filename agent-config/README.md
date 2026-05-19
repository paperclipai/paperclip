# agent-config

Version-controlled source of truth for Allkey agent instruction bundles
(`AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `TOOLS.md`, `GIT-WORKFLOW.md`).

- **Edit + commit** files under `companies/{companyId}/agents/{agentId}/instructions/`.
- **Sync** to live agents with `pwsh ./sync.ps1 -Pull` (or `./sync.sh --pull`).
- See [UPDATE-INSTRUCTIONS.md](./UPDATE-INSTRUCTIONS.md) for the full workflow.

Commits go to `assaph3004/paperclip` only. No PRs to any paperclip repo.
