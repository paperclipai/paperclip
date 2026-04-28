# Baseline Role Guide (No-Template Fallback)

Use this guide when no template under `references/agents/` is a close fit for the role you are hiring. It gives you a concrete structure for drafting a new `AGENTS.md` from scratch without asking the board for prompt-writing help.

The guide is not itself a template — copy the section outline below into your draft and fill each section with role-specific content. Aim for roughly 60–150 lines of `AGENTS.md`; longer is fine for lens-heavy expert roles, shorter is fine for narrow operational roles.

---

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
