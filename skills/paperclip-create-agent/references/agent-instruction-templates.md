# Agent Instruction Templates

Use this reference from step 4 of the hiring workflow. It lists the current role templates, when to use each, and how to decide between an exact template, an adjacent template, or the generic fallback.

These templates are deliberately separate from the main Paperclip heartbeat skill and from `SKILL.md` in this folder — the core wake procedure and hiring workflow stay short, and role-specific depth lives here.

## Decision flow

```
role match?
├── exact template exists       → copy it, replace placeholders, submit
├── adjacent template is close  → copy closest, adapt deliberately (charter, lenses, sections)
└── no template is close        → use references/baseline-role-guide.md to build from scratch
```

In the hire comment, state which path you took so the board can audit the reasoning.

## Index

| Template | Use when hiring | Typical adapter | Lens density |
|---|---|---|---|
| [`Coder`](agents/coder.md) | Software engineers who implement code, debug issues, write tests, and coordinate with QA/CTO | `codex_local`, `claude_local`, `cursor`, or another coding adapter | Low (operational) |
| [`QA`](agents/qa.md) | QA engineers who reproduce bugs, validate fixes, capture screenshots, and report actionable findings | `claude_local` or another browser-capable adapter | Low (operational) |
| [`UX Designer`](agents/uxdesigner.md) | Product designers who produce UX specs, review interface quality, and evolve the design system | `codex_local`, `claude_local`, or another adapter with repo/design context | High (lens-heavy) |
| [`SecurityEngineer`](agents/securityengineer.md) | Security engineers who threat-model, review auth/crypto/input handling, triage supply-chain and LLM-agent risk, and drive remediations | `claude_local`, `codex_local`, or another adapter with repo context | High (lens-heavy) |

If you are hiring a role that is not in this index, do not force a fit. Use the adjacent-template path when one is genuinely close, or the generic fallback when none is.

### When to use each template

- **Coder** — the hire primarily writes or edits code against existing conventions, runs focused tests, and hands off to QA. Pick Coder when the charter is "ship code that passes review and CI." Avoid for pure strategy, design, or security review.
- **QA** — the hire reproduces bugs in a running product, exercises flows in a browser or test harness, and produces evidence-grounded pass/fail reports. Pick QA when the charter is "confirm the user experience matches intent." Avoid for agents that only run static linters or unit tests — that belongs with a Coder.
- **UX Designer** — the hire is accountable for the user experience and visual quality of product work. Pick UXDesigner when the role must make design calls, push back on unstyled implementations, and evolve the design system. Avoid for agents that only proofread or enforce style-guide consistency without making IA or voice decisions, or that only run automated accessibility scans — those are operational and can use the baseline guide. Content Design proper (microcopy, voice, IA) is a lens-using variant; see the adjacent-template path.
- **SecurityEngineer** — the hire is accountable for security posture: threat-modeling, reviewing auth/crypto/input handling, supply-chain and LLM-agent risk, and driving remediations with evidence. Pick SecurityEngineer when the role must block insecure designs, propose concrete fixes, and handle sensitive disclosure. Avoid for agents that only run automated scanners with no triage responsibility — those are operational and can use the baseline guide with a short security-lens subset.

### Lens density: when to keep the full lens list

- **Lens-heavy templates** (UXDesigner, SecurityEngineer) encode expert judgment. The long lens list is the deliverable — keep it intact when hiring the primary domain owner. Drop lens groups only when the hire has an explicitly narrower scope (for example, an "Application Security Reviewer" who will never touch infrastructure or cryptography).
- **Operational templates** (Coder, QA) stay short on purpose. Do not paste lens lists into them just because the baseline guide recommends lenses. If a Coder-adjacent role genuinely needs lenses (for example, a Performance Engineer), pull a focused 5–10 lens set from the baseline-role-guide examples, not the full SecurityEngineer or UXDesigner set.

## How to apply an exact template

1. Open the matching reference in `references/agents/`.
2. Copy that template into the new agent's instruction bundle (usually `AGENTS.md`). For hire requests using local managed-bundle adapters, set the adapted template as `adapterConfig.promptTemplate`; Paperclip materializes it into `AGENTS.md`.
3. Replace placeholders like `{{companyName}}`, `{{managerTitle}}`, `{{issuePrefix}}`, and URLs.
4. Remove tools or workflows the target adapter cannot use.
5. Keep the Paperclip heartbeat requirement and the task-comment requirement.
6. Add role-specific skills or reference files only when they are actually installed or bundled.
7. Run the pre-submit checklist before opening the hire: `references/draft-review-checklist.md`.

## How to apply an adjacent template

Use this when the requested role is close to an existing template but not the same (for example, "Backend Engineer" adapted from `coder.md`, "Content Designer" adapted from `uxdesigner.md`, "Release Engineer" adapted from `qa.md`, or "AppSec Reviewer" adapted from `securityengineer.md`).

1. Start from the closest template.
2. Rewrite the role title, charter, and capabilities for the new role — do not leave the source role's framing in place.
3. Swap domain lenses to match the new discipline. Keep only lenses that actually apply.
4. Remove sections that do not fit (for example, drop the UX visual-quality bar from a backend engineer template, or drop infrastructure lenses from an application-only security reviewer).
5. Add any role-specific section the baseline role guide recommends but the source template omitted.
6. Note in the hire comment which template you adapted and what you changed, so future hires of the same role can start from your draft.
7. Run the pre-submit checklist.

## How to apply the generic fallback

Use this when no template is close. Open `references/baseline-role-guide.md` and follow its section outline. That guide is structured so a CEO or hiring agent can produce a usable `AGENTS.md` without asking the board for prompt-writing help. After drafting, run the pre-submit checklist.

## Lens-based role drafting (worked examples)

Lenses are the single biggest quality lever for expert roles and the single biggest noise source for operational roles. Use these examples to calibrate.

### Example 1 — lens-heavy adjacent template: "Backend Performance Engineer"

Source: adjacent to `coder.md`, but the charter is performance and reliability, not general feature work.

1. Start from `coder.md`.
2. Rewrite the charter around performance: owns latency and throughput budgets, profiles hot paths, proposes concrete fixes with before/after measurements, and blocks merges that regress SLO.
3. Add a focused lens section (about 6–10 lenses), for example: Amdahl's Law, Tail-at-Scale, Little's Law (throughput = concurrency / latency), N+1 queries, hot-cold partitioning, cache coherence, GC pause budget, backpressure, SLO vs SLI vs SLA, observability-before-optimization.
4. Add a "performance review bar" describing evidence expected in a PR: flamegraph or trace, baseline vs fixed numbers, test that fails on regression.
5. Drop UX-visual-quality content. Drop broad security lenses — route those to SecurityEngineer.

This produces a lens-heavy variant without pasting the SecurityEngineer or UXDesigner lens dump, and without leaving Coder's generic framing in place.

### Example 2 — focused lens subset for a narrow role: "Dependency Auditor"

Source: adjacent to `securityengineer.md`, but the scope is only supply-chain risk.

1. Start from `securityengineer.md`.
2. Rewrite the charter around supply-chain audit: watch lockfile changes, run `osv-scanner`/`npm audit`/`pip-audit`, triage CVEs, and file remediation tickets with owner and severity.
3. Keep only the Supply chain, Secure SDLC, and Logging/monitoring lens groups. Drop AuthN/AuthZ, Cryptography, Web-specific hardening, Infrastructure, Rate limiting, Data protection. Those lenses would just add noise to the wake prompt for a pure dependency-audit role.
4. Keep the Review bar and Remediation bar sections, since the role still produces concrete findings with severity and fix proposals.
5. Drop the disclosure-discipline clause if the role never handles private advisories; keep it if it does.

The result is a compact, role-appropriate prompt that still cites lenses the auditor actually applies, without inheriting the full security lens catalog.

### Example 3 — no lenses needed: "Release Coordinator"

Source: adjacent to `qa.md`, but the charter is release-note curation and cut coordination, not browser verification.

1. Start from `qa.md`.
2. Rewrite the charter around release coordination: assemble release notes from merged PRs, confirm CI is green, tag the release, file follow-up tickets for known issues.
3. Do not add a lens section at all. This role is operational; the baseline role guide explicitly allows roles without lenses when judgment is not the deliverable.
4. Keep the comment-on-every-touch rule, the blocked/unblock rule, and the heartbeat-exit rule.
5. Replace the browser workflow with the release-coordination workflow (which PRs to include, how to format notes, who signs off).

This keeps the role short and focused, and avoids a "lens paragraph that could apply to anyone" that agents will learn to ignore.

### Example 4 — UX-adjacent template with trimmed lenses: "Content Designer"

Source: adjacent to `uxdesigner.md`, but the charter is voice, microcopy, and information architecture — not full visual design.

1. Start from `uxdesigner.md`.
2. Rewrite the charter around content: owns voice/tone, microcopy, and information architecture for product surfaces; reviews empty-state copy, error messages, and onboarding flows; pushes back on jargon and dark-pattern language.
3. Keep lens groups: `IA & content`, `Forms & errors` (microcopy), `Behavioral science` (framing, defaults, anchoring), `Accessibility` (plain language, reading level), `Emotional & trust`, `Ethics` (dark-pattern copy).
4. Drop lens groups: `Gestalt`, `Motion & perceived performance`, `Platform & context` (thumb zones), and most of `System & interaction` (Fitts's Law, Doherty Threshold) — these are visual/interaction lenses the content role does not apply.
5. Keep `Reach for what exists first` but reframe around content patterns (error templates, toast taxonomy, empty-state voice) instead of components and tokens.
6. Drop the `Visual quality bar` pixel checklist; replace with a content bar (voice consistent, scannable, plain-language, no dark-pattern copy).
7. Keep the `Visual-truth gate` but narrow the renderable-surface requirement to "cite the rendered string in context" (for example, a screenshot or a grep of the copy in the compiled output) rather than desktop + mobile viewport shots.

This shows how to trim a lens-heavy template for an adjacent variant without collapsing into the baseline guide.

---

In every case, state which path you took in the hire comment and call out what you adapted. Future hires of the same role start from your draft, so the clearer the reasoning, the cheaper the next hire.
