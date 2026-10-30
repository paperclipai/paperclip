# Prior art: PAP-280 design-token audit (branch `PAP-282-playground`, not on master)

A previous audit/relink pass ran against this codebase in mid-2026. Its code never merged to master, but its findings are directly reusable by the token audit. Read this before Phase 1.

## Key findings to inherit

- **Drift is mostly NOT same-value-mappable.** The relink pass (commit `032d6c8db` on the branch) attempted to swap hardcoded values for existing semantic tokens *without visual change* and found only **6 exact-value swaps** possible (`text-muted-fg`, `rounded-md`) out of ~220 audited drift sites (~193 color / 23 radius / 7 type). Implication for Phase 2: expect to mint many new verbatim tokens; do not force-fit near-misses onto existing tokens — that changes pixels.
- **Token gap clusters identified** (commit `96689351d`): recurring un-tokenized needs were a code-surface background, an accent blue, and a muted feed text color — these became `--surface-code`, `--accent-blue`-style gap tokens on the branch. Audit should check whether the same clusters still dominate.
- **Tailwind v4 tunability gotcha** (learned the hard way): `@theme inline` bakes literals at build time; tunable tokens must live in a non-inline block.

## Drafted usage rules (branch commit `6ba86cd4f` — candidates for the human scale decision, NOT current master state)

- **Radius:** one monotonic scale `sm 6 / md 8 / lg 10 / xl 14 / 2xl 16 / full`. Assignments: sm=chips/badges/pills; md=buttons/inputs/menu items (default); lg=cards/popovers/panels; xl=dialogs/sheets/overlays; 2xl=hero/onboarding only; full=avatars/dots/capsules. Nested elements step down one tier from their container. (Master's current values differ — verify in the audit.)
- **CTA tiers:** three-tier button prominence — Primary (`default`/`destructive`): the single commit action per view; Secondary (`secondary`/`outline`): supporting actions; Tertiary (`ghost`/`link`): row actions, cancels, toolbar icons.
- **Type styles:** nine named intent styles (backed by `--text-*` tokens incl. `micro` 11px / `nano` 10px) instead of re-deriving `text-lg font-semibold` per call site. Color is a separate axis.
- **Drift-prevention contract:** no raw hex for chrome — use `background / card / muted / accent / border / muted-foreground`; when a needed value has no token, add a semantic token; intentional opt-outs (code/terminal blocks) carry a comment saying why, so a future re-link pass leaves them alone.

## Reusable machinery on the branch

- A theme playground / theme editor with portable `*.theme.json` export-import (whole-app live retheme, A/B compare). Useful later for the human scale-collapse and brand/preset tune steps — not needed for the extraction run.
- `.claude/skills/design-guide/` skill + `ui/src/pages/DesignGuide.tsx` showcase page (branch versions are richer than master's).
