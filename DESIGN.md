# Paperclip Design Principles

**Status:** v0.3 — anchor document for design-language simplification. Governs structure, not brand. Brand values (color, type, iconography) are intentionally unspecified: they are being redesigned and will land as token values only. Nothing in `ui/` may hardcode them. Spacing/radius scales are likewise TBD pending the token audit (see Principle 3).

Changes from v0.2: token layer location corrected to the repo's real source (`ui/src/index.css`); existing token tiers inventoried; snapshot-coverage scope bounded for Run 1; the issue→task copy rename moved out of the zero-visual-change run.

## What this document is for

Agents and humans modifying `ui/` treat this file as the source of truth for design decisions. Storybook is the verification surface — it documents the system; it does not define it. If a change conflicts with this document, change this document first (with review) or change the code.

## Product stance

Paperclip is an operational control plane: org charts, tasks, heartbeat runs, budgets, approvals, audit logs. The user is an operator scanning state and making decisions. Every screen should answer, in order: *what is happening, does it need me, what do I do about it.* Density in service of scanning beats whitespace in service of aesthetics — but density comes from information, never from chrome.

## The token layer (where visual values live)

The single token source is **`ui/src/index.css`** (Tailwind v4; there is no tailwind config file — tokens are CSS custom properties consumed via `@theme`). Do NOT create a parallel token source such as `ui/src/tokens/` — that would produce two sources of truth. If index.css grows unwieldy, extracted values may live in a `tokens.css` **imported by index.css** so the pipeline still has one root.

Tailwind v4 gotcha: `@theme inline` bakes literal values at build time. Any token that must be runtime-tunable (theme editor, dark mode overrides) must be defined in a NON-inline block.

Existing tiers already in index.css (~80+ tokens) — extraction maps to these on **exact value match** before minting anything new:

1. **Semantic tier** — shadcn core set: `--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--sidebar-*`, `--chart-1..5` (OKLCH, light/dark overrides).
2. **Brand tier** — agent gradients `--agent-1a/1b..10a/10b` (fixed hex) and status hues `--status-task-*` / `--status-agent-*` (WCAG-tuned; see inline comments).
3. **Domain tier** — match-chip tokens `--chip-match-*`, annotation highlights `--paperclip-doc-annotation-highlight-*`, plus motion/typography tokens.

## Principles

1. **One way to say each thing.** One component per job. One Button, one Card, one Badge, one Table, one EmptyState. Variants are props, not new components. Before creating a component, prove no existing one covers the job.
2. **Tokens are the only source of visual values.** All color, spacing, radius, type size/weight, shadow, and motion values come from the token layer. No hex, no raw px, no ad-hoc Tailwind arbitrary values (`p-[13px]`) in components. If a needed value doesn't exist, add a token — don't inline it. Tailwind palette classes (`bg-red-500`, `text-zinc-400`, etc.) ARE hardcoded values in spirit: they name a literal color, not a semantic role. They are in-scope debt scheduled for a dedicated future run (Run 4, cluster-by-cluster mapping to semantic tokens per doc/design/DECISION-SHEET.md B2) and are not currently gated by check-token-gates. Exception (doc/design/DECISION-SHEET.md B1 user ruling): first-party intentional one-off decoration on demo/UX-lab surfaces stays inline and allowlisted rather than minted as singleton tokens.
3. **Spacing routes through tokens; the scale comes later.** During simplification, extract every spacing and radius value verbatim into tokens — do not normalize, round, or invent a scale. The final scale is a design decision made by a human after reviewing the token audit. Structural rules apply now: vertical rhythm within a container uses one gap value, not per-element margins, and siblings never carry both margin and gap.
4. **Hierarchy through structure, not decoration.** Prefer position, size, and weight over borders, backgrounds, and dividers. Every border, divider, and background fill must justify itself; when in doubt, remove it. A screen should survive the removal of one visual layer.
5. **Status is systematic.** States like running / paused / blocked / awaiting-approval / over-budget map to a single semantic status token set used identically everywhere (badge, row, chart, log). An operator learns the vocabulary once.
6. **Machine values look machine-made.** IDs, costs, token counts, timestamps, and log output use the monospace token and consistent formatting helpers. Never format these ad hoc per screen.
7. **Words are part of the system.** One name per concept across the entire UI — the canonical term is *task* (never *issue* or *ticket* in copy, labels, or empty states). Buttons name the action ("Approve hire," not "Submit"). Errors say what happened and what to do. Empty states say what to do first. **Note:** enforcing the task rename is a visible change and is explicitly OUT of the zero-visual-change extraction run; it happens in its own follow-up run.
8. **Agent-modifiable by design.** The system must be changeable via instructions: single token source, lint rules that enforce it, and this document kept current. A correct change should be expressible as "edit tokens + run checks," not "visit 40 files."

## Enforcement (what "compliant" means for the extraction run)

- **Zero visual change is proven, not promised:** Storybook visual snapshots are baselined before any refactor, and all snapshots match baseline after it. A change that alters rendered output must be intentional and human-approved.
- **Baseline scope for Run 1:** the shared primitives in `ui/src/components/ui/` (each gets a story if missing — there are only ~24) plus the ~46 existing stories under `ui/storybook/stories/`. Do NOT attempt a story for every feature component (~277) in this run; full coverage is a later effort.
- Mechanical rewrites (value extraction, renames) are done via committed codemod scripts in `scripts/`, not hand-edits — reviewable once, repeatable forever.
- Token layer is the single source (`ui/src/index.css`, per above) consumed via CSS variables / Tailwind theme — never values copied into components.
- Lint/grep gates pass: zero hardcoded hex values, zero arbitrary spacing values, zero raw font-size declarations in `ui/src/components/**` and `ui/src/pages/**` outside the token layer and a documented allowlist (third-party overrides, intentional opt-outs commented inline).
- `pnpm build`, `pnpm typecheck`, and `pnpm build-storybook` pass.
- AGENTS.md links here and states the token-only rule.

Aspirational (NOT gating this run): no duplicate components; every component has exactly one story covering its variants; all UI copy says "task".

## Out of scope (do not do during simplification)

No visual redesign, no new colors or typefaces, no layout restructuring, no new dependencies beyond snapshot tooling, no component consolidation/merges (audit + recommend only), no copy renames, no changes to server code or app logic. Simplification means fewer parts, same product.

## Prior art (read before auditing)

See `doc/design/PRIOR-ART.md` — a previous audit pass (PAP-280/283/284, on the `PAP-282-playground` branch, NOT on master) found that of ~220 hardcoded drift sites, only 6 were exact-value-mappable to existing tokens; expect the verbatim extraction to mint many new tokens that the human scale-collapse step later merges. It also drafted usage rules (radius tiers, CTA tiers, named type styles) that are good candidates for the post-audit scale decision.

How-to guide for day-to-day UI changes: see `doc/design/CHANGING-THE-UI.md`.
