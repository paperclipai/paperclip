# Agent Runtime Noise Reduction Roadmap

## Problem

Local-agent runs succeed but waste significant money and produce unnecessary noise:

- Idle agents with no assigned work still spawn, bootstrap, and burn tokens (Issue #373)
- Codex agents bill against the ChatGPT subscription quota instead of the OpenAI API, causing rate-limit resets
- Paperclip records `$0.00` cost for all Codex runs — budget enforcement and dashboards are blind to actual spend
- MCP auth noise from personal CLI config leaks into agent runs (`rmcp::transport::worker ... invalid_token`)
- Large stale Codex sessions are resumed on every timer wake, dragging in massive context with no benefit
- Missing `AGENT_HOME` causes agents to waste their first commands recovering missing paths
- Benign stderr warnings are visually indistinguishable from real failures in the run log

## Goals

1. Stop idle agents from spawning when there is no actionable work.
2. Route Codex billing to the OpenAI API (pay-per-token) instead of the subscription plan.
3. Track Codex spend inside Paperclip the same way Claude spend is tracked today.
4. Isolate agent runs from the operator's personal CLI environment.
5. Inject required env vars (`AGENT_HOME`, etc.) consistently.
6. Reduce stale session resume on low-value timer wakes.
7. Separate benign warnings from real failures in logs and UI.

## Non-Goals

- Redesigning the agent model or heartbeat product.
- Replacing Codex/Claude CLIs with a different runtime.
- Hiding real execution failures from operators.
- Large UI redesign work.

## Related PRs & Issues

| # | Title | Relation |
|---|-------|----------|
| [#373](https://github.com/paperclipai/paperclip/issues/373) | Idle agents consuming tokens with nothing to do | Core motivation for Phase 4 pre-flight guard |
| [#385](https://github.com/paperclipai/paperclip/pull/385) | Model-based token pricing for cost calculation | Directly implements Phase 7 cost estimation; Phase 7 should build on this, not duplicate it |
| [#386](https://github.com/paperclipai/paperclip/pull/386) | Route heartbeat cost recording through costService | **Blocker for Phase 7** — without this, company budget and agent auto-pause never trigger |
| [#255](https://github.com/paperclipai/paperclip/pull/255) | Spend & quota dashboard — provider breakdown, rolling windows | Implements Phase 7 UI deliverable; covers Anthropic vs OpenAI split |
| [#179](https://github.com/paperclipai/paperclip/pull/179) | Worktree cleanup lifecycle on session clear | Adjacent to Phase 3; stale worktrees from cleared sessions should be cleaned consistently |
| [#366](https://github.com/paperclipai/paperclip/pull/366) | Windows UTF-8 encoding and cross-platform compatibility | Hard constraint — runtime changes must not regress cross-platform spawn behavior |
| [#390](https://github.com/paperclipai/paperclip/issues/390) | Agent circuit breaker — loop detection and token waste prevention | Complementary; this roadmap reduces noise so the breaker signal is trustworthy |
| [#399](https://github.com/paperclipai/paperclip/pull/399) | General action approvals with adapter-level context injection | Sets the pattern for standardized env/context injection to reuse in Phases 1–2 |

---

## Architecture

### Agent Runtime — Unified Folder Structure

Every agent has a single home directory (`AGENT_HOME`) that holds both its instruction files (git-tracked) and its runtime artifacts (gitignored, S3-backed).

```
agents/                          ← host: git repo (public fork, generic)
└── <slug>/                      ← AGENT_HOME (mounted into container)
    ├── AGENTS.md                ← role instructions          [git-tracked]
    ├── HEARTBEAT.md             ← execution checklist        [git-tracked]
    ├── SOUL.md                  ← persona / values           [git-tracked]
    ├── TOOLS.md                 ← tools reference            [git-tracked]
    ├── memory/                  ← daily notes, timeline      [gitignored, S3-backed]
    ├── notes/                   ← scratch notes              [gitignored, S3-backed]
    ├── plans/                   ← active plans               [gitignored, S3-backed]
    ├── life/                    ← CEO PARA knowledge graph   [gitignored, S3-backed]
    ├── logs/                    ← execution logs             [gitignored, S3-backed]
    └── .codex/                  ← Codex CLI config isolation [gitignored, S3-backed]
```

Container volume mounts:
```
Host path                             Container path          Purpose
─────────────────────────────────────────────────────────────────────────────
./agents/                        →  /paperclip-agents/       instruction files (R/W)
~/.paperclip/                    →  /paperclip/              DB + Paperclip data
$CALENBOOK_DIR/                  →  /workspace/calenbook/    agent working directory
```

---

### S3 Sync — Bidirectional Lifecycle

Private, operator-specific data (agent configs + runtime files) live in S3. The public repo stays generic.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  S3 Bucket: paperclip-agent-runtime                                     │
│  Key prefix: agent-runtime/<instanceId>/<slug>/<...files>               │
│                                                                         │
│  ┌──────────────────────┐     ┌──────────────────────────────────────┐  │
│  │  ceo/memory/         │     │  principal-architect/plans/          │  │
│  │  ceo/life/           │     │  qa-architect/notes/                 │  │
│  │  ceo/plans/          │     │  ...                                 │  │
│  └──────────────────────┘     └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
         ▲  upload (every 5 min, etag-deduplicated)
         │
         │  download (startup restore, skip existing local files)
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Container: /paperclip-agents/<slug>/memory|notes|plans|...             │
│  (= AGENT_HOME runtime subdirs, writable volume mount)                  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Startup sequence:**
```
Server starts
  │
  ├─ 1. restoreAgentRuntimeFromS3()
  │       └─ list S3 objects under agent-runtime/<instanceId>/
  │       └─ download each file that doesn't exist locally (local wins on conflict)
  │       └─ log: "agent runtime S3 restore complete: restored=N skipped=M"
  │
  ├─ 2. Heartbeat scheduler starts (agents can now find their AGENT_HOME files)
  │
  └─ 3. syncAgentRuntimeToS3() on interval (every 5 min by default)
          └─ walk local runtime dir, upload changed files (etag-deduplicated)
          └─ log: "agent runtime S3 sync complete: uploaded=N skipped=M"
```

---

### Adapter Pipeline — Environment Injection

Both `claude_local` and `codex_local` adapters inject env vars before spawning the CLI subprocess:

```
Heartbeat fires
  │
  ▼
buildClaudeRuntimeConfig() / buildCodexEnv()
  │
  ├─ Merge adapter-level envConfig entries
  │
  ├─ Inject AGENT_HOME  ←  PAPERCLIP_AGENT_RUNTIME_DIR / <slug>
  │       └─ slug derived from instructionsFilePath parent dir name
  │       └─ directory created if it doesn't exist (mkdir -p)
  │
  ├─ [codex_local only] Inject CODEX_HOME  ←  AGENT_HOME/.codex
  │       └─ isolates Codex CLI from ~/.codex personal config
  │
  ├─ [claude_local only] Write mcp-config.json from adapter mcpServers
  │       └─ --mcp-config <path> --strict-mcp-config
  │       └─ blocks personal ~/.claude MCP servers unless explicitly allowed
  │
  └─ Spawn CLI subprocess with clean, reproducible environment
```

---

### Public vs Private Separation

```
Public GitHub repo (paperclipai/paperclip)     Private / Operator-specific
────────────────────────────────────────────   ──────────────────────────────
Generic Paperclip server code                  AGENTS.md instruction files
Adapter implementations                        HEARTBEAT.md / SOUL.md / TOOLS.md
Docker Compose templates                       Agent memory, notes, plans
Empty/example agents/ directory                Operator S3 bucket + credentials
                                               .paperclip-local/docker-compose.env
                                               ~/.paperclip/ (DB, agent homes)
```

Operators fork the public repo, add their own `agents/<slug>/AGENTS.md` files, configure S3 credentials, and all runtime data stays in S3 — never committed to source control.

---

## Phases

### Phase 1 — Runtime Isolation for Local Adapters ✅ DONE

Decouple Paperclip agent runs from the operator's personal CLI environment.

- ✅ `claude_local`: passes `--strict-mcp-config` flag; writes per-agent `mcp-config.json` from adapter `mcpServers`; blocks personal `~/.claude` MCP servers by default.
- ✅ `codex_local`: injects `CODEX_HOME = $AGENT_HOME/.codex`; isolates Codex CLI from `~/.codex` personal config.
- ✅ Cross-platform spawn compatibility preserved (PR #366).

**Implementation:** `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/codex-local/src/server/execute.ts`

---

### Phase 2 — Required Environment Injection ✅ DONE

Make agent runtime assumptions explicit and reliable.

- ✅ Both adapters inject `AGENT_HOME = $PAPERCLIP_AGENT_RUNTIME_DIR/<slug>` derived from `instructionsFilePath` parent dir name before spawning the subprocess.
- ✅ Directory is `mkdir -p`'d on every run — agents never encounter a missing home dir.
- ✅ Slug falls back to `agent.id` if `instructionsFilePath` is not set.

**Implementation:** `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/codex-local/src/server/execute.ts`

---

### Phase 3 — Session Resume Policy Hardening ✅ DONE

- ✅ Timer wakes always start fresh — `shouldResetTaskSessionForWake()` returns `true` for `wakeSource === "timer"`.
- ✅ Manual on-demand wakes and `issue_assigned` wakes always start fresh.
- ✅ `sessionMaxAgeSec` added to `parseHeartbeatPolicy()`: if a saved task session is older than this value (seconds), it is discarded. Default: `0` (disabled). Set e.g. `86400` for 24 h expiry. Logged when triggered.
- ✅ Task-keyed sessions preserved for active assignment wakes within the age window — continuity maintained where genuinely valuable.
- ✅ Worktree cleanup from PR #179 compatible (session reset clears task sessions, worktrees cleaned separately).

**Configuration:** set `runtimeConfig.heartbeat.sessionMaxAgeSec` per agent. Execution agents with long idle periods should use this to avoid resuming huge stale contexts.

**Implementation:** `server/src/services/heartbeat.ts` — `parseHeartbeatPolicy()`, `executeRun()`

---

### Phase 4 — Heartbeat Pre-flight Guard (Idle Token Burn) ✅ DONE

Stop spawning the adapter subprocess when there is nothing to do.

- ✅ Guard runs in `executeRun()` before adapter invocation: for bare timer wakes with no `issueId`, counts active assigned issues (`todo`, `in_progress`, `in_review`, `blocked`).
- ✅ If count is 0: run is marked `succeeded` with `{skipped: true, reason: "no_actionable_work"}`, no subprocess spawned, no tokens burned.
- ✅ On-demand, assignment, and automation wakes bypass the guard and always run.

**Implementation:** `server/src/services/heartbeat.ts` lines 1071–1108

---

### Phase 5 — Stderr Classification and UI Presentation ✅ Backend Done

Distinguish real failures from benign runtime noise.

- ✅ `packages/shared/src/utils/stderr-classifier.ts` — `classifyStderrLine()` + `accumulateStderrStats()` exported from `@paperclipai/shared`.
- ✅ Known benign pattern groups: `mcp_auth_noise` (`rmcp::` transport logs), `node_deprecation`, `node_experimental`, `codex_session_debug`, `rust_tracing_info`, `claude_session_persistence`, `paperclip_retry`, `update_notice`.
- ✅ `heartbeat.ts` `onLog` accumulates `stderrStats` (`benignCount / errorCount / totalCount`) per run.
- ✅ Final lifecycle/error run event payload includes `stderrStats` so the UI can distinguish warning noise from real failures.
- 🔲 UI: render successful runs with warning annotations (yellow badge) when `stderrStats.errorCount === 0 && stderrStats.benignCount > 0`. Runs with `errorCount > 0` keep error styling. (Frontend work — user to implement.)
- Keep full raw logs available for deep debugging.

**Outcome:** Operators can scan runs faster. Successful work is not overshadowed by low-signal warnings.

---

### Phase 6 — Observability and Acceptance Metrics ✅ DONE

Measure whether the cleanup actually worked.

- ✅ `DashboardSummary.runtimeHealth` added to `packages/shared/src/types/dashboard.ts`.
- ✅ `dashboardService.summary()` computes 4 metrics from `heartbeat_runs` (last 7 days, company-scoped): timer wake skip %, stderr noise %, session resume rate %, median timer input tokens.
- ✅ "Runtime Health" row rendered on `ui/src/pages/Dashboard.tsx` below the existing 4 MetricCards — hidden when no runs exist in the window.

**Outcome:** Evidence-based validation instead of intuition. Operators can see at a glance whether Phase 4 (skip %), Phase 5 (stderr %), Phase 3 (resume rate %), and token spend are behaving as expected.

---

### Phase 7 — Codex Billing Mode and Cost Tracking ✅ DONE

- ✅ PR #386 merged: heartbeat cost recording routes through `costService.createEvent()`.
- ✅ PR #385 merged: `calculateTokenCostCents()` estimates cost from token counts; `calculatedCostCents` stored separately from adapter-reported `costCents`.
- ✅ Greptile bug fixes applied inline: cached token double-counting corrected; unknown model returns `null` not `0`.
- ✅ Global `OPENAI_API_KEY` fallback: `codex_local` falls through to `process.env.OPENAI_API_KEY` when agent config has no key, so Docker-level env var is recognized.

**Operator action still required:** create a `paperclip` API key at platform.openai.com and add it as `OPENAI_API_KEY` in each Codex agent adapter config (or set it as a global env var in `docker-compose.env`).

---

### Phase 8 — Agent Runtime File Centralization and S3 Persistence ✅ DONE

- ✅ `.gitignore` excludes all runtime subdirs: `agents/*/memory/`, `agents/*/notes/`, `agents/*/life/`, `agents/*/plans/`, `agents/*/logs/`, `agents/*/.codex/`.
- ✅ All `agents/*/AGENTS.md` files updated with `## Runtime Files` section pointing to `$AGENT_HOME`.
- ✅ `PAPERCLIP_AGENT_RUNTIME_DIR` defaults to `/paperclip-agents` (unified with instruction files mount).
- ✅ `docker-compose.quickstart.yml` agents volume mount is R/W (removed `:ro`).
- ✅ `syncAgentRuntimeToS3()`: walks local runtime dir, uploads changed files every 5 min (etag-deduplicated).
- ✅ `restoreAgentRuntimeFromS3()`: on server startup, downloads missing files from S3; local wins on conflict.
- ✅ `listObjects()` added to `StorageProvider` interface with S3 (paginated) and local-disk implementations.
- ✅ Restore API for UI-driven conflict resolution:
  - `GET  /api/agent-runtime/restore/preview` — returns `{missing[], conflicts[], synced}` diff
  - `POST /api/agent-runtime/restore` — strategies: `missing_only` | `overwrite_all` | `selected`

**Implementation:** `server/src/services/agent-runtime-sync.ts`, `server/src/storage/`, `server/src/routes/agent-runtime.ts`

---

## Priority Order

| Priority | Work | Status |
|----------|------|--------|
| 1 | Phase 7 operator setup (create `paperclip` API key) | ✅ Done |
| 2 | Merge PR #386 (cost recording) | ✅ Done |
| 3 | Phase 4 pre-flight guard | ✅ Done |
| 4 | Phase 1 runtime isolation | ✅ Done |
| 5 | Phase 2 env injection | ✅ Done |
| 6 | Phase 8 runtime centralization + S3 | ✅ Done |
| 7 | Phase 3 session resume hardening | ✅ Done |
| 8 | Phase 5 stderr classification (backend ✅, UI 🔲) | ✅ Backend Done |
| 9 | Phase 9 auth bootstrap integrity | ✅ Done |
| 10 | Phase 6 observability metrics | ✅ Done |
| 11 | Integrate circuit breaker (#390) | 🔲 After noise baseline is clean |

## Acceptance Criteria

1. ✅ Agents with no assigned work do not spawn.
2. ✅ Codex API spend is visible in Paperclip's cost dashboard.
3. ✅ Successful runs no longer emit personal-MCP auth noise by default.
4. ✅ Agents that rely on role folders receive `AGENT_HOME` consistently.
5. ✅ Timer wakes without concrete issue work use materially fewer input tokens.
6. ✅ Backend: successful runs carry `stderrStats` in run event payload so UI can distinguish benign warnings from real failures. 🔲 UI rendering pending. *(Phase 5)*
7. ✅ Operators can reproduce agent runtime behavior without depending on personal CLI state.

---

### Phase 9 — Auth Bootstrap Integrity (`local_trusted` → `authenticated` Contamination)

**Bug discovered:** When a user runs Paperclip in dev mode (`local_trusted`) and then switches to Docker (`authenticated` mode) with the same data directory, the ghost user `local@paperclip.local` created by `ensureLocalTrustedBoardPrincipal()` persists in the DB. Because this user has an `instance_admin` role, `bootstrapStatus` returns `"ready"` — even though there are zero real credentials in the `account` table. The result: the bootstrap CEO invite flow is skipped entirely, leaving the instance in a state where no one can log in.

**Two bugs:**

1. **Ghost admin blocks bootstrap** — `bootstrapStatus` considers the `local-board` ghost user an instance admin. In `authenticated` mode, the check should only count users that have at least one credential account (`account.provider_id = 'credential'`), not uncredentialed ghost users from dev mode.

2. **No recovery path** — once `bootstrapStatus = "ready"` with no real credentials, the bootstrap CLI command (`auth bootstrap-ceo`) refuses to run. There is no operator-facing tool to reset the bootstrap state or generate an admin invite after the fact.

**Deliverables:**

1. **Fix `bootstrapStatus` query** — in `authenticated` mode, only count `instance_admin` roles where the user has at least one real credential account. Ghost users from `local_trusted` mode are not valid authenticated principals.
2. **Cleanup on mode transition** — when the server starts in `authenticated` mode and detects the `local-board` user with no credentials, either remove it or strip its `instance_admin` role automatically.
3. **Force-bootstrap CLI escape hatch** — add a `--force` flag to `auth bootstrap-ceo` that regenerates an invite even when `bootstrapStatus = "ready"`, for recovery scenarios.
4. **Prevent `ensureLocalTrustedBoardPrincipal()` from running in `authenticated` mode** — confirm the guard is airtight so a misconfigured restart can't create the ghost user.

**Outcome:** Switching from dev mode to Docker authenticated mode is safe. Operators who end up in a locked-out state have a documented recovery path.

---

## Merged PRs — Post-Merge Follow-ups

The following upstream PRs have been merged into this branch. Each has a Greptile-identified issue that was either fixed inline or deferred as a follow-up.

### PR #386 — Route heartbeat cost recording through costService

**Status:** Merged. Greptile finding deferred as follow-up.

**Follow-up:** `costService.createEvent()` performs 2 extra `SELECT` queries per cost-bearing heartbeat run — one to validate the agent belongs to the company (line 14–23 of `costs.ts`) and one after updates to evaluate the budget threshold (lines 47–51). The heartbeat already holds the fully-loaded `agent` object at the call site, making both fetches redundant. For high-frequency agents this adds meaningful overhead.

**Recommended fix:** Add an internal `createEventWithAgent(agent, data)` variant that accepts the pre-loaded agent and skips the validation SELECT. The budget-check SELECT can be eliminated by using the in-memory `spentMonthlyCents + event.costCents` directly.

---

### PR #385 — Model-based token pricing for cost calculation

**Status:** Merged. Both Greptile bugs fixed inline.

Fixes applied:
1. **Cached token double-counting** — Codex reports `cachedInputTokens` as a *subset* of `inputTokens` (total includes cached), while Claude reports them separately. The formula now subtracts `cachedInputTokens` from the base before applying the full-rate, preventing double-billing for Codex cache hits.
2. **Unknown model returns `null` not `0`** — `calculateTokenCostCents` now returns `number | null`. Unknown or unset models return `null`, distinguishable from a known model with genuinely zero cost.

---

### PR #179 — Git worktree cleanup lifecycle on session clear

**Status:** Merged. All Greptile bugs addressed in PR's follow-up commits or fixed inline.

Greptile findings resolved:
1. **Incorrect `repoRoot` derivation** — Original used `path.dirname(path.dirname(prevCwd))` which returned the grandparent dir, not the git repo root. Fixed in PR with `gitRepoRoot()` using `git rev-parse --git-common-dir`.
2. **`removed` counts attempts not successes** — `removeGitWorktree` now returns `boolean`; callers only increment counter on `true`.
3. **Redundant `isPaperclipWorktree` condition** — Simplified to use `path.sep` consistently (no duplicate literal check).

---

## Open Questions

1. Should runtime isolation be per company or per agent?
2. What session size/age threshold should disable automatic resume?
3. Should subscription-mode Codex runs be excluded from budget enforcement entirely?
4. Should the estimated cost flag (`calculatedCostCents`) be surfaced in the UI or silently accepted?
5. Should timer wakes for non-manager roles be discouraged in defaults or enforced in orchestration?
6. Should #390 ship only after Phases 1–4 complete, so the breaker doesn't learn from noisy baseline behavior?
