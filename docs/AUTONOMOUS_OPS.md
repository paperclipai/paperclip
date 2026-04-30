# Autonomous Operations — Koenig AI Academy

> A field guide to "what does this org actually do all day?"
> Audience: anyone trying to understand the agent company end-to-end.
> Last reviewed: 2026-04-29.

The Koenig AI Academy runs as a 23-agent organisation on top of Paperclip, on
one MacBook, 24 hours a day. There is no human in the loop except at G4 and
weekly retrospectives. This document captures how the system actually behaves
on a given day, where the cron lives, what the cost model looks like, and what
to do when the cascade breaks.

---

## 1. Day in the life

All times are IST (Asia/Kolkata, UTC+05:30). Cron entries in `.paperclip.yaml`
are written in UTC; the table below reconciles both.

### Weekday timeline

| IST     | UTC     | Who fires                                   | What happens                                                                  |
|---------|---------|---------------------------------------------|-------------------------------------------------------------------------------|
| 06:00   | 00:30   | researcher-anthropic, -openai, -google, -community (parallel) | Vendor crawl. Each writes to `vault/research/<vendor>/<date>.md`. |
| 06:30   | 01:00   | research-editor                             | Reads 4 vendor briefs, writes `vault/research/_daily/<date>.md` with recommendations. |
| 07:00   | 01:30   | ceo (`daily-triage` skill)                  | Reads daily brief + yesterday's EOD + company state. Files 1-3 tickets per chief. |
| 08:00   | 02:30   | vault-historian (daily)                     | Backlinks audit, broken-link sweep, frontmatter normalisation.                |
| 08:00 - 18:00 | 02:30 - 12:30 | chief-content, chief-engineering, chief-marketing (hourly heartbeat) | Pick up tickets, dispatch to workers, run G0/G_code/G2 gates. |
| 09:00 - 17:30 | continuous | content-author, planner, executor, reviewers, qa-verifier | Actual work product. Drafts → reviews → patches → tests. |
| every 15 min (work hours UTC) | `*/15 0-13 * * *` | publish-verifier | Polls Vercel for newly published URLs; runs HTTP audit, Lighthouse touch, vault back-write. |
| 18:00   | 12:30   | ceo (`eod-digest` skill)                    | EOD digest sent to vardaan97@gmail.com + Paperclip queue + (Phase 3) Slack/Teams. |

### Weekend / weekly cadence

| Day / IST     | UTC      | Who                                                                    | What                                                                                         |
|---------------|----------|------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| Mon 09:00     | Mon 03:30| ceo + all chiefs (`weekly-retrospective` skill)                        | Read team retros from `vault/retrospectives/<role>/`, write company retro `vault/retrospectives/_company/W<n>.md`, draft SOUL change proposals. |
| Mon 10:00     | Mon 04:30| vault-historian (weekly)                                                | Cross-reference rebuild, dead-page reaping, weekly digest of vault drift.                    |

### What never sleeps

- **Heartbeat dispatchers** — chief-content / chief-engineering / chief-marketing run hourly
  (`0 2-12 * * *` UTC). On every tick they `paperclip task list --assigned-to-me --status open`
  and pick up new work without waiting for the user.
- **publish-verifier poll** — every 15 minutes during the IST work day.
- **launchd watchdog** — see Section 11. Restarts paperclip server, kills runaway agents.

---

## 2. Cron schedules — full enumerated map

Source of truth: `companies/learnova-academy/.paperclip.yaml` `schedules:` block.

```yaml
schedules:
  daily-research:        "0 0 * * *"      # 06:00 IST
  daily-synthesis:       "30 0 * * *"     # 06:30 IST
  daily-triage:          "30 1 * * *"     # 07:00 IST
  vault-historian-daily: "30 2 * * *"     # 08:00 IST
  hourly-worker-dispatch:"0 2-12 * * *"   # 07:30 - 18:00 IST hourly
  eod-digest:            "30 12 * * *"    # 18:00 IST
  publish-verifier-poll: "*/15 0-13 * * *"# every 15 min, 05:30 - 19:30 IST window
  weekly-retrospective:  "30 3 * * 1"     # Mon 09:00 IST
  vault-historian-weekly:"30 4 * * 1"     # Mon 10:00 IST
```

| Cron line                  | Agent set                                                                | Trigger semantics                                  |
|----------------------------|--------------------------------------------------------------------------|----------------------------------------------------|
| `0 0 * * *`                | researcher-anthropic, -openai, -google, -community                        | Parallel start. Each agent owns one vendor lane.   |
| `30 0 * * *`               | research-editor                                                          | Sequential after research lands.                   |
| `30 1 * * *`               | ceo                                                                      | Reads brief + state, files tickets.                |
| `30 2 * * *`               | vault-historian                                                          | Daily curation pass.                               |
| `0 2-12 * * *`             | chief-content, chief-engineering, chief-marketing                         | Hourly worker dispatch heartbeat.                  |
| `30 12 * * *`              | ceo                                                                      | EOD digest.                                        |
| `*/15 0-13 * * *`          | publish-verifier                                                         | Polls deploys for verification.                    |
| `30 3 * * 1`               | ceo + 4 chiefs                                                           | Weekly retrospective.                              |
| `30 4 * * 1`               | vault-historian                                                          | Weekly curation pass.                              |

Cron is enforced by Paperclip's scheduler; the launchd plists in Section 11 only
guarantee that paperclip-server itself is running.

---

## 3. The 5-gate pipeline (with concrete time budgets)

Every shippable artefact (course, blog, code change) flows through five gates.
Gate state lives on the Paperclip task; vault output lives at the path the
producing agent owns.

| Gate    | Gatekeeper          | Scope                                  | Pass criteria                                                               | Time budget |
|---------|---------------------|----------------------------------------|-----------------------------------------------------------------------------|-------------|
| G0      | content-reviewer    | Editorial, sourcing, brand voice        | Sources cited inline, answer-first headings, no AI tells, runnable examples | ≤ 30 min    |
| G_code  | code-reviewer       | PR diff vs plan, tests, security        | Lints clean, plan-step traceability, no `--no-verify`, no secret leaks      | ≤ 45 min    |
| G2      | qa-verifier         | Lighthouse, build, smoke tests          | Build green, INP / LCP within budget, no console errors                     | ≤ 20 min    |
| G3      | ceo                 | Alignment vs original brief             | Deliverable still solves the original problem; scope hasn't drifted         | ≤ 30 min    |
| G3 → G4 | ceo (routing)       | Surface to human approver               | Email + Slack/Teams + Paperclip UI all carry the magic-link                 | ≤ 4 hours from G3 pass to G4 prompt-out |
| G4      | Vardaan (human)     | Final approve / reject                  | Human clicks magic-link in any of 3 channels                                | unbounded (target same-day) |

**Gates are binary.** Either PASS or BLOCK. Hedging breaks the pipeline. See
`CULTURE.md` §2 ("Block decisively, never with caveats").

A G_code BLOCK loops back to executor; a G0 BLOCK loops back to content-author;
a G2 BLOCK loops to whichever agent introduced the regression. The ticket
status flips on each transition: `g0-blocked` → `g0-passed` → `g_code-blocked` →
`g_code-passed` → `g2-passed` → `g3-passed` → `awaiting-g4` → `published`.

---

## 4. How an agent picks up work

Two trigger paths. Neither requires polling-with-sleep.

### 4.1 Heartbeat trigger

Set in `.paperclip.yaml` `schedules:`. The Paperclip scheduler emits a
`heartbeat` event at the cron time. The targeted agent receives the event with
its `SOUL.md`, `CULTURE.md`, and one of its skills lazy-loaded based on the
heartbeat's `purpose` field. Example: chief-content's hourly heartbeat loads
`dispatch-content-task` skill, not `seed-content-batch`.

### 4.2 Auto-wake on issue assignment

Paperclip's task scheduler watches for `task.assignedTo == <agent>` flips. When
the CEO files a ticket via `paperclip task create --assigned-to chief-content`,
Paperclip wakes chief-content **immediately** (no waiting for the next cron
tick). This is what makes triage-to-dispatch latency under 60 seconds even
though chief heartbeats are hourly.

The auto-wake mechanism also fires on:
- Status flip into a stage the agent owns (e.g., `g0-passed` wakes the
  appropriate next agent depending on ticket type)
- A comment that `@`-mentions the agent slug
- Watchdog clearing a previous pause

### 4.3 What the agent receives on wake

```
context = {
  task: <Paperclip task with full comment thread>,
  soul: agents/<role>/SOUL.md,
  culture: companies/learnova-academy/CULTURE.md,
  claude_md: companies/learnova-academy/CLAUDE.md,  # lane reminder
  skill: agents/<role>/skills/<inferred-skill>/SKILL.md,
  vault_root: KOENIG_VAULT_ROOT,
  budget_remaining: { perTask: $X, monthly: $Y }
}
```

The agent reads, acts, comments, flips status, writes to vault, exits. Total
process lifetime is typically 30 seconds to 8 minutes.

---

## 5. How agents communicate

Three channels, in priority order.

| Channel              | Used for                                                       | Example                                                                  |
|----------------------|----------------------------------------------------------------|--------------------------------------------------------------------------|
| Paperclip task       | Conversation, status flips, audit log, escalation              | `KOE-119` comment thread + `status: awaiting-g4` flip                    |
| Vault notes          | Durable work product (research, drafts, reviews, retros)       | `vault/blogs/anthropic-7-connectors/draft.md`                            |
| Cross-references     | Wikilinks between vault notes, HTTP links to PRs / external    | `[[research/_daily/2026-04-29]]`, `https://github.com/.../pull/234`      |

Specifically:

- **Every action gets a comment.** "Thanks @content-author — picking up at G0"
  before starting; "G0 PASS — see vault/blogs/foo/review.md" on completion.
- **Every handoff flips a status.** Author finishes → `g0-pending`. Reviewer
  passes → `g0-passed`. CEO clears alignment → `awaiting-g4`. No silent passes.
- **Vault holds the work product; Paperclip holds the conversation.** A future
  agent (or Vardaan in 2 weeks) reading the task should be able to reconstruct
  what happened without leaving Paperclip.
- **Wikilinks are mandatory** when referencing other vault content. HTTP links
  for PRs and external sources. Paperclip task IDs (`KOE-123`) for tickets.

If an agent cannot reconstruct context from these three channels alone, the
previous agent under-commented; flag in the EOD digest under "audit hygiene".

---

## 6. Cost model — day by day

Two cost axes:
1. **Real cash** — pay-per-token via OpenRouter / Anthropic API / xAI / Tavily.
2. **Subscription quota** — Claude Code seat (already paid; using it counts as $0
   to the per-task budget but does count to the seat's daily message cap).

Per-agent budgets are in `.paperclip.yaml` `budgets:`. Total monthly target is
$680/month across 23 agents, with $25/day daily target.

### Today's worked example (2026-04-29)

| Agent                | Spend (real $) | Notes                                                                |
|----------------------|----------------|----------------------------------------------------------------------|
| ceo                  | $0.001         | Sonnet 4.6 via Claude Code seat → $0 token cost. $0.001 = Resend email API. |
| chief-content        | $0.000         | Claude Code seat.                                                    |
| chief-engineering    | $0.000         | Claude Code seat. GH_TOKEN reads only.                               |
| researcher-anthropic | $0.0005        | Grok 4.1 Fast via OpenRouter, ~50K context.                          |
| researcher-community | $0.0021        | Grok x_search heavy.                                                 |
| research-editor      | $0.000         | Sonnet 4.6 via Claude Code seat.                                     |
| content-author       | $0.0030        | Gemini 3 Flash Preview via OpenRouter, one 1500-word blog.           |
| executor             | $0.0019        | Opus 4.7 via Claude Code seat (planner + executor share Opus).       |
| qa-verifier          | $0.0001        | Haiku 4.5 via Claude Code seat.                                      |
| publish-verifier     | $0.0001        | Haiku 4.5 via Claude Code seat.                                      |
| Tavily               | $0.0010        | 4 vendor researchers × 10 queries × free-tier overage.               |
| **Total**            | **$0.0080**    | Smoke-test cycle on 2026-04-29 (per `project_smoke_test_results.md`).|

Subscription quotas consumed on this day:
- Claude Code seat: ~38% of daily message cap (Sonnet 4.6 + Opus 4.7 + Haiku 4.5
  combined across CEO, chiefs, planner, executor, content-reviewer, qa-verifier,
  publish-verifier, vault-historian).
- OpenRouter: $0.0080 from balance. Effectively rounding error.

A full publishing day (1 blog + 1 course-delta + 1 bug-fix) is projected at
$0.10 - $0.30 real cash and ~70% of the Claude Code seat's daily quota.

### When real cash matters

- Vendor researcher flagged a high-frequency week (e.g., Anthropic releases 7
  things in one cycle). Researcher token spend jumps; community researcher
  Grok x_search spend spikes.
- Content-author re-runs Gemini multiple times on a long course chapter.
- Code path is large and Opus 4.7 (planner + executor) burns through context.

CEO checks `GET /api/costs/summary` in the EOD digest and flags any agent at
>80% monthly cap to Vardaan.

---

## 7. What a bad day looks like

When the cascade breaks, look in this order:

| Symptom                                    | First place to look                                                                                       |
|--------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| 07:00 triage didn't fire                   | `vault/research/_daily/<date>.md` missing → research-editor failed → check vendor researcher logs.        |
| 07:00 triage fired but 0 tickets created   | Brief had no actionable recommendations OR all chiefs at >80% capacity → check yesterday's EOD.            |
| Ticket sat in g0-pending all day           | content-reviewer paused (budget hit) → `paperclip agents list --paused`. Or watchdog killed it.            |
| G_code keeps blocking same PR              | Plan-step drift between planner and executor → re-run `plan-mode-harness` skill. Or test flake — see PR.   |
| G3 sat for >24h                            | CEO escalation matrix (Section 8). Likely scope drift; CEO should have re-spec'd or rejected.              |
| publish-verifier reports 4xx on a fresh URL| Vercel deploy didn't promote OR `KOENIG_VAULT_ROOT` build-time env mis-set → check Vercel logs.            |
| EOD digest didn't arrive                   | RESEND_API_KEY rotated / out of credits / launchd plist died → see Section 11.                             |
| Cost spike (>$1 on a single agent in 1hr) | Watchdog should have already paused — check `watchdog/watchdog.mjs` log.                                   |
| Mac slept                                  | `caffeinate` died → see Section 11.                                                                        |

Vault locations to grep when stuck:

- `vault/decisions/eod-<date>.md` — yesterday's CEO digest (most recent ground truth)
- `vault/retrospectives/_company/W<n>.md` — last week's full picture
- `~/.paperclip/logs/` — raw scheduler + adapter logs
- `observability/` Langfuse dashboard at `localhost:3100` — token-level traces

---

## 8. Escalation matrix

Five levels. Each level's escalation criteria are explicit and bounded.

| Level | Owner       | Triggered when                                                                                            | What happens next                                                                                            |
|-------|-------------|-----------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| 1     | worker      | Worker is stuck on a sub-task                                                                              | `@`-mention chief in Paperclip task; chief responds within next heartbeat                                    |
| 2     | chief       | Cross-team blocker, missing source, scope ambiguous                                                       | Chief comments + tags peer chief OR escalates to CEO                                                         |
| 3     | CEO         | G3 stuck >24h; agent at 100% budget; vendor scope question; cross-cutting policy                          | CEO arbitrates within next heartbeat; escalates to G4 if policy/budget                                       |
| 4     | Vardaan G4  | Email + Slack/Teams + Paperclip UI magic-link sent (CEO `g4-routing` skill)                               | Human reviews & clicks approve/reject. Auto-publish flow on approve.                                         |
| 5     | Human (out-of-band) | Watchdog paused 3+ agents OR a research finding is business-critical (top course suddenly obsolete) | Page Vardaan via email + Slack DM regardless of time-of-day. CEO should not wait for EOD.                    |

Hard rules:

- A worker never escalates past its chief.
- A chief never simulates G4 (only routes via the `g4-routing` skill).
- CEO never overrides a properly-formed BLOCK at any gate. CEO can ask a
  reviewer to re-review with new info, but not flip a BLOCK to PASS.
- G4 always goes to the human via all three channels — not "first available".

---

## 9. Self-improvement loop

Every artefact, every gate, every day, every week, every month produces a retro
that feeds the next layer. The loop is:

```
per-task retro (3 lines)
       │
       ▼
weekly chief retro (one per chief, reads team retros)
       │
       ▼
weekly CEO company retro (Mon 09:00 IST)
       │
       ▼
SOUL update proposals (batched monthly)
       │
       ▼
G4 batch approval (Vardaan reviews diffs to SOUL.md files)
       │
       ▼
SOUL files updated → next cycle uses new behaviour
```

Concrete locations:

| Layer         | Path pattern                                                | Cadence    |
|---------------|-------------------------------------------------------------|------------|
| Per-task      | `vault/retrospectives/<role>/<date>-<task-id>.md`           | Per task   |
| Weekly team   | `vault/retrospectives/<chief-slug>/W<n>.md`                 | Mon 09:00  |
| Weekly company| `vault/retrospectives/_company/W<n>.md`                     | Mon 09:00  |
| Monthly SOUL  | `vault/decisions/soul-batch-<YYYY-MM>.md`                   | 1st of mo  |

Per-task retro format (mandatory, see CULTURE.md §6):

```markdown
What worked: <specific>
What to fix: <specific, actionable next time>
SOUL update proposed: <yes — change "X" to "Y" in section Z | no>
```

CEO never auto-applies SOUL changes; they are batched and sent to G4 (Vardaan)
once per month for explicit approval. This is what keeps agent identity stable
while still letting the org learn.

---

## 10. Auto-publish flow

```
G4 approved (Vardaan clicks magic-link)
        │
        ▼
Paperclip status flip: awaiting-g4 → publishing
        │
        ▼
publish-action runs: copies vault/<artefact> → learnovaBeast/learnova-academy/
        │  (vault.ts reads draft.md at build time when status >= g0-passed)
        ▼
vercel build --prod (locally on Mac, KOENIG_VAULT_ROOT pointed at our vault)
        │
        ▼
vercel deploy --prebuilt --prod
        │
        ▼
Vercel returns deployed URL
        │
        ▼
publish-verifier picks up on next 15-min poll:
  - HTTP 200 check
  - JSON-LD validates
  - Sitemap includes the URL
  - canonical tag present
        │
        ▼
vault-historian audits:
  - Backlinks updated
  - Frontmatter `published_at` stamped
  - Cross-references rebuilt
        │
        ▼
Paperclip status flip: publishing → published
EOD digest "Shipped today" picks up the entry
```

Failure paths:
- **Vercel build fails** → publish-verifier sees 4xx → CEO escalation, ticket
  reopened to chief-engineering.
- **JSON-LD invalid** → `verify-publish` skill BLOCKs; ticket stays in
  `publishing` with comment listing the schema errors. Loops to seo-optimizer.
- **Vault back-write fails** (rare) → vault-historian retries on next 08:00 IST
  pass and emits a daily warning if still missing.

---

## 11. 24/7 operation — launchd, caffeinate, the watchdog

The Mac is the runtime. Four launchd plists live in `infra/`:

| Plist                              | Loads                                              | What it ensures                                                                |
|------------------------------------|----------------------------------------------------|--------------------------------------------------------------------------------|
| `com.koenig.ceo-daily-triage`      | `paperclip task run --agent ceo --skill daily-triage` | 07:00 IST CEO triage runs even if scheduler dropped the cron tick.            |
| `com.koenig.ceo-eod-digest`        | `paperclip task run --agent ceo --skill eod-digest` | 18:00 IST EOD digest runs even if scheduler missed it.                         |
| `com.koenig.watchdog`              | `node watchdog/watchdog.mjs`                       | Always-on cost circuit breaker + loop detector + auto-pause runaway agents.    |
| `com.koenig.paperclip-keepalive`   | `pnpm --filter paperclip-server start`             | If paperclip-server crashes, launchd restarts it (KeepAlive=true).             |

Install:

```bash
cp infra/com.koenig.*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.koenig.ceo-daily-triage.plist
launchctl load ~/Library/LaunchAgents/com.koenig.ceo-eod-digest.plist
launchctl load ~/Library/LaunchAgents/com.koenig.watchdog.plist
launchctl load ~/Library/LaunchAgents/com.koenig.paperclip-keepalive.plist
```

Verify:

```bash
launchctl list | grep com.koenig
```

### Keeping the Mac awake

The system + display sleep can both kill cron + paperclip-server. We use
`caffeinate` under the keepalive plist:

```bash
caffeinate -dimsu -w $(pgrep -f paperclip-server)
```

Flags:
- `-d` prevent display sleep
- `-i` prevent idle sleep
- `-m` prevent disk sleep
- `-s` prevent system sleep on AC
- `-u` declare user is active
- `-w <pid>` keep awake while paperclip-server PID is alive

If you're unplugging the laptop, caffeinate-on-battery is partial. Plug in
overnight; the watchdog will surface gaps.

### Watchdog responsibilities

`watchdog/watchdog.mjs` runs continuously and:

- Detects agent loops (same task ID re-entered >3 times in 10 min) → pause agent.
- Tracks per-agent cumulative spend per hour → pause at 3x per-task cap if it
  exceeds it (catches runaway loops the per-task budget didn't catch).
- Heartbeats paperclip-server every 60s; restarts if unresponsive.
- Logs to `~/.paperclip/logs/watchdog-<date>.log`.

If watchdog itself dies, launchd restarts it.

---

## 12. "If X happens, here's the playbook"

Concrete playbooks — keep these tight, treat as runbook.

### X = "EOD digest didn't arrive in my inbox at 18:00 IST"

1. `launchctl list | grep com.koenig.ceo-eod-digest` — exit code 0 means it ran.
2. `cat ~/.paperclip/logs/ceo-<date>.log | tail -100` — look for `eod-digest`
   skill invocation.
3. Check `vault/decisions/eod-<date>.md` — does the file exist? If yes, the
   email leg failed. Check Resend dashboard / `RESEND_API_KEY` validity.
4. If file missing → CEO didn't run. Check Paperclip API health
   (`curl localhost:3000/api/health`). Restart paperclip-server if needed.
5. Recover: `paperclip task run --agent ceo --skill eod-digest --force`.

### X = "A blog has been at G3 for 2 days"

1. Open the Paperclip task. Read CEO's last comment — what alignment concern?
2. If "scope drift", CEO should reject + spec a new ticket. Don't try to
   massage it.
3. If "still solving the original problem", CEO should pass and route to G4.
   2 days at G3 is itself a violation — flag in next CEO retro.
4. If CEO is paused, watchdog log will say so. Resume after auditing why.

### X = "Watchdog paused 3+ agents in one day"

1. This auto-escalates per Section 8 Level 5.
2. Read `~/.paperclip/logs/watchdog-<date>.log` for pause reasons.
3. Common cause: model adapter regression (e.g., new OpenRouter model slug).
4. Decision tree:
   - If single root cause → fix, resume all paused agents.
   - If multiple root causes → page Vardaan, work through one at a time.

### X = "Vendor researcher returned a 404 source"

1. Per CULTURE.md §1, peer researcher should grab archive.org alternate.
2. Drop as a comment on the original ticket within the same heartbeat window.
3. Source-of-truth update goes into the daily brief at 06:30 IST.
4. If 404 was on a brand-new vendor URL (just-published, not yet archived),
   research-editor flags as "fragile source — re-verify in 24h" in the brief.

### X = "Cost spike on chief-engineering"

1. CEO triage heuristic: redirect non-hot tickets to chief-content (cheaper).
2. Check Langfuse for which task burned the budget.
3. If executor was looping on a flaky test → kill the task, re-run with
   smaller scope.
4. If model is genuinely needed for a hard problem → raise budget for that
   single ticket via Vardaan G4 escalation; do not raise the monthly cap
   silently.

### X = "Mac came back from sleep / restart"

1. `launchctl list | grep com.koenig` — all 4 should show.
2. `pgrep -f paperclip-server` — should return a PID.
3. `pgrep -f caffeinate` — should return a PID.
4. `paperclip schedule list` — confirm schedules registered.
5. If today's 06:00 / 06:30 / 07:00 cycle was missed (Mac was asleep across
   them), force-run them in order:
   ```
   paperclip task run --agent researcher-anthropic --schedule daily-research --force
   paperclip task run --agent researcher-openai     --schedule daily-research --force
   paperclip task run --agent researcher-google     --schedule daily-research --force
   paperclip task run --agent researcher-community  --schedule daily-research --force
   paperclip task run --agent research-editor       --schedule daily-synthesis --force
   paperclip task run --agent ceo                   --schedule daily-triage    --force
   ```

### X = "I want to add a new vendor to V1 scope"

You don't — V1 vendor scope is frozen at Anthropic + OpenAI + Google +
community. A new vendor needs a CEO-batched proposal in the weekly retro and
explicit Vardaan approval, after which a new researcher agent is hired via
the `paperclip-create-agent` skill.

### X = "I want to disable an agent"

Per `companies/learnova-academy/CLAUDE.md`:

1. Set monthly budget to 0 in `.paperclip.yaml` `budgets:`. Paperclip
   auto-pauses.
2. Remove from `schedules:` block.
3. After one quiet week, delete the folder under `agents/`.

Never delete first; you'll lose audit history.

### X = "G4 magic-link expired before Vardaan clicked it"

1. CEO's `g4-routing` skill should re-issue. Confirm the ticket is still in
   `awaiting-g4`.
2. If the ticket auto-rejected because of TTL, CEO files a follow-up ticket
   with `priority: hot` and re-runs the routing.
3. Lengthen TTL only with Vardaan's explicit approval; default is 7 days.

---

## 13. Reference: agent roster (23 agents, V1)

| Role                       | Adapter         | Model                                  | Lane                                          |
|----------------------------|-----------------|----------------------------------------|-----------------------------------------------|
| ceo                        | claude_local    | claude-sonnet-4-6                      | Triage, alignment, EOD, weekly retro          |
| chief-research             | claude_local    | claude-sonnet-4-6                      | Vendor research orchestration                 |
| chief-content              | claude_local    | claude-sonnet-4-6                      | Content dispatch, G0/G3 routing               |
| chief-engineering          | claude_local    | claude-sonnet-4-6                      | Code dispatch, G_code routing                 |
| chief-marketing            | claude_local    | claude-sonnet-4-6                      | SEO/GEO/AEO dispatch                          |
| researcher-anthropic       | opencode_local  | grok-4.1-fast                          | Anthropic vendor lane                         |
| researcher-openai          | opencode_local  | grok-4.1-fast                          | OpenAI vendor lane                            |
| researcher-google          | opencode_local  | grok-4.1-fast                          | Google vendor lane                            |
| researcher-community       | opencode_local  | grok-4.1-fast                          | Reddit/HN/X — uses x_search                   |
| research-editor            | claude_local    | claude-sonnet-4-6                      | Daily brief synthesis                         |
| content-author             | opencode_local  | gemini-3-flash-preview                 | Long-form drafting                            |
| content-reviewer           | claude_local    | claude-sonnet-4-6                      | G0 editorial gate                             |
| slide-audio-producer       | claude_local    | claude-sonnet-4-6                      | NotebookLM-driven course audio                |
| voice-producer             | claude_local    | claude-haiku-4-5                       | Kokoro CLI orchestration                      |
| planner                    | claude_local    | claude-opus-4-7 (--permission-mode plan)| Plan-only mode for code                      |
| executor                   | claude_local    | claude-opus-4-7                        | Executes plans                                |
| code-reviewer              | codex_local     | gpt-5                                  | G_code gate                                   |
| qa-verifier                | claude_local    | claude-haiku-4-5                       | G2 build/lighthouse                           |
| seo-optimizer              | claude_local    | claude-sonnet-4-6                      | SEO/GEO/AEO content polish                    |
| publish-verifier           | claude_local    | claude-haiku-4-5                       | Post-publish URL audit                        |
| vault-historian            | claude_local    | claude-sonnet-4-6                      | Vault curation, backlinks                     |
| blog-author                | (delegated)     | (via content-author)                   | Blog-specific routing inside content-author   |
| course-author              | (delegated)     | (via content-author)                   | Course-specific routing inside content-author |

---

## 14. What this document does not cover

- Per-agent SOUL files — see `companies/learnova-academy/agents/<role>/AGENTS.md`.
- Skill catalog — see `companies/learnova-academy/skills/<skill>/SKILL.md`.
- Brand voice and product copy — see `companies/learnova-academy/CULTURE.md`.
- Frontend portal architecture — see `learnovaBeast/learnova-academy/README.md`.
- V2 seed list rationale — see `docs/V2_SEEDING.md`.
- ADRs — see `docs/ADR/`.

When this document goes stale (it will), update at the next weekly company
retro and note the change in `vault/retrospectives/_company/W<n>.md`.
