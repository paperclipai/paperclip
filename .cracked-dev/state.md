# cracked-dev state

Repo: paperclipai/paperclip · default branch: `master` · fork remote: `fork` (trelmitt/paperclip)
Isolation: run in a git worktree off origin/master (main tree has concurrent activity).

## Done
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
  (NOT a PR — tree carries stacked WIP). NOT yet deployed (needs server rebuild + `launchctl
  kickstart -k gui/501/com.rhen.paperclip`, brief fleet interruption — left for Trevor's go).
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
1. Wire `actionability` axis into recovery escalation (M) — deferred half of TWE-182;
   migration 0212 now exists so it's unblocked. Route `manager_review` into the recovery
   subsystem so risky productive runs escalate on the persisted axis.
2. Company memory table + recall tool (L, foundational).
3. Evals in CI + run-liveness golden corpus (M).
