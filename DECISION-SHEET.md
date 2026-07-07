# DECISION-SHEET — Run 1 human review

Every open question from TOKEN-AUDIT.md §8 + batch logs and COMPONENT-INVENTORY.md §6, each with a recommendation, blast radius, and where it lands. Statuses: **PENDING** → APPROVED / OVERRIDDEN (with note) / DEFERRED.

## A. Quick wins — low risk, do in this review phase

| # | Decision | Recommendation | Blast radius | Status |
|---|---|---|---|---|
| A1 | `agentStatusBadge` vs `brandChipBadge` byte-identical maps (status-colors.ts) | Collapse to `brandChipBadge`, re-point imports | code dedup, zero pixels | APPROVED — done 5ecc0f9e4: `agentStatusBadge` had ZERO importing call sites, so it was deleted outright (no re-pointing, no alias needed); `brandChipBadge` is the single map, `AgentBadgeColor` kept (subset of `BrandChipColor`) |
| A2 | Contrast-pair triplication (color-contrast.ts / worktree-branding.ts / ThemeContext.tsx) | One shared constant IF values are truly identical; verify per-pair first, keep semantically distinct ones separate | 3 files, zero pixels if identical | APPROVED — done 383460bb2: only `#f8fafc`/`#111827` is byte-identical across files → exported as `READABLE_TEXT_LIGHT`/`READABLE_TEXT_DARK` from color-contrast.ts, imported by worktree-branding.ts; ThemeContext's `#18181b`/`#ffffff` meta-theme-color pair, the DARK_BG/LIGHT_BG rgb-object compositing backgrounds, and worktree-branding's `#000000` parse fallback are semantically distinct → untouched |
| A3 | Project-color fallbacks `#6366f1` / `#64748b` (14 sites) | Two semantic tokens (`--project-seed`, `--project-none`) — file pattern shows two intents | rename-only, zero pixels | APPROVED — done 7e3e59db2: pure rename `--hex-6366f1`→`--project-seed` (7 sites) and `--hex-64748b`→`--project-none` (9 sites incl. ActivityCharts 'backlog') + index.css definitions, values unchanged |
| A4 | Test-file hardcoded hex (56 sites) | Leave alone; update lockstep only when asserted values actually change | none | APPROVED — policy adopted, no code change |
| A5 | `FileViewerSheet` half-migrated `var(--paperclip-code-highlight-*, fallback)` | Mint the two vars in index.css at the fallback values (identical pixels today; makes the intended token real) | 1 file | APPROVED — done 7929aabeb: both vars minted in the extracted-tokens :root block at exactly the former fallback values; chose to SIMPLIFY the Batch 4 `--code-highlight-*-resolved` wrappers to plain `var(--x)` (fallbacks now redundant; nothing sets the vars at runtime); FileViewerSheet.tsx call sites unchanged |
| A6 | "Liveness blue" chat bubble reusing `--status-task-in_progress` (semantic coincidence) | Decouple: mint `--liveness-blue` with same value so a future status-hue change doesn't drag the chat bubble along | 2 sites, zero pixels | APPROVED — done b76a7955a: `--liveness-blue: #2563eb` minted; IssueChatThread.tsx bubble class + IssueChatThread.test.tsx lockstep assertion re-pointed |

## B. Policy calls

| # | Decision | Recommendation | Status |
|---|---|---|---|
| B1 | One-off decorative gradients/shadows (5 production + UxLab; 38 arbitrary shadows, no `--shadow-*` tokens existed) | Allowlist as documented "intentional one-off decoration" (extend allowlist criteria beyond third-party); DELETE the ~20 never-reused singleton `--gradient-extract-*` tokens back to inline, keep only reused ones. Spirit over letter of principle 2 | APPROVED — middle path, executed: 27 demo-only tokens reverted inline (19 gradients: --gradient-extract-5,6,8-24; 8 shadows: --shadow-extract-15,16,17,19-23 — all consumed solely by *UxLab.tsx pages), 35 call sites restored to original bracket literals, definitions deleted, 4 UxLab pages allowlisted + criteria doc-comment extended to first-party intentional decoration. KEPT 22 production tokens (gradients 1,2,3,4,7,25,26 + 15 shadows) — NOTE: --shadow-extract-4/5 kept contrary to the audit's first cut because ChatComposer.tsx and IssueChatThread.tsx (production) consume them, not just ChatComposer.test.tsx |
| B2 | Tailwind palette classes (`bg-red-500` etc.) — 3,115 sites / 145 files | Own future run (Run 4): cluster-by-cluster mapping to semantic tokens, starting with status-adjacent colors; NOT wholesale now, NOT permanent exemption. Update DESIGN.md principle 2 to name palette classes explicitly | APPROVED — own Run 4 later |
| B3 | Micro type cluster 9–15px (730 sites) + letter-spacing 9 values (202 sites) | Adopt PRIOR-ART named ladder (map 9→10 nano, keep 10/11/12/13/14; 15→14; tracking → 3 steps) via contact-sheet review — executed in the preset-tune session, decided now | EXECUTED (pending contact-sheet) — scripts/codemod-type-ladder.mjs (idempotent, committed): 730 font-size sites -> --text-nano (10px, incl. 9->10) / --text-micro (11px, incl. 0.7rem) / text-xs (12px) / --text-compact (13px) / text-sm (14px, incl. 15->14); 202 tracking sites -> --tracking-label (0.08em) / --tracking-eyebrow (0.14em) / --tracking-caps (0.2em); all --fs-* and --ls-* definitions deleted. NOTE: text-xs/text-sm sites also pick up Tailwind scale line-height (contact-sheet reviewable). PRIOR-ART "sm 13" tier renamed --text-compact (name collides with Tailwind text-sm=14px) |
| B4 | Radius conflict (`--radius-lg/xl` = 0px vs stock 2xl/3xl) | Defer to preset session — it's a brand question. Candidate: PRIOR-ART monotonic 6/8/10/14/16 | DEFERRED to preset session |
| B5 | Chart palette vs canonical status hues (ActivityCharts in_progress = violet, elsewhere blue) | Re-point charts at `--status-task-*` (operator learns one vocabulary — DESIGN.md P5). Visible change → contact sheet | APPROVED & CLOSED — user approved on before/after contact sheet (Jul 6); 2 chart snapshots re-baselined, suite 510/510 on new baseline. Known trade documented: To-Do amber vs priority-Medium amber adjacency, revisit at preset session |

## C. Component calls (from COMPONENT-INVENTORY.md §6)

| # | Decision | Recommendation | Status |
|---|---|---|---|
| C1 | ChatComposer vs MarkdownEditor split | Keep split; document as deliberate in COMPONENT-INVENTORY | APPROVED — keep split, documented deliberate (user re-confirmed after visual review) |
| C2 | FileTree vs WorkspaceFileBrowser parallel tree models | Investigate data-shape needs in Run 3; refactor onto FileTree only if shapes align | APPROVED — investigate data-shape needs in Run 3 prep |
| C3 | Entity-picker family (4 components) | Prop-by-prop diff as Run 3 prep task; no merge without it | APPROVED — prop-by-prop diff as Run 3 prep task; no merge without it |
| C4 | Finance card family (5 components) | Keep; revisit only if a 6th appears | APPROVED — keep all five; revisit only if a 6th appears |
| C5 | Hand-rolled cards (~26 files) → `Card`; pills (~34 files) → `Badge` | Run 3 shadcn-swap list, per-site snapshot verification | APPROVED — queued Run 3 shadcn-swap list, per-site snapshot verification |
| C6 | `plugins/launchers.tsx` overlay | Dedicated review task; exclude from Run 3 | APPROVED — dedicated review task, excluded from Run 3 |
| C7 | radio-card / toggle-switch custom primitives | Document as deliberate custom; skip swaps | APPROVED — documented as deliberate custom; skip swaps |
| C8 | StatusBadge not wrapping Badge primitive | Document as intentional exception (WCAG-tuned .status-chip mechanic) | APPROVED — documented as intentional exception (WCAG-tuned .status-chip mechanic) |
| C9 | Toast system (no shadcn primitive installed) | Keep custom toast; document as permanent choice (working tone/variant system; sonner migration = churn without user-visible gain) | DEFERRED to Run 4 — decide when toast palette colors get retokenized; sonner-behind-a-pushToast-facade is the alternative to evaluate |
| C10 | FeatureGate wrapper pattern (3 near-identical gates) | Nice-to-have shared primitive; backlog, not a run | APPROVED — backlog nice-to-have, not a run |

## Verification status (this review)

- `pnpm check:token-gates` — re-run independently: 3/3 CLEAN (468 files, 31 allowlist entries).
- `pnpm typecheck` + full `pnpm test:storybook-visual` — re-running independently (in progress).
- Eyeball-pass note: the Phase 0 baseline was captured at the master fork point before any change, and the suite compares current rendering to it at `maxDiffPixels: 0` — pixel-equality with master-at-fork is machine-proven; side-by-side Storybook remains available on request (`pnpm storybook` here + `-p 6007` on master).
