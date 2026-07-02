# CLAUDE.md — ValAdrien OS

**This file is authoritative for building valadrien-os, for both local (Claude
Desktop) and cloud (ValAdrien OS) agents. If anything here conflicts with memory, a
bundle, or habit — this file wins.**

## Governance — three docs, no overlap
This repo has three governing docs under one authority model (cross-repo loop concepts
live in [`OPERATING-SYSTEM.md`](OPERATING-SYSTEM.md), mirrored into this repo):

- **`CLAUDE.md` (this file)** — Claude-facing **OS overlay**: product identity, the dev-OS
  loop, the operator **LANE**, `DESIGN.md` authority, skill routing, infra gotchas.
- **[`AGENTS.md`](AGENTS.md)** — the **engineering rulebook**: repo map, dev setup, core rules,
  DB workflow, verification, Definition of Done.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — **PR + review** mechanics (the review gate).

**Tie-breaker:** *"Is this about the product/OS framing, how I build, or how I merge?"* →
CLAUDE.md / AGENTS.md / CONTRIBUTING.md respectively. Within any doc, a **fork** section
supersedes an **upstream** section. This file governs OS framing + the lane; it does not
restate engineering (AGENTS.md) or PR/review (CONTRIBUTING.md). Not symlinked to AGENTS.md
by design — CLAUDE.md carries Claude-Code-only content (skill routing, eng-overseer) that must
not pollute the tool-agnostic, upstream-tracked AGENTS.md.

## What this is
The ValAdrien OS control plane — a single-instance, multi-tenant platform for running
autonomous AI companies. A fork of `paperclipai/paperclip`, rebranded to ValAdrien OS.
Operators watch AI agents (a CEO agent, an engineer agent, etc.) actually run a
business: take tasks, execute, post updates, spend money, hit blockers. The UI is a
credibility artifact — it must look serious, premium, trustworthy.

- **Local root:** `/Users/fernandadrien/Projects/valadrien-os`
- **Repo:** `ValDola-stack/valadrien-os` (working branch `rebrand/valadrien-os`)
- **Deploy target:** Vercel project `valadrien-os-server` → `os.valadrien.dev`;
  Supabase (ref `nzbwmlvxnzfhqaznyggw`); runtime on Railway (svc `valadrien_staff`).
- **Stage of maturity:** active (org build live — Ti Claude / Sol / Bati / Veye / Korije).

## The loop (how work flows here)
Follows the ValAdrien Dev Operating System — see [`OPERATING-SYSTEM.md`](OPERATING-SYSTEM.md).
- **Plan + Build = Claude-native** (this file + memory hold the conventions).
- **Review = non-Claude** — a PR is not mergeable until **CodeRabbit** has passed it.
  (Korije, the OS QA agent, is Claude Sonnet → integration, not diversity.)
- **Never merge work cleared only by the same model that wrote it.**

## Run / build / test / ship
See **[`AGENTS.md` §4](AGENTS.md)** (Dev Setup) for the workspace build/test/migrate/CLI
commands — deliberately not restated here to avoid drift. **Fork guardrail overrides §4:**
never run `pnpm dev` / any Vite dev server (see GUARDRAILS) — verify UI via the deployed
preview / Storybook, not a local dev server.

## GUARDRAILS — never do these (hard rules)
- **Never run `pnpm dev` / `pnpm dev:ui` / any Vite dev server in this repo.** It
  crashes Fernand's machine. Verify UI visually via the deployed preview or Storybook,
  not a local dev server.
- **Deploy / push-to-prod / `vercel promote` / routing changes / opening PRs / infra
  are OUT of the default operator's lane** — see LANE. Other sessions own them.
- Do not deviate from `DESIGN.md` (GLASSHOUSE) without explicit owner approval. In
  QA/review, flag any UI that doesn't match it.

## LANE — who owns what
**This is a SHARED repo** (multiple Claude sessions + the cloud fleet touch it).
- **The default operator's lane = UI/UX + some features ONLY.**
- **NEVER** deploy, run `vercel promote`, git-push-to-prod, change routing, open PRs,
  or touch infra — the **runtime session** owns those, and touching them collides with
  its work.
- In UI-lane: commit UI work **locally** and write a **handoff note for the runtime session**
  that owns deploy/infra. Let that session land it.

## Tooling for this repo
- **Design system:** always read **`DESIGN.md`** (repo root, "GLASSHOUSE") before any
  visual/UI decision. Also `/design-guide` skill + the `.claude/skills/design-guide`
  showcase page. See "Design system" below.
- **Search:** prefer `gbrain search` over Grep for semantic / "where is X" questions.
- **Live docs:** use Context7 for framework APIs (React 19 / Vite / Tailwind v4 /
  shadcn) before writing against them, once wired.
- **Issues:** Linear = human/planning layer; ValAdrien OS issues (VAL-*) = agent
  execution layer, bridged one-way `Sentry/Braintrust → Linear → OS` (see
  [`OPERATING-SYSTEM.md`](OPERATING-SYSTEM.md) §4).
- **Secrets:** live in Supabase Edge secrets / Vercel env / Railway — never inline them
  in the repo.

## Skill routing (engineering oversight)
When the situation matches, invoke the skill via the Skill tool. All names below are REAL
installed skills (user-level eng-overseer overlay + gstack).
- Design a new system from requirements → **/system-design**
- Review / lock / diagnose an existing architecture → **/architecture**
- Live incident / outage / RED audit → **/incident-response** (security → also **/cso**)
- Plain bug / root cause (no live impact) → **/investigate**
- Review a diff/PR → **/code-review** (pre-landing → **/review**; cleanup-only → **/simplify**)
- Independent / adversarial second opinion → **/codex**
- Test coverage & strategy → **/testing-strategy** (run+fix → **/qa**; report-only → **/qa-only**)
- Visual / design QA against DESIGN.md → **/design-review**
- Pre-deploy readiness gate → **/deploy-checklist** (then **/ship** → **/land-and-deploy**; LANE permitting)
- Docs after a change → **/document-release** (from scratch → **/document-generate**)
- Tech-debt assessment & paydown → **/tech-debt**
- Weekly retro / what shipped → **/retro**

The overlay agent is `eng-overseer` (user-level, runs on the subscription). The six
skills system-design/architecture/incident-response/testing-strategy/deploy-checklist/
tech-debt live in `~/.claude/skills/` so they're available on every tenant, not just this repo.

## Design system
Read **`DESIGN.md`** (repo root) before making any visual or UI decision. GLASSHOUSE:
dark-first **instrument minimalism**, **Sodium-amber** accent (rationed to ~3% — NOT
blue), fonts **Newsreader** (serif masthead/names) / **Hanken Grotesk** (UI/body) /
**JetBrains Mono** (data/logs, tabular-nums). Color = state, never decoration; motion
is bound 1:1 to a real control-plane event. Signature components: agent face (5-state
living icon), heartbeat spine (EKG), cost tape, thinking cursor, agent portrait, org
collab wire. Never use Inter/Roboto/system-ui/Space Grotesk. Tokens live in
`ui/src/index.css`; radius 0 for containers, 2px for controls. Honor
`prefers-reduced-motion`.

## Deploy / infra facts (that bite)
- **Vercel Framework Preset MUST be "Other"** (not "Vite"). If set to Vite the `/api`
  serverless function never builds and `/api/*` gets served the SPA HTML instead.
- **DB must use Supabase pooler URLs**, not the direct IPv6 host.
- **Agent instruction bundles are files on the Railway volume PLUS a DB path.** The
  heartbeat resolver does NOT recover from disk, so BOTH the DB `adapter_config` path
  AND the on-volume instruction file must be set. Vercel and Railway do not share a
  filesystem — setting one host is not enough.
- Bundle files live at
  `/valadrien-os/instances/default/companies/{co}/agents/{id}/instructions/` on the
  Railway volume.
- **Runtime (Railway) is not GitHub-connected** (`docker.yml` builds on `master`/tags only,
  and `master` trails `rebrand` far behind). Deploy the runtime from merged `rebrand` with
  `railway up -s valadrien_staff` (project `management-os`). The **control plane (Vercel)**
  auto-deploys on push/merge to `rebrand/valadrien-os`.

## Conventions
- pnpm workspace filters (`pnpm --filter @valadrien-os/<pkg> …`); run root scripts, not
  per-package guesses.
- Cloud-agent bundles carry only a thin pointer to this file — substance stays here in
  git, the only substrate all three surfaces (local / Railway / repo) share.

---
_Contract template v1 — from dotfiles/templates/CLAUDE.template.md. Keep this file
current; it is the only thing every surface is guaranteed to read._
