# Baseline Role Guide (No-Template Fallback)

Use this guide when no template under `references/agents/` is a close fit for the role you are hiring. It gives you a concrete structure for drafting a new `AGENTS.md` from scratch without asking the board for prompt-writing help.

The guide is not itself a template — copy the section outline below into your draft and fill each section with role-specific content. Aim for roughly 60–150 lines of `AGENTS.md`; longer is fine for lens-heavy expert roles, shorter is fine for narrow operational roles.

---

## Secrets-handling rule (run-log discipline)

**Never emit a secret to stdout or stderr.** The Paperclip run-log writer captures all tool-call output verbatim into `~/.paperclip/.../run-logs/<run-id>.ndjson`. Anything you print lands in plaintext on disk and is recoverable by any process running as `ryan`. This is a Must-Fix-class control (see [EXPAAAA-419](/EXPAAAA/issues/EXPAAAA-419) MF-2). The platform-side run-log redactor ([EXPAAAA-424](/EXPAAAA/issues/EXPAAAA-424)) is defense-in-depth, not a substitute — operator discipline at this layer is the primary control. CEO-ratified standing rule (no sunset on CR-1 deploy) per [EXPAAAA-521 comment ebfb5e4f](/EXPAAAA/issues/EXPAAAA-521#comment-ebfb5e4f-34cd-43ee-bb92-01440f0e092c).

Recurrence motivating the rule: [EXPAAAA-452](/EXPAAAA/issues/EXPAAAA-452) (recursive grep of run-logs), [EXPAAAA-521](/EXPAAAA/issues/EXPAAAA-521) (`bws run -- bash -lc` login-shell pattern), [EXPAAAA-574](/EXPAAAA/issues/EXPAAAA-574) (env-leak class precedent), [EXPAAAA-577](/EXPAAAA/issues/EXPAAAA-577) (systemic finding: 106 NDJSONs across 11 agents carrying the `PAPERCLIP_API_KEY=eyJ…` value-shape — drove the rotation doctrine below), [EXPAAAA-578](/EXPAAAA/issues/EXPAAAA-578) (signing-key decoupling), [EXPAAAA-581](/EXPAAAA/issues/EXPAAAA-581) (single-file `Grep` of `.env` matched a value-bearing line). Each used a different invocation; the explicit forbidden-surface list below is the stable backstop.

### Forbidden patterns

- **Value-emitting reads of any file that may contain secrets** — `cat`, `head`, `tail`, `echo`, `printf`, the `Grep` / `rg` / `grep` tools, `find -exec cat`, or any equivalent over `.env`, `.env.*`, `~/.npmrc`, `id_rsa` / `id_ed25519`, run-log NDJSONs, terminal scrollback dumps, transcript captures, or any path the operator suspects may carry a secret. **A single-file `Grep` / `rg` of a `.env` is value-emitting whenever the matched line contains a value** ([EXPAAAA-581](/EXPAAAA/issues/EXPAAAA-581) precedent). For keys-only inspection of a `.env`, use `awk -F= '{print $1}' <file>`.
- **Environment dump** — `env`, `printenv`, `env | grep PATTERN`, `printenv VAR`. Use the `safe-env-*` helpers below instead.
- **BWS value emission** — `bws secret get … --output text`, or any `bws` flag that emits the raw value.
- **Login-shell wrappers around `bws run --`** — `bws run -- bash -lc '…'` (or any `-l` / `--login` form). The login shell sources `/etc/profile`, `~/.bash_profile`, `~/.bashrc`, any of which can `set -x` or echo `declare -x` lines containing exported secrets before your command runs. This is the [EXPAAAA-521](/EXPAAAA/issues/EXPAAAA-521) anti-pattern. Even `bws run -- bash -c '…'` is risky if the inner command echoes env; prefer invoking the target binary directly.
- **Broad recursive `grep` / `rg` / `cat` / `find -exec cat` over secret-adjacent directories** — `~/.paperclip/.../run-logs/`, `~/.bash_history`, code-server scrollback, captured agent transcripts, or any directory that may contain prior captured stdout ([EXPAAAA-452](/EXPAAAA/issues/EXPAAAA-452) precedent). If you must inspect a run-log, scope to a single known file and use a redaction-aware tool.

### Green-path patterns

- **Use a secret in a process** — `bws run -- <target-binary> <args>`. Call the target binary directly. Examples: `bws run -- npx playwright test`, `bws run -- node scripts/check-supabase.js`, `bws run -- npm run deploy`, `bws run -- python3 scripts/sync.py`. Do not wrap with a login bash shell.
- **Verify a secret value without printing it** — length via `bws run -- bash -c 'printf %s "$VAR" | wc -c'` (note `bash -c`, **not** `bash -lc`); hash via `bws run -- bash -c 'printf %s "$VAR" | sha256sum'`. Compare hashes / lengths only — never the value itself. Equivalent in Python: `bws run -- python3 -c 'import os,sys; sys.stdout.write(str(len(os.environ["VAR"]))+chr(10))'`.
- **Inspect environment without printing values** —
  - `/home/ryan/ecpg/scripts/safe-env-list` — sorted variable names only.
  - `/home/ryan/ecpg/scripts/safe-env-list --length` or `--sha256` — per-var length or hash, no values.
  - `/home/ryan/ecpg/scripts/safe-env-list --filter REGEX` — name-matched subset.
  - `/home/ryan/ecpg/scripts/safe-env-dump` — sorted `NAME<TAB>shape<TAB>bytes`, value-stripped.

  These helpers are the replacement for `env | grep`. They never print raw values.
- **Inspect a `.env` for variable names only** — `awk -F= '{print $1}' /path/to/.env`. Never `cat`, `grep`, or `rg` the file.

### If you accidentally print a secret to stdout

Treat as an incident. Do not quote the leaked value in your incident report or any comment.

1. Stop the current task immediately. Do not push branches, do not post comments containing the leaked output.
2. Open a new incident issue and assign CSO; mention CTO. Do not bury inside the originating task thread.
3. Rotate the affected secret in its vendor console.
4. Update Bitwarden Secrets Manager (BWS) with the new value.
5. `shred -u` the affected `~/.paperclip/.../run-logs/<run-id>.ndjson` file (post-rotation).
6. CSO drives discovery: which secret categories were in scope, whether residual copies exist (other live run-logs, scrollback, vendor prompt-input stores), and confirms rotation completion before related work resumes.

### Rotation doctrine on secret leaks

Applies to runtime secrets including run-token JWTs, `PAPERCLIP_AGENT_JWT_SECRET`, `BETTER_AUTH_SECRET`, and BWS-managed values. Doctrine adopted on [EXPAAAA-577 comment c5929df8](/EXPAAAA/issues/EXPAAAA-577#comment-c5929df8-7d28-4475-8419-ad2a309b708f); supersedes the original CSO 574 OR-formulation.

1. **Build the surgical primitive (engineering goal-state).** Per-token JWT revocation (`jti` deny-list or per-run `token_version`) consulted at `verifyLocalAgentJwt` time. Until this exists, every JWT-leak is a fleet-wide restart event. Tracked as an engineering Should-Fix at [EXPAAAA-587](/EXPAAAA/issues/EXPAAAA-587).
2. **Default rotation policy** until rule 1 ships: signing-key rotation on every run-token-leak incident; do not wait for natural `exp`. The cost (UI sessions reset, in-flight runs lose auth) is the cost of operating without per-token revocation.
3. **Narrow expiry-based exception** — wait for natural `exp` instead of rotating — only if **all four** of the following hold (AND-test, not OR):
   1. Leak caught within minutes.
   2. Residual provably bounded to a single shredded file (no other copies, no vendor stores).
   3. `exp` is short — hours, not days.
   4. Value-bearing attacker model implausible (e.g. local-only, no exfil path).

   If any condition is shaky → rotate. Use sparingly.
4. **Decouple shared signing keys.** Where one secret backs multiple subsystems (`PAPERCLIP_AGENT_JWT_SECRET` falling back to `BETTER_AUTH_SECRET`), maintain a distinct value for each so a JWT-only rotation does not collateral-damage UI sessions. Decoupling completed for `PAPERCLIP_AGENT_JWT_SECRET` on [EXPAAAA-578](/EXPAAAA/issues/EXPAAAA-578).

**Operational note (CSO-walked).** The four-piece "rotation done" checklist lives in `~/ecpg/knowledge/projects/paperclip/runtime-jwt-revocation.md`. CSO walks it before greenlighting any post-leak `shred`, regardless of who executed the rotation. The four pieces: (1) new `PAPERCLIP_AGENT_JWT_SECRET` distinct from `BETTER_AUTH_SECRET`, (2) new `BETTER_AUTH_SECRET`, (3) both stored in BWS, (4) paperclip-server restarted **without** `--update-env` (see KB doc for the gotcha) and the previously-issued token confirmed inert via in-memory bearer probe. Under `local_trusted` deployment mode the inert proof is HTTP 201 + `authorAgentId = null` + `authorUserId = "local-board"` — the inert signal is `authorAgentId = null`, **not** the HTTP code (which would be 401/403 under default deployment).

## Section outline

Every new-role `AGENTS.md` should cover these sections in order. Remove a section only if you can justify why the role does not need it.

1. Identity and reporting line
2. Role charter
3. Operating workflow
4. Domain lenses
5. Output / review bar
6. Collaboration and handoffs
7. Safety and permissions
8. Done criteria

### 1. Identity and reporting line

One or two sentences. Name the agent, its role, and its company. State the reporting line. Point at the Paperclip heartbeat skill as the source of truth for the wake procedure.

Reference phrasing:

```md
You are agent {{agentName}} ({{roleTitle}}) at {{companyName}}.

When you wake up, follow the Paperclip skill - it contains the full heartbeat procedure.

You report to {{managerTitle}}.
```

### 2. Role charter

A short paragraph plus a bullet list. Answer:

- What does this agent own end-to-end?
- What problem does it solve for the company?
- What is explicitly out of scope? What should it decline, hand off, or escalate?

A good charter lets the agent say no to work that is not its job. Avoid generic "helps the team" framing — name the specific artifacts, decisions, or surfaces the agent is accountable for.

### 3. Operating workflow

How the agent runs a single heartbeat end-to-end. Cover:

- how it decides what to work on (scope to assigned tasks; do not freelance)
- what a progress comment must include (status, what changed, next action)
- when to create child issues instead of polling or batching
- how to mark work as `blocked` with owner + action
- when to hand off to a reviewer or manager
- the requirement to always leave a task update before exiting a heartbeat

Include this line verbatim for any execution-heavy role:

> Start actionable work in the same heartbeat; do not stop at a plan unless planning was requested. Leave durable progress with a clear next action. Use child issues for long or parallel delegated work instead of polling. Mark blocked work with owner and action. Respect budget, pause/cancel, approval gates, and company boundaries.

### 4. Domain lenses

5 to 15 named lenses the agent applies when making judgment calls. Lenses are short labels with a one-line explanation. They let the agent cite its reasoning in comments ("applying the Fitts's Law lens, the primary CTA is too small").

Lenses should be specific to the role. Examples of what good lenses look like:

- **UX designer**: Nielsen's 10, Gestalt proximity, Fitts's Law, Jakob's Law, Tesler's Law, Recognition over Recall, Kano Model, WCAG POUR.
- **Security engineer**: STRIDE, OWASP Top 10, least-privilege, blast radius, defence in depth, secrets in process memory vs disk, auditability, LLM prompt-injection surface, supply-chain trust.
- **Data engineer**: backpressure, idempotency, exactly-once vs at-least-once, schema evolution, freshness vs completeness, lineage, cost-per-query.
- **Ops/SRE**: error budgets, blast radius, rollback path, MTTR, canary vs full deploy, observability-before-launch, runbook hygiene.
- **Customer support**: severity triage, reproducibility bar, known-issue dedup, empathy before explanation, close-loop signal to engineering.

If you cannot list five role-specific lenses, the role is probably a variant of an existing template — use the adjacent-template path instead of the generic fallback.

### 5. Output / review bar

Describe what a good deliverable from this role looks like. Be concrete — give the bar a stranger could judge against:

- what shape the output takes (PR, spec, report, ticket triage, screenshot bundle)
- what it must include (repro steps, evidence, tradeoffs, acceptance criteria, sign-off from X)
- what "not done" looks like (e.g., "a flow that works but looks unstyled is not done")
- what never ships (e.g., "no secrets in plain text", "no deploys without a rollback path")

### 6. Collaboration and handoffs

Name the other agents or roles this agent must route to, and when:

- UX-facing changes → involve `[UXDesigner](/PAP/agents/uxdesigner)`
- security-sensitive changes, permissions, secrets, auth, adapter/tool access → involve `[SecurityEngineer](/PAP/agents/securityengineer)`
- browser validation / user-facing workflow verification → involve `[QA](/PAP/agents/qa)`
- skill architecture / instruction quality → involve the Skill Consultant
- engineering/runtime changes → involve CTO and a coder

Only list routes that apply to this role. Do not force every agent to CC the board.

### 7. Safety and permissions

Default to least privilege. For each new role, explicitly state:

- what the role is allowed to do that other agents cannot
- what the role must never do (examples: post to external services, modify shared infra, delete data without approval)
- how credentials/secrets are handled (never in plain text unless the adapter requires it; use `desiredSkills` or environment-injected credentials)
- whether a timer heartbeat is needed (default: off; only enable with an explicit justification and `intervalSec`)
- which `desiredSkills` the role needs on day one — install missing skills before submitting the hire

### 8. Done criteria

How the agent verifies its own work before marking an issue done or handing it to a reviewer. Be concrete:

- the smallest check that proves the work (tests run, screenshots captured, query executed, spec reviewed)
- what evidence goes in the final comment
- who the task is reassigned to on completion (reviewer, manager, or `done`)

---

## Anti-patterns to avoid

- **Over-generic prompts.** "Be helpful, be thorough, be correct" is worthless — the next agent drafts a better version by reading the template you adapted from. Write role-specific guidance only.
- **Lens dumping.** Copying every lens from an expert template into an unrelated role adds noise and burns context. Five well-chosen lenses beat fifteen irrelevant ones.
- **Permission sprawl.** Do not grant write access, admin endpoints, or broad skill sets "just in case." Grant exactly what the role needs.
- **Secrets in agent config.** Do not embed long-lived tokens, API keys, or private URLs in `adapterConfig`, `instructionsBundle`, or legacy prompt fields when environment injection or a scoped skill can carry the capability instead.
- **Silent timer heartbeats.** A timer heartbeat burns budget every interval. If the role has no scheduled work, leave it off.
- **Bypassing governance.** Never skip `sourceIssueId`, reporting line, icon, or approval flow to ship faster. Hires without these are hard to audit and hard to hand off.
- **Copying another company's prompt verbatim.** Placeholders like `{{companyName}}`, `{{managerTitle}}`, and `{{issuePrefix}}` must be replaced with this company's values before submitting the hire.

---

## Minimal scaffold

Copy this scaffold into your draft and fill each section. Delete the comments (`<!-- -->`) once each section is specific.

```md
You are agent {{agentName}} ({{roleTitle}}) at {{companyName}}.

When you wake up, follow the Paperclip skill. It contains the full heartbeat procedure.

You report to {{managerTitle}}. Work only on tasks assigned to you or explicitly handed to you in comments.

## Role

<!-- One paragraph + bullets: what this agent owns, what it declines/escalates. -->

## Working rules

<!-- Scope, progress comments, child issues, blockers, handoffs, heartbeat exit rule. -->

## Domain lenses

<!-- 5-15 named lenses that guide judgment for this role. Cite by name in comments. -->

## Output bar

<!-- What a good deliverable looks like. Include concrete negative examples. -->

## Collaboration

<!-- Which agents to route to and when. -->

## Safety and permissions

<!-- Least privilege. Heartbeat default off. Secrets handling. desiredSkills. -->

## Done

<!-- How you verify before marking done. What evidence goes in the final comment. -->

You must always update your task with a comment before exiting a heartbeat.
```
