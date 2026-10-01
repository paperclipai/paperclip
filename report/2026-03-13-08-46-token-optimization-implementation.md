# Token Optimization Implementation Report

Implemented the token-optimization plan across heartbeat orchestration, issue context APIs, adapter prompt construction, skill exposure, and agent configuration UX.

The main behavior changes are:

- Heartbeat telemetry now normalizes sessioned local adapter usage as per-run deltas instead of blindly trusting cumulative session totals.
- Timer and manual wakes now preserve task sessions by default; fresh sessions are forced only for explicit `forceFreshSession` wakes or new issue assignment wakes.
- Heartbeat session rotation is now policy-driven in the control plane, with a handoff note injected when a session is compacted and restarted.
- Paperclip issue context now has incremental APIs: `GET /api/agents/me/inbox-lite`, `GET /api/issues/:id/heartbeat-context`, and comment delta queries via `GET /api/issues/:id/comments?after=...&order=asc`.
- The `paperclip` skill now teaches agents to use those compact/incremental APIs first, while keeping full-thread fetches as a cold-start fallback.
- All local adapters now separate first-session bootstrap prompts from per-heartbeat prompt templates, and emit prompt size metrics in invocation metadata.
- Adapter create flows now persist `bootstrapPromptTemplate` correctly.
- The agent config UI now explains the difference between bootstrap prompts and heartbeat prompts and warns about prompt churn.
- Runtime skill defaults now include `paperclip`, `para-memory-files`, and `paperclip-create-agent`. `create-agent-adapter` was moved to `.agents/skills/create-agent-adapter`.

Important follow-up finding from real-run review:

- `codex_local` currently injects Paperclip skills into the shared Codex skills home (`$CODEX_HOME/skills` or `~/.codex/skills`) rather than mounting a worktree-local skill directory.
- If a Paperclip-owned skill symlink already points at another live checkout, the adapter currently skips it instead of repointing it.
- In practice, this means a worktree can contain newer `skills/paperclip/SKILL.md` guidance while Codex still follows an older checkout's skill content.
- That likely explains why PAP-507 still showed full issue/comment reload behavior even though the incremental context work was already implemented in this branch.
- This should be treated as a separate follow-up item for `codex_local` skill isolation or symlink repair.

Files with the most important implementation work:

- `server/src/services/heartbeat.ts`
- `server/src/services/issues.ts`
- `server/src/routes/issues.ts`
- `server/src/routes/agents.ts`
- `server/src/routes/access.ts`
- `skills/paperclip/SKILL.md`
- `packages/adapters/*/src/server/execute.ts`
- `packages/adapters/*/src/ui/build-config.ts`
- `ui/src/components/AgentConfigForm.tsx`

Verification completed successfully:

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

While verifying, I also fixed two existing embedded-postgres typing mismatches so repo-wide `typecheck` and `build` pass again:

- `packages/db/src/migration-runtime.ts`
- `cli/src/commands/worktree.ts`

Next useful follow-up is measuring the before/after effect in real runs now that telemetry is less misleading and prompt/session reuse behavior is consistent across adapters.
