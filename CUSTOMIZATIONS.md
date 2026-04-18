# Paperclip Local Customizations

Our fork carries 21 commits beyond upstream. Each is load-bearing; losing any could silently break a production feature. This file is the single source of truth for what we patch and why.

**Branch:** `freemymemories/local-customizations`
**Upstream:** `origin/master`
**Regenerate:** `git log --pretty="%H %s" origin/master..HEAD`
**Last verified:** 2026-04-17 (Phase G)

## LaunchAgent startup guards

The LaunchAgent plist at `~/Library/LaunchAgents/com.openclaw.paperclip.plist` runs canary checks before starting Paperclip. If any guarded patch is missing, the server refuses to boot. Currently guarded (7 checks):

| Guard | Patch commit | File | Marker |
|---|---|---|---|
| wakeOnComment | e855c890 | server/src/services/heartbeat.ts | `wakeOnComment` |
| supportsLocalAgentJwt | 4ac66f9d | server/src/adapters/registry.ts | `supportsLocalAgentJwt: true` |
| activity.logged emit | d5573660 | server/src/services/activity-log.ts | `eventType: "activity.logged"` |
| pluginDbId signature | 9527fa37 | server/src/services/plugin-tool-dispatcher.ts | `pluginDbId?: string` |
| dev-runner-paths exists | 6fb9f642 | scripts/dev-runner-paths.mjs | (file presence) |
| heartbeat plugin-event emit | 0a301e37, f4eeeaa8 | server/src/services/heartbeat.ts | `emitRunStatusPluginEvent` |
| plugin-registry scope filter | SCOPE_FILTER_PATCH_V1 | server/src/services/plugin-registry.ts | `SCOPE_FILTER_PATCH_V1` |

Post-rebase: verify every row in the tables below is still present. Patches marked HIGH reversion risk MUST be re-guarded in the plist before Paperclip is started.

## Patches by subsystem

### Heartbeat & Wake Control

| Hash | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| e855c890 | add runtimeConfig.heartbeat.wakeOnComment | server/src/services/heartbeat.ts | Stops unconditional assignee wake on every comment; reviewers can approve without burning a full adapter session on the submitter | HIGH | Candidate for upstream PR |
| 71c41b0d | wake dedup window default 120s → 30s (FRE-207) | server/src/services/heartbeat.ts (dedup window) | Restores intended dedup default; 120s default causes 60s-seeded test cases to coalesce incorrectly and delays legitimate back-to-back wakes in production | MEDIUM | Likely upstream bug; PR candidate |
| c84e0aec | wake template differentiates assignment vs mention | server/src/services/heartbeat.ts (wake template) | Without this, mention wakes on in_review/in_progress issues always fail the hardcoded todo/backlog/blocked checkout gate and agents reject legitimate mention work requests | HIGH | Candidate for upstream PR |
| 69512e21 | forcefully adopt zombie checkout locks when run terminal | server/src/routes/issues.ts | Without this, zombie checkoutRunIds silently block all new wakes on an issue even when assignee changes — manifests as "agent never wakes" | HIGH | Candidate for upstream PR |

### Governance & Security

| Hash | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| d5f37c1e | block non-owner agents from changing assigneeAgentId (FRE-202) | server/src/routes/issues.ts | Without this, stale deferred agent runs with tasks:assign permission can override CEO reassignments at any time — broken governance model | HIGH | Candidate for upstream PR |
| 1c87432c | add tasks:reassign_any permission for pipeline managers | server/src/constants/permissions.ts, server/src/routes/agents.ts, server/src/routes/issues.ts | EM and CTO can reassign issues they don't own, enabling real pipeline management without CEO intervention | MEDIUM | Candidate for upstream PR |
| dcdb5793 | expose can-reassign-any toggle in agent config UI | web/src/components/agents/*.tsx, server API type | UI surface for the above permission; without it the permission can only be set via raw API | LOW | Upstream with 1c87432c |
| 7d7300fe | allow CEO-role + canCreateAgents to manage cross-agent routines (#2) | server/src/routes/routines.ts | Mirrors trust model from issues/agents; without it non-self routine management 403s even for CEO | MEDIUM | Candidate for upstream PR |
| 9afecd90 | always use agent_home workspace — disable project workspace override | server (run workspace resolver) | Prevents agents loading wrong identity files on cross-agent issues. Without this, an agent woken on an issue from another project boots inside that project's workspace directory with the wrong CLAUDE.md/SOUL.md | HIGH | Local policy, not upstreamable |

### Agent Adapters

| Hash | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| 4ac66f9d | restore supportsLocalAgentJwt for openclaw_gateway + session key prefix | server/src/adapters/registry.ts, session key resolver | Without this, agents cannot authenticate with Paperclip API — no per-run key file is generated. Regressed twice from upstream merges | HIGH | Not upstreamable (local gateway identity) |
| 0a87720c | write JWT to per-run key file instead of inlining in wake text | server (gateway wake text builder) | MiniMax M2.7 deterministically mutates two chars of inlined JWT (Z→Y, b→B at positions 205/217); every API call 401s. Fix writes JWT to ~/.openclaw/runs/{runId}.key and wake uses shell expansion | HIGH | Not upstreamable (model-specific workaround) |
| fcc9c25f | load workspace-local skills via --add-dir | server/src/adapters/claude-code (or similar) | Agents have workspace-specific skills in `<workspace>/skills/`; without this the adapter only adds Paperclip's global skills dir and workspace skills are invisible | HIGH | Candidate for upstream PR |
| 068705cf | add third-party model support (MiniMax M2.7) | server/src/adapters/claude-code (PROVIDER_ENDPOINTS, isThirdPartyModel, resolveProviderLabel), execute.ts | Infrastructure for non-Anthropic models via Claude Code adapter with provider routing and cost tracking | HIGH | Candidate for upstream PR (generalized) |
| d93f1efb | load workspace CLAUDE.md via --setting-sources | server/src/adapters/claude-code | SDK mode (--print -) loads no filesystem settings by default; without this workspace .claude/CLAUDE.md is ignored and all workspace file loading (SOUL/HEARTBEAT/TOOLS/etc.) breaks | HIGH | Candidate for upstream PR |

### Plugin & Orchestration

| Hash | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| 9527fa37 | plugin tool dispatch + install-retry fixes | server/src/routes/plugins.ts, server/src/services/plugin-loader.ts, server/src/services/plugin-tool-dispatcher.ts | Without this, every plugin-contributed tool invocation returns 502 "worker not running" because the registry's workerManager.isRunning lookup is keyed by manifest string id instead of DB UUID | HIGH | Not upstreamable (local dev-mode fix) |
| d5573660 | emit activity.logged for every activity_log row | server/src/services/activity-log.ts | Prior emit was gated on PLUGIN_EVENT_SET.has(input.action); no caller passes action="activity.logged" so the event was never emitted. Plugins subscribing to activity.logged (e.g. paperclip-chief-of-staff) received nothing | HIGH | Candidate for upstream PR |
| 0a301e37 | emit agent.run.* plugin events on run status transitions (#3) | server/src/services/heartbeat.ts, server/src/services/plugin-event-bus.ts | Wires setHeartbeatPluginEventBus + emitRunStatusPluginEvent; setRunStatus() now forwards started/finished/failed/cancelled transitions to the plugin event bus. Without this, plugins subscribed to agent.run.* lifecycle events never fire (Chief of Staff, orchestrators) | HIGH | Candidate for upstream PR |
| f4eeeaa8 | also emit agent.run.started at the claim site (#5) | server/src/services/heartbeat.ts | queued → running claim-site uses a direct db.update bypassing setRunStatus(); without this follow-up emit, plugins only ever see terminal transitions (finished/failed/cancelled) and miss started events entirely | HIGH | Candidate for upstream PR (with 0a301e37) |
| SCOPE_FILTER_PATCH_V1 | honor scopeKind + scopeId in plugin-registry.listEntities | server/src/services/plugin-registry.ts | Pre-patch, listEntities silently dropped the SDK's `scopeKind`/`scopeId` filters — only `pluginId`/`entityType`/`externalId` were applied. Every plugin tool that stored entities under a run/issue/project scope was leaking cross-scope data (e.g. `cos_dismiss_prefinding` would accept any `runId` and still dismiss). Patch adds conditional composition of `eq(scope_kind, …)` / `eq(scope_id, …)` plus query-time validation. Guarded by marker `SCOPE_FILTER_PATCH_V1` | HIGH | Candidate for upstream PR |

### CI & Dev Experience

| Hash | Subject | Files | Purpose | Reversion risk | Upstream outlook |
|---|---|---|---|---|---|
| dd91289a | fail build if uncommitted changes in PR branch | .github/workflows/pr.yml, .github/workflows/pr-policy.yml | Catches agents ending sessions with uncommitted worktree contamination before merge (FRE-981 systemic) | MEDIUM | Candidate for upstream PR |
| 6fb9f642 | dev-runner ignore iCloud + macOS metadata | scripts/dev-runner-paths.mjs | Source tree lives in iCloud Drive; iCloud/macOS metadata touches (.DS_Store, *.icloud, ._*, .Spotlight-*) caused tsx watch to restart every few minutes and 502 in-flight requests | MEDIUM | Not upstreamable (iCloud-specific) |

### UI

See Governance & Security — `dcdb5793` is the only UI-touching patch and lives with its backing permission commit.

## Dependencies (non-git-commit patches)

- `patches/embedded-postgres@18.1.0-beta.16.patch` — npm dependency patch (LC_MESSAGES locale fix). Applied via pnpm patch mechanism.

## Rebase procedure

1. Checklist against every table row above post-rebase.
2. Re-run LaunchAgent guard test: `launchctl unload ~/Library/LaunchAgents/com.openclaw.paperclip.plist; launchctl load ~/Library/LaunchAgents/com.openclaw.paperclip.plist; sleep 5; ps aux | grep '[p]aperclip'` — expect running server.
3. Deliberately revert one guarded patch in a scratch branch; confirm LaunchAgent refuses to start (check stderr log); restore.
4. Verify the guard table in the plist matches the LaunchAgent guards section above; add guards for any new HIGH-reversion-risk patches.
