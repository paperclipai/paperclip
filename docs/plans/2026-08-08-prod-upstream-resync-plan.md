# Bringing production onto upstream latest

Supersedes the branch-targeting decisions in
`2026-07-28-upstream-resync-plan.md`. That document's Phase 2 migration
technique, its hazard write-ups, and its rules all still stand — **read HAZARD
1-4 and "Rules" there before touching a merge conflict.** What changes here is
*which branch* is the target, because that document predates the discovery that
production does not run `dev`.

---

## The blocking discovery: production is not on the resync target

The 2026-07-28 plan targets `origin/dev` and deploys via compose
`qmA6aVJHUf_gcNjCelCay` (staging). Production does not build from `dev` and
never has.

Queried live from the Dokploy API on 2026-08-06:

| | value |
| --- | --- |
| prod compose | `Gh67c1zKV7MsnPo_lZiPZ` (`paper.zenova.id`) |
| `customGitBranch` | **`six-4584-reliability`** |
| `autoDeploy` | `false` |
| last deployment | `e7c45d91`, 2026-08-06 |

At the time of this discovery, CI's `deploy-prod` job fired on pushes to
`master` while rebuilding from `six-4584-reliability`. Those two could drift
arbitrarily far apart, and they did. The resync changes hard-disable that job:
CI may deploy only `dev` to staging. Production is an operator-only action
after staging verification and Henk's written sign-off for the exact candidate
SHA.

### The fork is three divergent lines, not one

All three share merge-base `b947a7d76` (2026-05-12) with upstream and all three
are **1056 commits behind** it. But they have also diverged *from each other*:

| | ahead | behind |
| --- | --- | --- |
| `master` vs `dev` | 11 | 14 |
| `six-4584-reliability` vs `dev` | 21 | 14 |
| `six-4584-reliability` vs `master` | 10 | 0 |

Resyncing `dev` alone would not move production, and would strand the 21 commits
that exist only on the production line.

**Stranded on `dev`, missing from production:** credential rotation and usage
attribution, credential quota window refresh/throttling, Claude usage CLI
fallback, outcome engine fast execution path, project operating profile
onboarding, issue mentions + mobile header polish, bundled plugin capability
validation.

**Stranded on production, missing from `dev`:** the entire async issue image
generation job system (~12 commits), the two liveness fixes from 2026-08-06, and
`61b355ee Revert "feat: harden AI factory delivery orchestration"`.

### One genuine product conflict between the lines

`dev` carries `f9b21a6b Merge AI factory hardening into dev`. Production carries
`61b355ee Revert "feat: harden AI factory delivery orchestration"`. The same
feature is merged on one line and reverted on the other. This is a product
decision and must be settled before the lines are reconciled — it cannot be
resolved by a merge tool.

---

## Regenerated delta

The `resync-inventory.md` in this repo describes the squashed local tree and is
superseded. Against the true merge-base `b947a7d76`, for the production line:

| | count |
| --- | --- |
| files the fork added | 293 |
| files the fork modified | 459 |
| **fork delta total** | **752** |
| also touched by upstream (conflict-prone) | **423** |
| fork-only, upstream untouched (low-risk carry) | **329** |

---

## Keep / replace / merge

The core of this migration is not conflict resolution, it is deciding which of
two independent implementations survives. Three buckets.

### KEEP — fork-only, upstream has no equivalent (verified)

Carry these forward wholesale. Upstream never touched these paths, so they
rebase cleanly.

- **Live browser stack** — `browser-stream.ts`, `browser-session-reaper.ts`,
  `scripts/browser/camoufox-live/`. Upstream's only streaming primitive is
  `plugin-stream-bus.ts`; it has no live-browser service at all. This is a
  fork advantage and is not at risk.
- **Notifications** — `telegram.ts`, `web-push.ts`. Upstream has no equivalent
  (only `systemd-notify.ts`, which is unrelated process supervision).
- **Image generation** — `codex-image-generation.ts`,
  `openai-image-generation.ts`, `issue-image-generation-jobs.ts`,
  `image-reference-guardrails.ts`, plus its migrations.
- **Adapters** — `claude-tui`, `claude-local`, `codex-local`, `cursor-local`,
  `gemini-local`, `opencode-local`, `deepseek-api`.
- **Hermes adapter boundary — non-negotiable.** Hermes remains an external
  plugin only. Core `server/`, `ui/`, and workspace packages must not add a
  Hermes dependency, import, registration, or dedicated parser. Operators load
  `hermes_local` through the Adapter Plugin manager, using the generic external
  plugin loader and UI parser bridge.
- **Plugins** — `plugin-operator-assistant`, `plugin-llm-wiki`.
- **Misc fork services** — `skill-run-telemetry.ts`,
  `improvement-suggestions.ts`, `agent-launch-lock.ts`,
  `agent-hire-idempotency.ts`.
- **Credentials (decided 2026-08-08)** — `credentials.ts`,
  `credential-encryption.ts`, `credential-quota-cache.ts`,
  `claude-login-sessions.ts`, `codex-account-id.ts`, `api-equivalent-cost.ts`,
  `credential-validate.ts`, and migrations `0085`, `0086`, `0098`, `0100`,
  `0101`. Upstream has no proper rotation, so the fork's rotation, failover and
  quota tracking are authoritative. Upstream's connections v3 /
  `secret-proposals` / `agent-secret-bindings` do **not** replace this. Take
  `run-secret-redaction.ts` from upstream as a purely additive win — it
  redacts secrets from run output and conflicts with nothing.

  **Salvage the 6 dev-only credential commits.** Because this subsystem
  survives, the credential fixes stranded on `dev` are now worth rebuilding onto
  the trunk: rotation + usage attribution, quota window refresh, quota polling
  throttle, and the Claude usage CLI fallback (2 commits). These are the only
  dev-only commits that clearly warrant salvage.

  **Planned upgrade — preflight quota gating.** Today quota exhaustion is
  discovered by *running and failing*, then failing over and retrying. The
  target behaviour is to detect an exhausted credential **before dispatch** so
  the run never starts against a dead credential. Both halves already exist:

  - the fork's `credential-quota-cache.ts` already exposes
    `getFreshQuotaCache`, `getReusableQuotaCache`, `getRecentQuotaErrorCache`,
    and the success/error setters — the state is tracked, it is just consulted
    reactively;
  - upstream's `agent-invokability.ts` exposes
    `evaluateAgentInvokability` / `evaluateAgentInvokabilityFromDb`, returning a
    typed `{ invokable, reason, message, details }` **before** a run is
    dispatched, with an extensible `AgentInvokabilityBlockReason`.

  So the implementation is: add a credential-quota block reason to upstream's
  invokability preflight, backed by the fork's quota cache, and select an
  alternate credential at *selection* time rather than after a failed run.
  Upstream already models budget-blocked candidates elsewhere
  (`budgetBlockedCandidateAgentIds`, `budget_incidents`), so the concept fits
  its existing vocabulary. Sequence this **after** the merge — it depends on
  upstream's invokability seam being present.
- **Orgs / RBAC / visibility (decided 2026-08-08)** — `organizations.ts`,
  `issue-visibility.ts`, `agent-execution-access.ts`, `project_members` and
  `org_memberships`, migrations `0087`–`0089`. Required and authoritative.
  Upstream's `resource-memberships.ts` and
  `principal-access-compatibility.ts` do not replace it. **Risk:** upstream's
  `authorization.ts` and agent-access phase-2 contracts are load-bearing for
  much of the new upstream surface (decisions, tool access, cases), so the fork
  model must be *adapted to* upstream's authorization seam rather than merely
  kept beside it. Expect this to be the single largest semantic merge in the
  resync — the 2026-07-28 plan warned that running both models is a standing
  source of authorization bugs, and that warning still applies.

### REPLACE — upstream's version is strictly more developed

Adopt upstream and retire the fork implementation. These are the features the
resync is *for*.

| fork has | upstream has | why upstream wins |
| --- | --- | --- |
| `company-mcp-servers.ts`, `mcp-oauth.ts`, `mcp-sanitize.ts` | `tool-gateway.ts`, `tool-access-policy.ts`, `tool-access.ts`, `tool-content-guards.ts`, `tool-runtime-supervisor.ts`, catalog + risk classification, approval flow, runtime slots, `doc/MCP-ACCESS-GOVERNANCE.md` | a full governance surface vs. a connection list |
| ad-hoc board interactions | **Decisions subsystem** — typed executable effects, staleness guards, HMAC-signed specs, mandatory expiry, effect ledger, `rule_key` + `/decisions/stats` | the automation ratchet; see below |
| issue-graph liveness escalation (disabled 2026-08-06) | **Task watchdogs** — opt-in per issue, verification-shaped | fixes the false-positive class we just disabled |
| — | attention ranking, status cards, summary slots, work timeline | supervision at scale |
| — | `cross-issue-influence-limit`, `issue-rewake-throttle`, issue-create idempotency | blast-radius bounds for unattended operation |
| — | board chat (`POST /board/chat/stream`) | requested explicitly |
| — | cases, folders, external objects, OpenAPI surface, teams catalog, built-in agents, smoke lab | net-new capability |

### MERGE — parallel invention, needs a product decision

Neither side is obviously better; both encode real requirements. **Do not let a
merge tool decide these.**

1. ~~**Credentials.**~~ **RESOLVED — keep the fork's, see KEEP below.**
2. ~~**Orgs / RBAC / visibility.**~~ **RESOLVED — keep the fork's, see KEEP
   below.**
3. **Coordination semantics.** Fork: `deadline-warden.ts`,
   `next-owner-handoff.ts`, `work-cycles.ts`, `issue-completion-evidence.ts`.
   Upstream: decisions + watchdogs + `successful-run-handoff` +
   `review-path-recovery` + `stalled-review-decisions`. Substantial conceptual
   overlap; needs a semantics reconciliation, not a file merge.

   **Resolved execution-liveness rule:** retain the fork's assigned-work
   contract. An issue created with an agent or human assignee is executable
   work, so an explicit or implicit `backlog` status is promoted to `todo` and
   the assignee is woken. Do not preserve an assigned backlog as parked work:
   it creates an unwoken liveness leaf and contradicts the fork's operational
   semantics. This is unrelated to the dropped AI-factory pipeline.
4. **AI factory hardening — DECIDED 2026-08-08: drop it.** Merged on `dev`,
   reverted on production; production's revert is authoritative and `dev`'s copy
   comes out during reconciliation.

   Rationale (recorded here because the original revert `61b355ee` carried only
   the default message, which is why this kept resurfacing): the model assumed
   **all company work is software delivery work**. Its stage vocabulary is
   hard-coded to `implementation | ci | deployment | smoke | functional_qa |
   technical_acceptance | business_acceptance`, and its policy pipeline is
   `work → verification → review → approval → deployment`. That over-fits a dev
   pipeline onto every kind of work a company does — research, ops, marketing,
   sales, support — none of which has a `ci` or `deployment` stage.

   Delete on reconciliation: `packages/shared/src/types/ai-factory-policy.ts`,
   `packages/shared/src/validators/ai-factory-policy.ts`,
   `packages/shared/src/types/delivery.ts`,
   `packages/shared/src/validators/delivery.ts`,
   `packages/db/src/schema/delivery_events.ts`,
   `packages/db/src/schema/external_operations.ts`,
   `packages/db/src/migrations/0117_delivery_truth_kernel.sql`, and the
   `ai-factory-*` / `external-operation-*` test suites.

   **Salvage before deleting.** One idea inside it is worth keeping in some
   form: the `delivery_events` CHECK constraint welding `source_kind` to
   `authority`, so an `agent_submission` can only ever be recorded as an
   `agent_claim` and never as verified truth. That is a work-type-agnostic
   anti-hallucination property — an agent cannot self-certify its own output —
   and it does not depend on the dev-shaped stage vocabulary. Consider
   re-expressing it against upstream's `cases` + work products rather than
   against delivery stages.

   **Collateral to clean up.** The revert deleted
   `0117_delivery_truth_kernel.sql` *and* its journal entry, freeing slots
   `0117`/`0118` that the async image-job work later reused. That is the source
   of `master`'s 117-vs-119 journal mismatch and its red CI since 2026-07-16.
   Dropping the kernel permanently makes that reuse legitimate; the journal
   entries still need adding.

---

## Why the Decisions subsystem is the headline adoption

Verified by reading `0197_decisions_v1.sql`, `packages/shared/src/types/decision.ts`,
`server/src/routes/decisions.ts`, and `decision-signing.ts`.

A decision is a **precomputed, typed, executable state change**, not a prompt.
Each option carries typed effects drawn from a closed set: `comment_on_issue`,
`create_issue`, `update_issue_status`, `assign_issue`, `cancel_issue_tree`,
`resolve_blocker`. Safety properties that matter for unattended operation:

- **Staleness guards.** Every effect declares `strict` or `lenient`, checked
  against `target_snapshots` captured at proposal time. `cancel_issue_tree`
  forces `strict` at the type level.
- **Signed specs.** `signed_spec` is an HMAC (`decision-spec-v1`) over a key
  file enforced to `0600` and process-user ownership.
- **Mandatory expiry.** `expires_at` is `NOT NULL`; `decision-wakeup.ts` wakes
  the origin agent with `decided | expired | cancelled`. A decision cannot park
  forever — structurally the correct version of what the liveness scanner was
  guessing at.
- **At-most-once effects.** `decision_effect_executions` is a per-effect ledger
  with an `idempotency_key` on the decision.

The autonomy ratchet: decisions carry a `rule_key`, and
`GET /companies/:id/decisions/stats?groupBy=ruleKey` returns per-rule
`{proposed, accepted, rejected, expired}` plus chosen-option distribution.
Rules humans accept ~always are provably mechanical and can be promoted to
auto-apply; split distributions are judgment-bound and stay human. Paired with
`decision_training_examples` — a context snapshot frozen at a cutoff, plus the
outcome and notes — this is a measured path from human-in-the-loop to
autonomous, rather than a guess.

---

## Sequence

**Phase A — establish the trunk.** *Simplified by the 2026-08-08 decisions: no
three-way reconciliation is needed.* The trunk is `six-4584-reliability`, the
production line, as-is. `dev` is not merged in — it is discarded as a source and
later force-updated from the resynced build to serve as staging. `master` is
resolved by whichever of it and the trunk is authoritative per file; note the
trunk is already `0 behind` master, so master contributes nothing and only needs
its journal entries for `0117`/`0118` added to unblock CI.

The only real Phase A work is therefore: add the two missing journal entries,
confirm the trunk builds green, and leave prod's compose pointed where it
already is (`Gh67c1zKV7MsnPo_lZiPZ` → `six-4584-reliability`). No compose
reconfiguration required.

> **PHASE A COMPLETE — 2026-08-08.** `dev` and `six-4584-reliability` are both
> at `b8cc57bc5`, CI green, deployed and verified healthy on
> `paper-dev.zenova.id`. `dev`'s previous tip is preserved as
> `dev-backup-2026-08-08` (`c141b0c00`).
>
> It did not go as predicted. The journal entries turned out to be a `master`-only
> problem — the trunk was already consistent at 119/119. Instead the trunk
> carried **five latent breakages**, none previously visible because `master`'s
> CI died at typecheck and `six-4584-reliability` is not in CI's trigger list at
> all. Production had been deploying from a branch no CI had ever validated.
>
> Two distinct causes:
> 1. **Botched revert.** `61b355ee` removed test scaffolding while leaving the
>    production code that depends on it — wake-request `createdAt` fixtures,
>    interaction `kind` fields, and `leftJoin` db stubs.
> 2. **Fixes that only ever existed on `dev`.** Five route suites never mocked
>    `cancelPendingForTerminalIssue`, which `routes/issues.ts:4994` calls on
>    every terminal-status transition, so those routes 500'd.
>
> Fixed in `ca70b56a7`, `af2ffd301`, `fcba3f10b`, `b8cc57bc5`. All test-side
> except one production change: restoring `request_confirmation` as a durable
> authorization hold in the liveness classifier, which reduces the
> false-positive class behind the "Unblock liveness incident" flood.
>
> **Correction to record:** the earlier claim that `dev`'s 14 commits could be
> dropped losing "nothing that regresses prod" was wrong. `dev` held liveness
> classifier fixes and route-test repairs the trunk never received. The
> remaining commits on `dev-backup-2026-08-08` deserve the same scrutiny before
> that branch is treated as disposable — the 6 credential commits especially,
> now that the fork's credential subsystem is confirmed as surviving.
>
> **Tooling note:** worktrees with `node_modules` symlinked from another
> checkout are *unsound* — pnpm's workspace links are relative, so
> `@paperclipai/shared` silently resolves into the other tree and produces
> plausible-but-fake test failures. It cost one wrong diagnosis this session.
> Use a real clone with its own `pnpm install`. `corepack pnpm@9.15.4` works
> where `pnpm` is not on PATH.

**Phase B — examine the prior attempt.** `origin/merge-upstream` has 282
fork-only commits from the same merge-base, and `trial/merge-upstream` exists
locally. It may hold solved conflicts or a known dead end. Read before redoing.

**Phase C — regenerate the inventory** against the reconciled trunk, classified
keep/replace/merge per the buckets above.

**Phase D — merge upstream.** Apply the 2026-07-28 Phase 2 migration technique
verbatim: renumber above the journal's *true max* (upstream's journal is
non-monotonic), idempotency-guard any renumbered migration whose content
changed, rely on `applyPendingMigrations` being hash-based so no ledger surgery
is needed. Migration collision band is 35 files.

**Phase E — settle the four MERGE decisions**, one at a time, each with tests.

**Phase F — verification and gated deployment.** Production deployment is a
human-gated action, not an automatic continuation of staging. Execute these
steps in order:

1. Run `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` successfully.
2. Record the exact candidate commit SHA and deploy that commit to
   `paper-dev.zenova.id`.
3. Run staging health checks and functional smoke tests against
   `paper-dev.zenova.id`, and present the commit SHA and results to Henk.
4. **STOP and wait for Henk's explicit written sign-off.** A green CI run,
   successful staging verification, creation of a `/goal`, or an earlier
   approval does not authorize deployment to production. Do not trigger the
   production Dokploy compose before this sign-off is given for the staged
   commit.
5. After sign-off, deploy the **same exact tested commit** to
   `paper.zenova.id`. If the candidate changes for any reason, its approval is
   invalid: redeploy the new commit to staging, repeat staging verification,
   and obtain fresh sign-off.
6. Run production health checks and functional smoke tests, then report the
   deployed commit and results.

The resync goal is not complete until production is healthy, but it must remain
paused at step 4 for as long as sign-off is outstanding.

`master` still fails typecheck on the journal mismatch (117 vs 119) and is the
only branch still red. Dropping the factory kernel permanently makes the reuse
of slots `0117`/`0118` legitimate, so the fix is now unambiguous: add the two
entries.

~~and has 4 failing tests in `heartbeat-issue-liveness-escalation.test.ts`~~ —
**retracted.** Those 4 failures were an artifact of the unsound symlinked-worktree
setup described in the Phase A note, not a real defect. That file passes 25/25 on
a correct checkout, and CI confirms it. Real CI never reached the test step on
`master` because typecheck failed first.

Known latent flake, not blocking: `routines-service.test.ts` can exit non-zero
via an unhandled rejection (a 409 from the deliberate "Cannot assign routines to
terminated agents" case escaping after the test passes). Reproduced locally, did
not reproduce in CI. Worth cleaning up separately.

---

## Decisions needed before Phase A can start

1. ~~**Trunk.**~~ **Decided 2026-08-08 — the production line
   (`six-4584-reliability`) is the trunk.** `dev` is not stable and is not a
   merge source; it gets *replaced* by the resynced build and reverts to being
   the staging branch that build deploys to. Do not merge `dev` into the trunk.

   This simplifies Phase A considerably: there is no three-way reconciliation.
   The trunk is the production line, upstream merges onto it, and `dev` is
   force-updated from the result for staging verification before prod.

   **Consequence to confirm — 14 dev-only commits are dropped.** They are not on
   the production line and will not survive unless deliberately salvaged:
   credential rotation + usage attribution, credential quota window refresh,
   quota polling throttle, Claude usage CLI fallback (2 commits), outcome engine
   fast execution path, project operating profile onboarding, bundled plugin
   capability validation, issue mentions + mobile header polish, terminal
   interaction test cleanup, and the removal of the legacy delivery truth panel
   from issue detail.

   Most are credential-subsystem fixes, which interacts with open decision 2.
   Nothing regresses by dropping them — production never had them — but they are
   real work that would need rebuilding later if wanted. The delivery-truth-panel
   removal is moot now that the factory hardening is being dropped wholesale.
2. ~~**AI factory hardening.**~~ **Decided 2026-08-08 — drop it.** Over-fits a
   software-delivery pipeline onto all company work. See the MERGE section for
   the full rationale, the delete list, and the one property worth salvaging.
3. ~~**Credentials.**~~ **Decided 2026-08-08 — keep the fork's.** Upstream has no
   proper rotation. The fork's credential subsystem is authoritative; take from
   upstream only what does not conflict (`run-secret-redaction.ts` is the
   obvious additive win). See the credentials entry in KEEP below, including the
   planned preflight-quota upgrade.
4. ~~**Orgs/RBAC.**~~ **Decided 2026-08-08 — keep the fork's.** The fork's
   `project_members` / `org_memberships` model is required and is authoritative.
   Upstream's `resource_memberships` / `principal-access-compatibility` do not
   replace it.

**All four decisions are now settled. Phase A is unblocked.**

---

## Feature roadmap — what actually lands in `dev`

The merge is the vehicle; this is the cargo. Adoption order is deliberate:
small and self-contained first, load-bearing last.

### Adopt from upstream

1. **Runaway guardrails** — `cross-issue-influence-limit`,
   `issue-rewake-throttle`, issue-create idempotency, `invite-rate-limit`.
   First because they are small, isolated, and directly prevent the
   unbounded-creation class that caused the SIX-5887 flood.
2. **Task watchdogs** — opt-in per issue, verification-shaped. The correct
   replacement for the global liveness scanner disabled on 2026-08-06.
3. **Board Concierge Chat** — `POST /board/chat/stream`. Spawns the `claude`
   CLI with the `paperclip-board` skill as system prompt and streams over SSE
   (`start`/`status`/`chunk`/`done`/`error`). Persists to a standing "Board
   Operations" issue so it survives reloads. Emits `%%ACTIONS%%{...}%%/ACTIONS%%`
   signals for the UI observer layer, stripped before persisting. Turns are
   tagged with `</turn` neutralized to prevent history injection via a body
   containing a literal `ASSISTANT:` prefix. Brings `paperclip-board`, the only
   skill upstream has that the fork lacks.
   *Integration seam:* it shells out to the `claude` CLI, so it must be wired
   into the fork's credential/adapter layer rather than upstream's assumptions
   about how `claude` is authenticated. Expect this to be the first real
   integration friction.
4. **Decisions subsystem** — see the dedicated section above.
5. **Cases** — typed records above issues, arbitrary `fields`, own lifecycle.
   The general-purpose primitive the factory policy lacked, and the reason the
   factory policy was rejected: not every work item is dev work.
6. **Attention / status cards / summary slots / work timeline** — supervision at
   scale; `attention.ts` ranks blockers by how much work they hold up.
7. **Tool access governance** — `tool-gateway`, `tool-access-policy`,
   `execution-allowlist`, `source-trust`, low-trust presets. Last, because it is
   load-bearing on upstream's `authorization.ts`, which collides with the fork's
   orgs/RBAC model (see MERGE decision 2) and is the largest semantic merge here.
8. **Smaller additive wins** — OpenAPI surface, teams catalog, built-in agents,
   folders, external objects, smoke lab, `run-secret-redaction.ts`.

### Build new on top

- **Preflight quota gating.** Add a credential-quota block reason to upstream's
  `evaluateAgentInvokability`, backed by the fork's existing
  `credential-quota-cache`, and swap credentials at *selection* time. The run
  never starts against an exhausted credential — no fail-then-failover churn.
  Both halves already exist; this is wiring. Depends on the merge.
- **Delivery authority, re-expressed.** Salvage the one good idea from the
  dropped factory kernel: a CHECK constraint welding source to authority so an
  `agent_submission` can only ever be recorded as an `agent_claim`, never as
  verified truth. Rebuild it against **cases and work products** rather than
  delivery stages, so it covers research, ops and support work — not just
  deploys. Work-type-agnostic anti-hallucination.
- **Salvage the 6 credential commits** from `dev-backup-2026-08-08` onto the
  trunk (rotation + usage attribution, quota window refresh, quota polling
  throttle, Claude usage CLI fallback ×2), now that the fork's credential
  subsystem is confirmed as authoritative.

### Protect during the merge (no build work, just don't lose them)

Live browser stack (upstream has no equivalent at all), credentials with
rotation/failover/quota, orgs/RBAC, Telegram + web-push, image generation, the
seven adapters, both plugins. These are among the 329 files upstream never
touched and should carry cleanly.

---

## Standing hazards

From the 2026-07-28 sessions, all still live:

- Never run `pnpm install` inside a linked worktree.
- The lockfile must be regenerated, not merged.
- `git merge-file` exit codes silently emptied 58 files in one session.
- A dedupe heuristic deleted 1,109 lines of working code.
- Five distinct heuristic failure modes observed; remaining hunks need per-hunk
  reasoning, not automation.
- Rotate the Dokploy API key and the Actions `DOKPLOY_API_KEY`.
