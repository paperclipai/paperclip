# PR Reviewer — trigger wiring spec

**Status:** spec / not yet built · **Owner lane:** runtime/engineer · **Date:** 2026-06-09

A CodeRabbit-style agent that reviews every pull request. This documents how a GitHub
PR event wakes the reviewer. **The good news: it needs no new infrastructure** — the
platform already has first-class webhook→routine→issue→agent plumbing, including a built-in
`github_hmac` signing mode. The reviewer is a *configuration* on top of that, plus the agent
itself.

---

## ⚠️ Prerequisite (decide first)

**Today the team pushes directly to `rebrand/valadrien-os` — there is no PR-based workflow.**
Every production deploy in the history is a direct commit to the branch; "PR #1" is just the
branch's tracking PR. **A "review every PR" agent has nothing to review until work moves to a
feature-branch → PR → review → merge flow.** So the real first step is a process decision, not
code:

- **Option A — adopt PRs for ValAdrien OS now.** Sol/Bati branch, open PRs, the reviewer
  comments, then merge. This is what makes the reviewer valuable, and it's the natural pairing
  with adding a second engineer (more hands = more need for review gating).
- **Option B — keep direct-to-branch for now, build the reviewer dormant.** Wire it but get no
  signal until PRs start. Not recommended — you'd be building ahead of need.

The rest of this spec assumes Option A (or that PRs will exist).

---

## Architecture (rides on existing machinery)

```
GitHub PR event ──HTTPS POST──▶  os.valadrien.dev (Vercel control plane)
  (pull_request: opened/         POST /api/routine-triggers/public/{publicId}/fire
   reopened/synchronize)         · X-Hub-Signature-256 (HMAC-SHA256 over raw body)
                                 · firePublicTrigger() verifies sig (github_hmac mode)
                                          │
                                          ▼
                                 dispatchRoutineRun(source:"webhook")
                                 · stores full GitHub payload → routine_runs.trigger_payload
                                 · creates a todo ISSUE assigned to the Reviewer agent
                                 · concurrencyPolicy:"coalesce_if_active" collapses rapid
                                   re-pushes into the live review issue
                                          │
                                          ▼
                                 Railway worker auto-dispatches the assigned todo issue
                                 (invocation_source:"assignment" — same path Sol/Bati use)
                                          │
                                          ▼
                                 Reviewer agent run: read diff → review → post → done
```

Every box except the agent + the routine/trigger config already exists and is tested:
- Webhook receiver: `server/src/routes/routines.ts` → `POST /routine-triggers/public/:publicId/fire`
  (mounted under `/api`; `rawBody` captured globally in `app.ts` for HMAC).
- Signature verify: `firePublicTrigger` in `server/src/services/routines.ts` — `github_hmac`
  computes `HMAC_SHA256(secret, rawBody)` and timing-safe-compares `X-Hub-Signature-256`.
- Dispatch → issue: `dispatchRoutineRun` creates a `todo` issue from the routine template
  (`routines` table = title/description/assigneeAgentId/variables/priority), stores
  `trigger_payload`, links it on `routine_runs.linked_issue_id`.
- Worker dispatch: the always-on Railway `valadrien_staff` worker picks up the assigned `todo`
  issue (no heartbeat needed — engineers/reviewers wake on assignment).

---

## The five things to create

### 1. The Reviewer agent
Seed exactly like Sol/Bati (DB `agents` row + managed instruction bundle on the Railway volume;
both required — heartbeat resolver doesn't recover from disk).
- **Name:** suggest `Korije` (Kreyòl "to correct / set right") — matches Ti Claude / Sol / Veye / Bati.
- **role:** `qa` (closest existing role; label "QA") **or** `engineer`. `qa` reads better as a
  reviewer; pick one.
- **reports_to:** Ti Claude (`aa8911e3…`). **company:** ValAdrien.DEV (`e8a1e79f…`).
- **adapter:** `claude_local`, external bundle + a `cwd` lab (sibling to sol/bati labs) so it can
  `git`/`gh` and fetch diffs.
- **heartbeat:** DISABLED (`enabled:false`) — it wakes only via the assigned review issue.
  `wakeOnDemand:true`.
- **model:** Sonnet (`claude-sonnet-4-6`) is the right tier — review is reasoning-heavy but
  bounded per PR; Opus is justifiable for high-stakes repos, Haiku is too weak for judgment.
  Cost is bounded by PR volume (event-driven), not a polling cadence.
- **run guards:** `timeoutSec:600`, `maxTurnsPerRun:80`, `graceSec:30`, `dangerouslySkipPermissions:true`.
- **autonomy = ADVISORY ONLY (hard rule in instructions):** it comments a review; it NEVER
  approves/merges/closes PRs, never pushes commits, never changes CI/branch protection. Same
  forbidden-list as the other agents (no prod, no secrets, no destructive ops).

### 2. The webhook secret
Create a company secret (random 32+ byte hex) — the GitHub webhook shared secret. Stored in
`company_secrets`; the trigger references it via `routine_triggers.secret_id`.

### 3. The Routine (the review issue template)
`POST /api/companies/{companyId}/routines` (or seed via `routineService`). Fields:
- **title:** `Review PR #{{number}} ({{action}})` — `number` and `action` are top-level GitHub
  payload keys, so they resolve as routine variables directly.
- **assigneeAgentId:** the Reviewer agent.
- **priority:** `medium`. **status:** `active`.
- **concurrencyPolicy:** `coalesce_if_active` (default) — a burst of `synchronize` events on the
  same PR collapses into the one open review issue instead of spawning duplicates.
- **variables:** define the flat fields you want interpolated into the title/body:
  `number` (PR number), `action` (opened/synchronize/reopened). (See "Payload → agent" for the
  nested fields like the diff URL.)
- **description (the prompt the agent gets):** instruct it to review PR #{{number}} on
  `ValDola-stack/valadrien-os`, read the full PR payload from the linked routine run for the diff
  URL / head SHA / base ref, fetch the diff, and post an advisory review. Keep the durable review
  rubric in the agent's instruction bundle, not the routine body.

### 4. The webhook trigger
`POST /api/routines/{id}/triggers` with:
- **kind:** `webhook` · **signingMode:** `github_hmac` · **secretId:** the secret from step 2 ·
  **enabled:** true.
- Response yields a **`publicId`** → the receive URL is
  `https://os.valadrien.dev/api/routine-triggers/public/{publicId}/fire`.

### 5. The GitHub repo webhook
On `ValDola-stack/valadrien-os` → Settings → Webhooks → Add:
- **Payload URL:** the fire URL from step 4.
- **Content type:** `application/json`.
- **Secret:** the same secret value from step 2.
- **Events:** **only** "Pull requests" (GitHub-side event filtering — keeps non-PR noise out).
- The agent still guards on `action` (review only `opened`/`reopened`/`synchronize`; cheap-exit on
  `closed`/`labeled`/etc.).

---

## Payload → agent (getting the nested PR fields)

`firePublicTrigger` stores the **entire** GitHub payload on `routine_runs.trigger_payload`, and
the created issue links back via `origin_run_id`. Routine variable interpolation only resolves
**top-level** payload keys (`number`, `action`) — GitHub nests the useful bits
(`pull_request.diff_url`, `pull_request.head.sha`, `pull_request.base.ref`,
`repository.full_name`).

**Recommended (no extra infra):** the agent reads the full payload from the linked routine run
(it has API/DB access) for the nested fields, using `number`/`action` from the title for quick
context. Document the exact path in the agent's instructions.

**Alternative (only if needed):** a thin transform fn in front of the fire URL that flattens the
fields and re-POSTs — more infra; avoid for v1.

The diff itself: `ValDola-stack/valadrien-os` is a **public** repo, so `pull_request.diff_url` /
`patch_url` are fetchable with no token (`curl`), or `gh pr diff {number}` if `gh` is authed on
the worker.

---

## Posting the review back — two tiers

- **v1 (no GitHub token needed):** the reviewer records its review as a comment on the OS review
  issue and marks it `done`. Always works; visible in the OS. Good enough to prove the loop.
- **v2 (needs a token with PR write):** also post the review as a comment on the GitHub PR via
  `gh pr comment {number} --body …` or the REST API. Requires a PAT or GitHub App token on the
  worker (`GH_TOKEN`). This is the CodeRabbit-on-the-PR experience. Add once v1 is proven.

---

## Guards & edge cases
- **Action filter:** GitHub-side (PR events only) + agent-side (`opened`/`reopened`/`synchronize`
  only). Cheap-exit otherwise.
- **Rapid re-pushes:** `coalesce_if_active` already collapses them; the agent re-reads the latest
  diff for the head SHA in the coalesced issue.
- **Idempotency:** GitHub sends `X-GitHub-Delivery` (unique) but NOT the `idempotency-key` header
  the fire endpoint reads, so dedup relies on the coalesce policy, not idempotency keys. Fine for
  v1; if redeliveries become an issue, map delivery id → idempotency-key via a transform.
- **Recursion:** the reviewer must never push commits, so it can't trigger new PR events. Hard
  rule in instructions.
- **Bot PRs / its own activity:** guard on `sender`/author if Sol/Bati open the PRs — review them
  normally; just don't loop.

---

## Implementation checklist (when greenlit)
1. Decide the PR-workflow prerequisite (Option A above).
2. Seed the Reviewer agent (DB row + bundle + lab + chown), heartbeat disabled, advisory-only
   instructions + review rubric.
3. Create the company secret (webhook HMAC).
4. Create the routine (issue template, assigned to the reviewer, `coalesce_if_active`).
5. Add the `webhook`/`github_hmac` trigger → capture the `publicId`.
6. Configure the GitHub repo webhook (Pull requests only, the secret, the fire URL).
7. Validate: open a throwaway PR → confirm fire (202) → routine run → assigned issue → worker
   dispatch → reviewer posts a review → issue `done`. (Same validation discipline used for
   Veye/Bati.)
8. (v2) Provision a GitHub token on the worker and enable PR-comment posting.

## Scope note
v1 = `ValDola-stack/valadrien-os` only (public repo, no token to read diffs, dogfoods the OS's own
code). Tenant repos (MyDola, Procilo, etc.) are later: each needs its own GitHub webhook → its own
routine/trigger, and private repos need a read token for the diff.
