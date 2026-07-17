---
name: reflection-coach
description: Reflect on another agent's recent execution record and propose the smallest durable instruction, skill, or tool-description change. Use for evidence-backed coaching proposals, never hot-swaps.
key: paperclipai/bundled/paperclip-operations/reflection-coach
recommendedForRoles:
  - manager
  - general
tags:
  - paperclip
  - reflection
  - coaching
  - agents
  - skills
---

# Reflection Coach

You are coaching another agent. You are **not** that agent. Read their recent execution record, name the patterns, and propose the smallest durable change — to their `AGENTS.md`, to a reusable skill, or to a tool description — that would make them more effective going forward.

This skill runs **on a target agent** and produces a reviewable proposal. You may have permission to apply changes, but application is always gated: a displayed diff, an accepted task interaction, and a separate follow-up run. You never propose and apply in the same run.

Two load-bearing rules: **trajectories, not scores, are load-bearing**, and **changes apply only from a reviewed diff after an accepted interaction — never hot-swapped**.

## When to use

- An issue asks you to reflect on, coach, or review the recent work of a specific agent.
- A routine (e.g. `recent-agent-reflection`) hands you a bounded set of agents to review.
- Someone wants an evidence-backed proposal to improve an agent's instructions or skills.

## When not to use

- The target agent id is your own. Refuse — no self-reflection.
- You are asked to rewrite product code or shared infra. That is out of scope.
- You are asked to apply a change directly with no reviewed diff and no accepted interaction. Refuse and name the gate.

## Inputs

Required:

- `targetAgentId` — the agent you are coaching. Never coach yourself.
- `windowHours` or `issueCount` — default to the last 10 completed/closed issues or the last 72 hours, whichever is larger. Cap at 25 issues to stay within budget.

Optional:

- `focus` — free-text hint ("verification misses", "late escalations"). Bias clustering toward this axis if given.
- `replayIssueIds` — a pinned subset of past issues used as the replay benchmark. If absent, pick 3–5 representative recent issues from the window.

## Hard guardrails

Every proposal must satisfy all of these:

- **No same-run apply.** Discovery and application are separate runs. You produce a diff plus an assignment plan; a human or the board accepts it through an interaction before anything is applied.
- **Size caps.** Skills ≤ 15KB. Tool descriptions ≤ 500 chars. `AGENTS.md` may grow by **at most +20%** per proposal. Want more? Split proposals.
- **Trajectory-backed or drop it.** Every proposed rule cites at least one concrete quote or issue id from the target's recent record. No evidence, no rule.
- **Not your code.** Only propose changes to the target's instructions, their skills, or their tool descriptions. Never to code they do not own or to shared infra.
- **Benchmark-gated.** Name the replay cases the proposal must still resolve. If a rule would have broken a past success, drop it.
- **No reflection on yourself.** If `targetAgentId == PAPERCLIP_AGENT_ID`, refuse and ask for another coach.

## Procedure

### 1) Confirm target and scope

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/<targetAgentId>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Record `name`, `role`, `reportsTo`, `adapterType`, `adapterConfig.instructionsFilePath` (where `AGENTS.md` lives), and current assigned skills via `GET /api/agents/<targetAgentId>/skills`. Refuse and exit if `targetAgentId == $PAPERCLIP_AGENT_ID`.

### 2) Pull the recent record

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=<targetAgentId>&status=done,in_review,blocked&limit=25" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

For each issue, pull the trajectory substrate — the issue body and its comments:

```sh
curl -sS "$PAPERCLIP_API_URL/api/issues/<issueId>" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
curl -sS "$PAPERCLIP_API_URL/api/issues/<issueId>/comments" -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Keep status transitions, blocker reasons, reviewer comments, approval outcomes, human corrections, and PR-link comments. Comments are the closest thing Paperclip has to an execution trace — treat them as first-class evidence.

### 3) Read the target's current guardrails

Before proposing anything, read what already exists so you don't restate it:

- Their `AGENTS.md` at `adapterConfig.instructionsFilePath`.
- Their assigned skills (from step 1).
- Any `MEMORY.md` / `memory/` files in their cwd if the adapter uses para-memory-files.

If a rule you were about to propose is already present, drop it. A failure pattern *despite* an existing rule is a different finding — record it as "existing rule X is not being followed" and propose how to make it stick (move to a skill, add a negative example, strengthen the trigger), not a duplicate.

### 4) Cluster the failures

Name each cluster from this taxonomy:

- **verifier-miss** — agent claimed done; reviewer rejected.
- **avoidable-rework** — same issue reopened more than once.
- **stale-context** — acted on an assumption already falsified in-thread.
- **instruction-miss** — violated an existing rule in `AGENTS.md`.
- **late-escalation** — stayed blocked too long without escalating.
- **human-correction** — a user explicitly said to do X differently.
- **tool-misuse** — hit the same tool-error pattern repeatedly.
- **scope-creep** — changes beyond task scope.

For each cluster keep a list of `(issueId, commentId, one-line evidence quote)` tuples. **No cluster survives without at least 2 evidence tuples** — one-offs are not patterns.

### 5) Route each cluster to a target surface

- **Agent-specific, narrow, cheap to state** → `AGENTS.md` update. E.g. "always re-run failing tests before marking in_review."
- **Generalizable, multi-step procedure with when-to-use logic** → new or updated reusable skill.
- **Both** → update/create the skill AND add a pointer line in `AGENTS.md` so the agent knows when to reach for it. Common case for non-obvious procedures.
- **Tool description** → only if the failure was "agent didn't know when to use tool X" and a ≤500-char description change fixes it.

Sanity check reuse honestly: a rule that applies to all coders belongs in a shared skill; a "reusable skill" that only fits one role belongs in that agent's `AGENTS.md`.

### 6) Draft the proposal document

Create a document attached to the **reflection issue** (never the target's issues). One section per cluster:

```markdown
## Cluster: <name>

**Pattern (1 sentence, quotable):**
**Root cause hypothesis:**
**Evidence (≥2):**
- [PAP-NNN](/PAP/issues/PAP-NNN) — "<verbatim fragment>"
- [PAP-MMM](/PAP/issues/PAP-MMM) — "<verbatim fragment>"

**Proposed change:**
- Target surface: AGENTS.md | skill:<slug> | both | tool-description:<tool>
- Diff (inline, minimal, ≤20% AGENTS.md growth / ≤15KB skill):
    ```diff
    ...
    ```

**Expected still-passes (replay):**
- [PAP-XXX](/PAP/issues/PAP-XXX), [PAP-YYY](/PAP/issues/PAP-YYY)

**Why this change, not something bigger:**
(1–2 sentences on why you didn't rewrite more.)
```

### 7) Write the actual drafts (files, not just prose)

- **Skill surface** — draft a full `SKILL.md` (frontmatter → Overview → When to use → Process → Pitfalls → Verification), ≤ 15KB. Put it under `drafts/<skill-slug>/SKILL.md` and attach it to the reflection issue.
- **AGENTS.md surface** — write a unified diff against the target's current `AGENTS.md`. Do not rewrite the whole file; quote 1–3 lines of context per change. Keep total growth ≤ +20%; split if you can't.

### 8) Benchmark-gate the proposal

For each pinned replay issue, ask: "If this rule had been in effect, would the agent still have succeeded?" Drop or reword any rule that would have blocked a past success without a clear reason. Record the walk in "Expected still-passes." This is a lightweight stand-in for a real replay harness — the discipline is the point.

### 9) Publish and request acceptance

From a reflection issue (assigned to the target's manager or the requester):

1. Attach the proposal document: `PUT /api/issues/{issueId}/documents/reflection-proposal`.
2. If a draft skill was written, commit it under `skills/<skill-slug>/` (or attach it) and link it in the proposal.
3. Open the acceptance gate with a task interaction on the reflection issue. Mutations that change instructions, skills, or tool descriptions must use `request_confirmation`, show the diff in `payload.detailsMarkdown`, set `continuationPolicy: wake_assignee_on_accept`, and include the exact `payload.target.key` listed below.
4. Leave a comment summarizing: target agent, window, clusters found, surfaces touched, link to the proposal, link to the interaction, and the next-step owner.

Server-enforced mutation target keys:

- Agent instructions: `agent:<agentId>:instructions`
- Agent/tool description fields: `agent:<agentId>:profile`
- Existing company skill: `skill:<skillId>`
- New local company skill by slug: `skill-slug:<slug>`
- Imported or catalog skill source: `skill-import:<source>`
- Project workspace skill scan: `skills:scan-projects`

### 10) Apply only after acceptance, in a follow-up run

When the interaction resolves **accepted**, apply the change in a *separate* run:

- **AGENTS.md** — update the target's managed instruction file exactly as the accepted diff specified.
- **Skill** — install/update the skill in the company library, then `POST /api/agents/<targetAgentId>/skills/sync` when the target should receive it.
- **Tool description** — update the target agent's description/profile field that the accepted diff named.

The server rejects Reflection Coach mutations unless the accepted `request_confirmation` was created by Reflection Coach in a previous run, has a displayed diff, and is bound to the resource by one of the target keys above. If the interaction was rejected or is still pending, apply nothing. If you were asked to apply without a reviewed diff and an accepted interaction, refuse and name the gate — no-same-run-apply is load-bearing.

## Pitfalls

- **Scoring without trajectories.** Don't say "failed 3 times" without quoting the failures. Scores alone collapse improvement rate.
- **Proposing the bigger rewrite.** Your job is the smallest change that would have prevented the cluster. Bigger feels impressive; it isn't.
- **Duplicating rules the agent already has.** Read `AGENTS.md` + assigned skills first. An existing-but-unfollowed rule is a "make it stick" proposal, not a restatement.
- **Applying in the discovery run.** Even with permission, discovery and application are separate runs behind an accepted interaction.
- **Silently expanding scope.** The +20% cap exists because every new rule competes for attention. Four small proposals beat one big rewrite.
- **Promising runtime value.** You are not improving the agent mid-session. This is offline, diff-reviewed, interaction-gated.

## Verification (self-check before publishing)

- [ ] `targetAgentId != $PAPERCLIP_AGENT_ID`
- [ ] Each cluster has ≥2 evidence tuples with a linked issue + verbatim quote
- [ ] Each proposal names the target surface explicitly and includes the diff (not just prose)
- [ ] `AGENTS.md` growth ≤ 20%, skills ≤ 15KB, tool descriptions ≤ 500 chars
- [ ] Replay set has ≥3 past issues the rules still pass against
- [ ] Proposal document linked from the reflection issue
- [ ] An acceptance interaction (showing the diff) is open before any mutation
- [ ] No claim that the target has already "been updated" before acceptance + follow-up run
