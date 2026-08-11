# cracked-dev state

Repo: paperclipai/paperclip · default branch: `master` · fork remote: `fork` (trelmitt/paperclip)
Isolation: run in a git worktree off origin/master (main tree has concurrent activity).

## Done
- **run-liveness lifecycle golden corpus (ratchet)** — `run-liveness.test.ts`. The existing
  adversarial matrix covers the text/actionability axis only; added a systematic lifecycle
  corpus pinning all 7 RunLivenessStates via the run-status/issue-status/evidence axis
  (interrupted→needs_followup, failed, timeout→failed, done/cancelled→completed, empty_response,
  advanced via concrete+plan-doc, needs_followup). Test-only, runs in CI with vitest. 42/42
  green; every expectation matched the classifier (no surprises). Commit `239ccd5bb`. SAFE.
- **`db:check` deploy preflight (structural fix for the 08-10 incident)** — new
  `scripts/check-pending-migrations.ts` + `pnpm db:check`. Finds pending migrations by sha256
  hash membership vs `drizzle.__drizzle_migrations` (verified drizzle's hash IS sha256 of the
  .sql — offset-proof vs the journal count, which drifts 213 applied / 212 journal here), scans
  each for non-idempotent CREATE TABLE / ADD COLUMN / CREATE INDEX, checks the live schema, exit
  1 on collision. New deploy incantation: `pnpm build && pnpm db:check && restart`. Pure
  `extractDdl`/`findConflicts` covered by `--self-test` which replays the exact actionability
  incident. Read-only. Commit `73ad66f57`. SAFE.
- **[FINDING] Company memory unreachable — D1 grant missing (0/13 agents)** — verified via the
  detection query: ALL 13 active Twenty Four agents lack the `tools:use` grant, so EVERY gateway
  tool (not just remember/recall) is deny_default-blocked. Core agent work bypasses the gateway
  (internal ops) so the fleet looks healthy. Fix = the plan's D1 baseline grant (surfaced to
  Trevor — it's a permission write the classifier blocks; reversible). Until applied, the memory
  tools + all MCP/gateway tools are inert. Auto-recall injection (b) and semantic recall (c) are
  downstream of this and were NOT built (b needs a relevance/context-budget design decision +
  touches the heartbeat run-assembly core; c needs pgvector).
- **Company memory table + remember/recall agent tools (foundational)** — new
  `company_memories` schema + migration `0213` + `paperclip-self:remember`/`recall` in
  tool-gateway. Greenfield (memlawb = dormant external-MCP template, not DB-backed; no
  existing knowledge table — confirmed by recon). Company-scoped, nullable agent attribution,
  tags[], pg_trgm GIN index on content (mirrors documents' search). recall = per-term ILIKE
  over content/title + tag overlap, recency-ranked; semantic/vector is a deliberate later
  step. Agent-gated + company-scoped via session; obeys the SAME deny-default `tools:use`
  grant as every gateway tool (agents need that grant to use them — the D1 baseline). remember
  ungated by default (no require_approval policy); content capped 16k. +1 test (write, recall
  by keyword+tag, non-match, cross-company isolation). VERIFY: 18/18 gateway-service tests +
  typecheck; DEPLOYED (0213 applied clean at 22:26, table exists 8 cols, tools in dist, boot
  exit 0). Self-audit: CLEAN (server-derived company scope, parameterized queries, input cap).
  Commit `4b13b4582`. RISKY (table+migration+agent tool) → local commit, no PR.
- **Wire `actionability` → recovery escalation (TWE-182 deferred half)** — `recovery/service.ts`
  + `issue-recovery-actions.test.ts`. The persisted `heartbeat_runs.actionability` axis was
  written but never READ by the recovery reconciler, so a successful run that flagged a
  manager/human-review change (prod deploy, secret rotation, strategy call) mapped to
  `livenessState=needs_followup` → counted as a productive continuation → got AUTO-RE-WOKEN
  (the exact unsafe path run-liveness.ts:351-354 warns about). Fix: added `actionability` to the
  `LatestIssueRun` Pick + all 3 `getLatestIssueRun*` selects, and a guard at the top of the
  successful-continuation branch — `actionability==='manager_review'` routes to the existing
  `escalateStrandedAssignedIssue` (issue→blocked + manager recovery owner + danger notice)
  before any auto-continue path. +1 reconciler test (manager_review escalates, no requeue).
  VERIFY: server typecheck green; 89/89 recovery+run-liveness tests. Self-audit: CLEAN (reads an
  existing column; reuses vetted escalation helper; reversible). Isolated commit `590b275a3`;
  DEPLOYED (rebuilt + graceful SIGTERM restart, clean boot exit 0, string confirmed in dist).
- **Heartbeat scheduler reentrancy guard (correctness)** — `server/src/index.ts`
  (`startHeartbeatSchedulerInterval`). On a slow/memory-bound box a tick's recovery chain
  (reap → promote → resume → reconcile …) outlasts `heartbeatSchedulerIntervalMs`, so the
  next interval fired a second overlapping tick → double-promote/double-wake. Every piece of
  tick work is already tracked in `heartbeatSchedulerInFlight`, and `startupHeartbeatRecovery`
  is awaited before the interval starts with no other feeder, so a non-empty set at fire time
  = prior tick still draining → skip. Guard placed in the shared interval wrapper (covers both
  the heartbeat and external-object-only call sites). Sweeps are catch-up so a skipped tick is
  recovered next fire; no work lost. VERIFY: server typecheck green; 61/61 scheduler-adjacent
  heartbeat tests (suppression/start-lock/retry/stale-queue). Self-audit: CLEAN (no security
  boundary; reads a Set size + debug log + early return). Isolated local commit `8fb1e9158`
  (NOT a PR — tree carries stacked WIP). DEPLOYED (server dist rebuilt + restarted); verified
  live — guard skip-count 0 (no starvation), heartbeat ticks + enqueues runs normally.
- **Boot-time migrator crash-loop — root cause + fix (incident)** — the deploy restart took the
  control plane DOWN for ~20 min. HONEST root cause: NOT the `-k` flag and NOT the reentrancy
  guard (my two wrong intermediate guesses). The server runs pending drizzle migrations on
  EVERY boot; migration `0212` did `ALTER TABLE heartbeat_runs ADD COLUMN actionability`, which
  collided (Postgres 42701) with the column that had been hand-added earlier (out of band) to
  clear the fleet jam. The running process had already passed its migration step, so it only
  surfaced on the next restart — exactly the "reconcile migration history" follow-up flagged
  when 0212 was generated. Fix: `ADD COLUMN IF NOT EXISTS` (commit `c9cc4d40a`) — correct for
  both the live DB (skip existing col, create the cloud_upstream_* tables) and a fresh DB.
  Migrator reads migrations from SOURCE (`packages/db/src/migrations`), so no rebuild needed.
  KEY DEBUG LESSON: the app logs the real boot error to `~/.paperclip/instances/default/logs/
  server.log` (READABLE) — read THAT first; the `~/Library/Logs/*` files are Read-blocked and
  the manual `> /tmp` redirects are empty because the app logs to its own dir, which sent me
  down a wrong native-SIGABRT path for ~20 min. Recovery: `launchctl bootout` to stop the
  crash-loop, fix migration, `launchctl bootstrap` (graceful, not `-k`).
- **Follow-ups: cap permanence + synthesis schedule + stale-fold** — (1) self-start `HARD_CEIL`
  default 3->5 so the compute win survives reboot (twentyfour-artifacts `e18bc0c`). (2) Weekly
  launchd job `com.rhen.agent-synthesis` runs the synthesis -> vault report Sundays 07:00
  (twentyfour-artifacts `1538d17`; needs abs node path — launchd PATH lacks Homebrew). (3)
  Client-side stale-fold: review-kind rows idle >=3d (`attentionIsStale`, `ATTENTION_STALE_DAYS`)
  fold into a new "Stale" curtain; blockers never fold (an old blocker is still blocking). +test;
  54 attention tests + ui typecheck green. Self-audit: CLEAN.
- **Decisions desk: needs-you-first default sort (ADHD)** — `ui/src/lib/attention.ts`.
  Added a `"priority"` AttentionSortOrder (blocking rows above review, then server
  escalation `rank`, then recency) + made it the default (`loadAttentionSortOrder`). Fixes
  the flat time-only desk where a fresh review sat above an older blocker. +1 test. VERIFY:
  53/53 attention tests, ui typecheck — green. Self-audit: CLEAN (pure client sort of
  already-authorized data). Shipped as an isolated local commit (NOT a PR): the tree carries
  Trevor's budgets WIP + tonight's unpushed commits, so push/PR/auto-merge to shared `master`
  would entangle them — flagged per the fences. Companion same-session desk fixes: graceful
  "already resolved" + 45s self-clear (46a0433d3); Decline now rejects inline instead of
  expanding the row (removed the `issue_thread_interaction && reject -> onOpen` special-case;
  reject reason is optional server-side) — symmetric with Confirm, +updated row test.
  Then added an "Open task" escape hatch in the expanded (See more) view of simple/inline
  decisions (sibling in CollapsibleContent, gated inline && href — no resolver surgery) so a
  simple decision that turns out to be heavier has a one-click path to the full task; +2 tests,
  updated 2 that pinned "no Open on inline". Model B (one-tap on card + See more + Open for
  complex) was ALREADY implemented; the Decline fix completed it, this is the only net-new.
  - Deferred (RISKY): auto-tuck stale (>3d) decisions into the Aging curtain — `attentionIsAging`
    reads the SERVER-computed `item.shelf` (30d retention), so this is a server retention change
    affecting the whole queue, not a client tweak. Needs Trevor's go before touching retention.
- **run-classifier safety axis (TWE-182, partial)** — `server/src/services/run-liveness.ts`.
  Fixed the NEGATED_BLOCKER bypass (approval/manager now evaluated before the "not blocked"
  short-circuit) and routed `manager_review` to `needs_followup` before the concrete-evidence
  "advanced" path so risky productive runs escalate instead of auto-continuing. +4 adversarial
  tests. VERIFY: 18/18 tests, server typecheck, shared build — all green. Self-audit: CLEAN.

## Ruled out / deferred (this cycle)
- Persisting the `actionability` axis on `heartbeat_runs` (schema/migration) + wiring
  `manager_review` into the recovery escalation subsystem — RISKY (migration) and larger;
  left as the structured-run-self-report follow-up. Do not re-scope into this PR.

## Repo conventions learned
- Tests: `pnpm --filter @paperclipai/server exec vitest run <path>`; typecheck needs
  `@paperclipai/shared` built first. No `--state all` on `gh search prs`.
- PR template enforces a dedup-search checkbox (a bot fails `review` until it's checked with
  real linked PRs). `trelmitt` has no upstream write — PRs go via the `fork` remote.

## Next candidates (ranked)
1. **[BLOCKED ON TREVOR] Apply the D1 `tools:use` baseline grant** (0/13 agents have it → all
   gateway tools inert). SQL surfaced; classifier-blocked write. Everything tool-facing waits on
   this. Optional: bake into hire.mjs / an in-model `routes/access.ts` call so new agents get it.
2. Auto-recall injection at run start — inject the top-N relevant company memories into the run
   context (vs the pull-only recall tool). Needs a design call (relevance ranking + context
   budget + which memories) and touches heartbeat.ts run assembly (M). Gated on candidate 1.
3. Semantic/vector recall once trigram ILIKE is outgrown — needs pgvector + an embedding step (L).
