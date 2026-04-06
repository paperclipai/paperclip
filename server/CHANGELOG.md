# @paperclipai/server

## Unreleased

### Patch Changes

- `PATCH /api/issues/:id` now supports an optional `expectedIdentifier` guard. When provided and mismatched, the API returns `409` (`Issue identifier mismatch`) and does not mutate the wrong issue. This hardens agent heartbeats against ID/identifier mix-ups under large todo queues.
- `POST /api/companies/:companyId/agents` now returns an explicit guidance error for agent actors: direct create is board-only and agent-side creation must use `POST /api/companies/:companyId/agent-hires`. Updated `docs/api/agents.md` and paperclip skill API references to clarify route intent (`/agents` board direct-create vs `/agent-hires` for agent-driven hire flow).
- Onboarding/runtime guidance hardening for local OpenCode agents: default `HEARTBEAT.md` and `skills/paperclip` now require re-reading `$AGENT_HOME/memory/YYYY-MM-DD.md` before writes in the same session (read-before-write) and add missing-path guardrails (`rg --files`/`find` + continue with path resolution instead of failing the whole heartbeat on a single `File not found`).
- Fix `POST /api/companies/:companyId/issues` runtime `ReferenceError` when issue creation includes workspace inheritance. `issueService.create()` now correctly reads `inheritExecutionWorkspaceFromIssueId` from input before resolving inherited project/execution workspace context, preventing intermittent `500 Internal server error` during New Issue creation.
- Heartbeat scheduler now auto-promotes aged assigned issues from `backlog` to `todo` with controlled wakeups (batch cap + per-agent cooldown + per-tick wake cap). Tunables: `PAPERCLIP_BACKLOG_AUTO_PROMOTION_ENABLED`, `PAPERCLIP_BACKLOG_AUTO_PROMOTION_AGE_SEC`, `PAPERCLIP_BACKLOG_AUTO_PROMOTION_BATCH`, `PAPERCLIP_BACKLOG_AUTO_PROMOTION_WAKEUP_COOLDOWN_SEC`, `PAPERCLIP_BACKLOG_AUTO_PROMOTION_MAX_WAKEUPS_PER_TICK`.
- Fix malformed issue inbox stats query assembly in `issues` service (`list`) so comment/read/activity aggregates parse correctly at runtime (restores server startup for LaunchAgent and preserves touched/unread context derivation).
- Make Hermes adapter server exports resilient in registry loading: `listSkills`, `syncSkills`, and `detectModel` are now optional capability bindings so LaunchAgent boot does not fail when `hermes-paperclip-adapter/server` omits those named exports.
- Restore missing `index.ts` imports for `feedbackService` and `createFeedbackTraceShareClientFromConfig`, fixing startup `ReferenceError` during server bootstrap.
- Fix `PATCH /api/issues/:id` route validator reference to use `updateIssueSchema` (replacing stale `updateIssueRouteSchema`) so route registration no longer throws at server startup.
- Restore `deriveTaskKeyWithHeartbeatFallback` in heartbeat service so unscoped runs still get the synthetic `__heartbeat__` task key instead of crashing at runtime.
- Restore missing heartbeat execution-workspace helpers (`applyPersistedExecutionWorkspaceConfig`, config snapshot/runtime stripping, persisted workspace realization) and run-comment builder to prevent adapter runtime crashes on wake.
- **CEO heartbeat triage guidance:** when the coordinator/CEO receives a recurring "last 24h" analysis assignment, onboarding now requires posting a concise findings comment on the issue (including explicit "no incidents" when applicable) instead of exiting silently. It also explicitly forbids closing as a noop when incident signals are non-zero (`issue.review_dispatch_noop`, `issue.merge_delegate_wakeup_failed`, `stale technical queue`), requiring linked issue IDs plus owner/action or mitigation evidence.
- **`GET /api/agents/me/inbox-lite`** now includes **`handoff_ready`** assignments and sorts them immediately after **`in_progress`** so executors see stuck handoffs / review-dispatch noops in the default heartbeat inbox. Updated default and CEO onboarding **`HEARTBEAT.md`**, **`skills/paperclip`**, **`docs/api/agents.md`**, **`docs/agents-runtime.md`**, and **`docs/guides/board-operator/runtime-runbook.md`** with handoff repair, anti-stall sweep, adapter-health, and CEO operational triage guidance.
- **Technical review dispatch:** `resolveArtifact` treats any **github.com** PR URL in the **same `PATCH` comment** as `handoff_ready` as a valid handoff signal (not only `# handoff` / `@revisor pr` / no-new-diff), fixing **`pull_request_not_found`** dispatch no-ops when executors paste the PR link without a magic heading; recent-comments scanning uses the same precedence (explicit markers win, else newest PR URL, then description).
- **Technical review dispatch:** same-`PATCH` handoff comment now has precedence over attached PR work products when resolving the current review artifact. This prevents stale work-product context from deduplicating a fresh review round on the same PR after new executor changes. Also, `same_pr_existing_artifact` dedup now only reuses **non-terminal** review children; completed (`done`/`cancelled`) children no longer block a new review cycle unless diff identity/no-new-diff logic matches.
- **Technical review dispatch self-heal:** `PATCH /api/issues/:id` now retries technical-review dispatch when the parent already sits in `technical_review` (not only when it transitions to `handoff_ready`). This prevents stuck queues where a parent was moved to `technical_review` without creating a `technical_review_dispatch` child and the reviewer inbox stayed empty.

<details>
<summary>Details (edge cases &amp; docs)</summary>

- Comment-only PR links are read for **dispatch**; they do **not** by themselves insert a `pull_request` work-product row (executors should still add/update a work product when the board should track a primary PR — see API work-products routes).
- Doc / onboarding touchpoints aligned on the same contract: default and CEO **`HEARTBEAT.md`**, **`skills/paperclip`**, **`docs/api/issues.md`**, **`docs/agents-runtime.md`**, **`docs/guides/board-operator/runtime-runbook.md`**, **`doc/plans/2026-04-05-agent-workflow-hardening.md`**.

</details>
- **Heartbeat:** runs using **codex-local** no longer end as **`failed`** when Codex exits non-zero after a successful streamed turn: the executor now honors **`rawResult.paperclip.ignoredNonZeroExitCode`** on **`AdapterInvokeResult`** — the same field as **`resultJson.paperclip.ignoredNonZeroExitCode`** on **`AdapterExecutionResult`** (§7.2 in `doc/spec/agent-runs.md`), so agents such as **Revisor PR** match UI/spec expectations while keeping the real exit code for diagnostics. `doc/spec/agent-runs.md` documents **`rawResult` ↔ `result_json` / `resultJson`** and a Heartbeat outcome table; **`adapterSignalsIgnorableNonZeroExit`** tests cover edge cases (`0`, `undefined`, **`paperclip: null`**).
- **Issues:** clearing `checkout_run_id` on status or assignee changes (and on `release`) now also clears **`execution_run_id`**, **`execution_agent_name_key`**, and **`execution_locked_at`**. Previously an issue could sit in **`todo`** with a stale execution lock, so **`POST .../checkout`** never matched and agents saw repeated **409** conflicts (often misread as “API indisponível”). **`checkout`** also drops a **terminal** stale execution lock once and retries so existing bad rows self-heal on the next wake.
- **Onboarding:** default `server/src/onboarding-assets/default/TOOLS.md` now documents the correct heartbeat env vars (**`PAPERCLIP_API_URL`** / **`PAPERCLIP_API_KEY`**) in the `curl` example (replaces mistaken `PAPERCLIP_AGENT_API_KEY` / `PAPERCLIP_BASE_URL`).
- **Config:** when `config.json` uses **`database.mode: "embedded-postgres"`**, the server no longer applies **`DATABASE_URL`** from the environment (including a monorepo **`.env`** loaded from `cwd`). Operators who run Postgres on the side for other tools were seeing **`ECONNREFUSED` on localhost:5432** under LaunchAgent because the server tried external Postgres instead of starting embedded. Use **`database.mode: "postgres"`** with **`database.connectionString`** (or env) for a real external database.
- **Companies:** `PATCH` validates `technicalReviewerReference` (non-null) with the same agent resolution rules as technical-review dispatch—exactly one non-terminated agent in the company, **422** if missing or ambiguous. Column remains text without a DB FK.
- **Heartbeat:** workspace resolution labels adapter-config cwd fallback as `adapter_config` (not `agent_home`); `git rev-parse` during worktree setup uses **`MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS`**. Local adapters treat `adapter_config` like `agent_home` for optional `cwd` override behavior.
- **Daily memory stub:** `memory/YYYY-MM-DD.md` idempotency removes a symlink at that path (unlink only) before creating the file so `writeFile` cannot follow a link to another path.
- **Heartbeat run effects:** conservative `default` branch in operational-effect summarization documented; redundant pre-seeding of empty effects removed (runs without rows still get `summarizeHeartbeatRunOperationalEffect([])`).
- **Agent health monitor:** historical `agent_health_alert` rows for reopen/cooldown are limited to issues with `created_at` or `updated_at` within the last **90 days**; per-finding/per-alert `issues` mutations and cooldown `logActivity` run in parallel where safe (reopen and auto-close keep **update → comment** order per issue), each item is wrapped in **`try`/`catch`** so one failure does not abort the tick, failures are logged and counted in **`tick()`’s `failed`** field.
- **Agent hire / create:** if persistence fails after bootstrap materializes **`$AGENT_HOME`**, the server removes the draft agent workspace directory; **`validateAgentBootstrap`** wipes the agent workspace on **any** materialization failure (not only **`ephemeralWorkspace`**) after **`testEnvironment`** succeeds, so partial mkdir / memory / bootstrap symlinks do not leave an orphan **`$AGENT_HOME`**.
- **`issues` routes:** technical-review child comments for **`findLatestTechnicalReviewSignal`** are fetched in parallel with **`Promise.allSettled`** (capped batch) so one failing **`listComments`** does not drop the whole scan; merge auto-complete cancels each open review child with per-item **`try`/`catch`** logging instead of aborting the whole loop; blocking review reconciliation logs when **`wakeup`** or **`checkout`** returns null; **`PATCH /api/issues/:id`** applies lane reconciliation then always calls **`svc.update`** with the merged patch when it is non-empty so user-supplied fields are persisted alongside reconciled lane state (no no-op shortcut against the reconciled row).
- **`routines` routes:** managing another assignee requires that assignee to exist in the company (**404** otherwise); **`assertCanManageExistingRoutine`** relies on **`assertAgentCanManageRoutineAssignee`** for company scope; assignee-change permission uses the precomputed **`assigneeWillChange`** flag.
- **Activity service:** **`runsForIssue`** skips **`loadHeartbeatRunOperationalEffects`** when there are no rows.
- Tests: embedded Postgres helpers forward **`onLog`/`onError`** to the console; **`issues-service`** uses **`startTempDatabaseWithRetries`** (bounded backoff after **`getAvailablePort`** + **`startTempDatabase`**) and **`afterAll`** **`try`/`finally`** so **`fs.rmSync`** runs even when **`instance?.stop()`** throws; **`review-dispatch`** tests use **`createMockDeps`** (**`ServiceDeps`** from **`Parameters<typeof reviewDispatchService>[1]`**), a parameterized **`it.each`** for no-new-diff dedup cases, and an assertion on **`dispatchForIssue`** **`result.kind`** for the custom reviewer path; **`technical-review-outcome`** tests cover **`normalizeReviewText`**, **`extractMarkdownSection`** (including adjacent **`###`** headings), parameterized blocking-section negations (EN/PT), blank/whitespace, padded and upper-case approved phrases, ambiguous samples, and a long non-matching body.
- **Technical review outcome parser:** **`ClassifiedTechnicalReviewOutcome`** type export; explicit return types on **`normalizeReviewText`**, **`extractMarkdownSection`**, and **`classifyTechnicalReviewOutcome`**; **`extractMarkdownSection`** finds the next **`###`** at the start of the remainder or after a newline (optional indentation); blocking-section collapse uses a broader **`BLOCKING_SECTION_NEGATION_RE`** (e.g. “no issues found”, “nothing blocking”, “all clear”, “zero blockers”, PT synonyms) before classifying as approved vs blocking.
- Route tests: shared **`createIssueRoutesTestDeps()`** (`server/src/__tests__/helpers/issue-routes-test-deps.ts`) supplies a typed minimal **`Db`** (transaction shell) and **`StorageService`** for `issueRoutes`; review-outcome, stale review lane, and PR reconciliation tests use explicit board **`TestBoardActor`** typing instead of `req as any`.
- `resolveRuntimeSessionLegacyFallback` coerces a missing `legacySessionId` to **`null`** and accepts **`undefined`** in its input type so runtime state without a stored session id stays a clean nullable fallback.
- Technical review **parent reconciliation:** `classifyTechnicalReviewOutcome` now treats **conflicting** approved vs blocking signals as **`null`** (no parent auto-move). **`normalizeReviewText`** folds accents with NFD + **`\p{M}`** only so Markdown backticks around `` `in_progress` `` are preserved. When a review child closes **`done`** but the summary does not classify, the server logs a warning and records **`issue.review_outcome_unparsed`** on the child. Route tests reset `getById`/`update`/`listComments` mocks between cases to avoid `mockResolvedValueOnce` leakage.
- PR merge auto-complete: parent issue transitions and cancellation of open technical-review children now share a **single DB transaction** (avoids parent `done` with active review children); post-commit routine sync failures are logged without rolling back issue state. Activity `issue.updated` details may include `cancelledChildIssueIds`. Structured log `issue.pr_merge_auto_complete` on success.
- `resolveCurrentOwner` returns the shared `IssueCurrentOwner` discriminated union (`agent` requires `agentId`, `user` requires `userId`, `board`/`unassigned` use null ids) so API payloads match the stricter client types.
- Agent workflow observability: **`issue.review_dispatch_noop`** activity when technical review dispatch cannot run (`reviewer_not_found`, `reviewer_ambiguous`, `pull_request_not_found`); **`issue.merge_delegate_wakeup_failed`** when the post-approval executor `wakeup` throws. Dashboard **Operational Observability** adds 24h tiles for these signals. Reviewer resolution order: company **`technicalReviewerReference`** → **`PAPERCLIP_TECHNICAL_REVIEWER_REFERENCE`** → default **`revisor-pr`**; distinct noop reason **`reviewer_ambiguous`**. English phrases for automated review outcome classification live in `server/src/services/technical-review-outcome.ts` (see `doc/plans/2026-04-05-review-outcome-classification-matrix.md`). Migration **`0047_company_technical_reviewer_reference`** adds `companies.technical_reviewer_reference`.
- Technical review **approved** reconciliation: when the primary GitHub pull-request work product has **`metadata.directMergeEligible: true`**, the parent issue is in **`human_review`**, and the PR is not draft, the server wakes the parent assignee with **`review_approved_merge_delegate`** so the executor can merge on GitHub and **`PATCH`** the work product to `merged`. GitHub-side optional automation: `.github/workflows/direct-merge-eligible.yml` (PR body must include HTML comment `<!-- direct_merge_eligible -->`, case-insensitive, after the `PR` workflow succeeds). Documented in `docs/guides/board-operator/runtime-runbook.md`, `docs/api/issues.md`, `skills/paperclip/SKILL.md`, and default onboarding `HEARTBEAT.md` / `AGENTS.md`.
- Issue mutations from **agents** now require `X-Paperclip-Run-Id` (401 `Agent run id required` when missing) on: `POST /api/companies/:companyId/issues`, `PUT /api/issues/:id/documents/:key`, `POST /api/issues/:id/work-products`, `PATCH /api/work-products/:id`, `POST/DELETE /api/issues/:id/approvals/...`, `DELETE /api/issues/:id`, and `POST /api/companies/:companyId/issues/:issueId/attachments` — aligning activity log `run_id` with checkout/release/PATCH. See `docs/api/issues.md`.
- `GET /api/issues/:id` (and other `/api/issues/:id/*` routes): human-readable ids like `TCN-887` that are **not** found now return **404**; previously the raw token was used as a UUID in SQL and could surface as **500** (Postgres `invalid input syntax for type uuid`).
- Agent PATCH bootstrap validation: OpenCode **`opencode_hello_probe_timed_out`** is treated as a **non-blocking** warning (same class as the Claude subscription key hint), so operators can change models / adapter config when the hello probe is slow; still re-check with **Test environment** on the agent.
- Local CLI / `process` adapter default wall-clock timeout when `timeoutSec` is 0 or missing is now **7200s** (2h), matching `@paperclipai/adapter-utils` (was 3600s).
- **`PAPERCLIP_STRICT_LISTEN_PORT`:** when set to the string **`true`** (same convention as `PAPERCLIP_SECRETS_STRICT_MODE` / `PAPERCLIP_AUTH_DISABLE_SIGN_UP` / `PAPERCLIP_DB_BACKUP_ENABLED`), the server exits on startup if the configured HTTP port is not free instead of binding the next free port (avoids silent drift from e.g. 3100 to 3101). **`resolveListenPort`** rejects non-integer or out-of-range (1–65535) configured ports before calling `detect-port`.
- Managed agent bootstrap: **`$AGENT_HOME`** directory creation, daily memory stub, and instruction symlinks run **after** adapter **`testEnvironment`** succeeds, so failed validation does not leave an orphan workspace on disk.
- Default onboarding **`TOOLS.md`**: clearer title, intro, API path hints, PARA layout examples, and **`$AGENT_HOME`** verification steps. Default **`HEARTBEAT.md`** / **`AGENTS.md`**: merge-delegate flow documents mandatory operator merge-mode consultation (**`MERGE_STRATEGY`**, **`/operator/merge-strategy`** / **`GET`**, **`"operator.mergeStrategy"`**), **`action-only`** + literal **`direct_merge_eligible`** gating, **hybrid-safe** fallback (no local auto-merge) to avoid racing **`.github/workflows/direct-merge-eligible.yml`** when the signal is missing/unknown, bounded exponential backoff + deterministic failure detection + required automatic PR comments + escalation for **`gh pr merge`**, PATCH retry/exhaustion handling, tombstone + compensating task reconciliation after merge drift, and consolidated **messaging requirements** (manual intervention vs rollback triggers).
- Board UI: agent **Run Heartbeat** keeps an unscoped invoke; the chevron menu adds **Run linked to issue…** (optional `forceFreshSession`) so manual runs get `issueId`/`taskKey` in context. `POST /api/agents/:id/heartbeat/invoke` already accepted this body — documented in `docs/api/agents.md`.
- Board UI: **Operational effect** chart bars use a full-height column (no double-scaling); legend **Finished** swatch matches **`bg-sky-500/35`**. **Issues list** syncs debounced search immediately when **`initialSearch`** changes. **StatusIcon** label trigger uses **`type="button"`** to avoid submitting parent forms.
- macOS: added `contrib/macos-launchagent/io.paperclip.local.plist` (example LaunchAgent for `paperclipai run`) and expanded `docs/guides/board-operator/macos-background-service.md` (template path, `pnpm build`, port, `NODE_OPTIONS`).
- Agent health monitor: **heartbeat-stalled** is no longer raised when the agent has an active **`running`** heartbeat (long local CLI work); `lastHeartbeatAt` only advances when a run completes, so coordinators and similar roles were false positives.
- Docs: `docs/agents-runtime.md` and the managed **paperclip** skill cover OpenCode **read-before-write** enforcement, identical-patch failures, worktree discipline, and high input-token sessions.
- `GET /api/agents/me/inbox-lite` now includes **`changes_requested`** and **`claimed`** assignments and sorts them so executors see **rework after review** before new **`todo`** work (tie-breakers: priority, then **`createdAt` ascending** — FIFO — so equal-priority backlog is not starved by newly created or recently touched issues). Responses now include **`createdAt`** alongside **`updatedAt`** so clients can see the FIFO key.
- Technical review reconciliation: broader parsing for “no blocking findings” (case-insensitive `### Findings bloqueantes` / `### Blocking findings`, extra approved phrases, `none` / `n/a` in the findings section).
- Heartbeat workspace resolution: when a run would otherwise fall back to the agent home directory (e.g. timer wakeups with no issue / no task session cwd), **`adapterConfig.cwd`** is now used when it points at an existing directory—so agents like “Revisor PR” that set a project checkout path keep working in that repo instead of only under `~/.paperclip/.../workspaces/<agentId>`.
- `GET /api/companies/:companyId/heartbeat-runs` defaults to **`limit=100`** when the query parameter is omitted (was 200), avoiding large responses on busy agents; callers can still pass `limit` up to **1000**.
- Process-loss recovery: when `reapOrphanedRuns` finalizes a local-adapter run as `server_restart` but **`processPid` was never stored** (restart before `onSpawn` persisted pid), enqueue the same **one-shot process-loss retry** as when a pid existed, so agents like Revisor PR do not stay terminal with no follow-up run.
- `issues.assertCheckoutOwner` now repairs `in_progress` issues where the assignee matches but `checkout_run_id` was cleared (same conditions as the checkout API repair path), so heartbeats no longer fail setup with `issue_checkout_required` after process loss or inconsistent state—unblocking agents like the coordinator when a wake retry runs without a prior `POST …/checkout`.
- Local CLI adapters (OpenCode, Codex, Claude, Cursor, Pi, Gemini) expand `$AGENT_HOME` in prompts to the absolute agent workspace path via `@paperclipai/adapter-utils`, reducing failures when models copy managed instruction paths literally against the git worktree cwd.
- Terminate still-alive local adapter child PIDs during startup `reapOrphanedRuns()` (and after prolonged `process_detached` + periodic stale threshold) so `running` runs do not block `queued` work indefinitely after a Paperclip restart.
- Ensure `$AGENT_HOME/memory/YYYY-MM-DD.md` exists (stub) before each heartbeat run and during managed-agent bootstrap validation, matching default `HEARTBEAT.md` read steps and avoiding adapter failures when the daily note was never created.
- Align route test mocks with agent bootstrap validation so server runs cover adapter environment checks and managed instruction bundle requirements without spurious 500 responses.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1
  - @paperclipai/adapter-claude-local@0.3.1
  - @paperclipai/adapter-codex-local@0.3.1
  - @paperclipai/adapter-cursor-local@0.3.1
  - @paperclipai/adapter-gemini-local@0.3.1
  - @paperclipai/adapter-openclaw-gateway@0.3.1
  - @paperclipai/adapter-opencode-local@0.3.1
  - @paperclipai/adapter-pi-local@0.3.1
  - @paperclipai/db@0.3.1
  - @paperclipai/shared@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies [6077ae6]
- Updated dependencies
  - @paperclipai/shared@0.3.0
  - @paperclipai/adapter-utils@0.3.0
  - @paperclipai/adapter-claude-local@0.3.0
  - @paperclipai/adapter-codex-local@0.3.0
  - @paperclipai/adapter-cursor-local@0.3.0
  - @paperclipai/adapter-openclaw-gateway@0.3.0
  - @paperclipai/adapter-opencode-local@0.3.0
  - @paperclipai/adapter-pi-local@0.3.0
  - @paperclipai/db@0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.7
  - @paperclipai/adapter-utils@0.2.7
  - @paperclipai/db@0.2.7
  - @paperclipai/adapter-claude-local@0.2.7
  - @paperclipai/adapter-codex-local@0.2.7
  - @paperclipai/adapter-openclaw@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.6
  - @paperclipai/adapter-utils@0.2.6
  - @paperclipai/db@0.2.6
  - @paperclipai/adapter-claude-local@0.2.6
  - @paperclipai/adapter-codex-local@0.2.6
  - @paperclipai/adapter-openclaw@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.5
  - @paperclipai/adapter-utils@0.2.5
  - @paperclipai/db@0.2.5
  - @paperclipai/adapter-claude-local@0.2.5
  - @paperclipai/adapter-codex-local@0.2.5
  - @paperclipai/adapter-openclaw@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.4
  - @paperclipai/adapter-utils@0.2.4
  - @paperclipai/db@0.2.4
  - @paperclipai/adapter-claude-local@0.2.4
  - @paperclipai/adapter-codex-local@0.2.4
  - @paperclipai/adapter-openclaw@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.3
  - @paperclipai/adapter-utils@0.2.3
  - @paperclipai/db@0.2.3
  - @paperclipai/adapter-claude-local@0.2.3
  - @paperclipai/adapter-codex-local@0.2.3
  - @paperclipai/adapter-openclaw@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.2
  - @paperclipai/adapter-utils@0.2.2
  - @paperclipai/db@0.2.2
  - @paperclipai/adapter-claude-local@0.2.2
  - @paperclipai/adapter-codex-local@0.2.2
  - @paperclipai/adapter-openclaw@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/shared@0.2.1
  - @paperclipai/adapter-utils@0.2.1
  - @paperclipai/db@0.2.1
  - @paperclipai/adapter-claude-local@0.2.1
  - @paperclipai/adapter-codex-local@0.2.1
  - @paperclipai/adapter-openclaw@0.2.1
