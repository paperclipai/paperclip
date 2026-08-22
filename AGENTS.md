# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue `plan` document per the `paperclip` skill instead of creating a repo markdown file.

6. Attach inspectable generated artifacts.
When your task produces a user-inspectable deliverable file, follow the Paperclip skill's "Generated Artifacts and Work Products" workflow before final disposition. In this repo, prefer the self-contained skill helper at `skills/paperclip/scripts/paperclip-upload-artifact.sh` so the file is available through the Paperclip API, create/update an artifact work product when the file is the deliverable, link the uploaded artifact in the final issue comment, and then set status. Do not rely on local filesystem paths as the only access path. If an important file intentionally remains workspace-only, create/update a work product with `metadata.resourceRef.kind: "workspace_file"` and a workspace-relative path, then name that work product and path in the final comment. Treat browse/search as a fallback for recovering workspace files, not the preferred deliverable path. See `doc/AGENT-ARTIFACTS.md` for details and `.mp4`/`.webm` examples.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Run this full check before claiming repo work done in a PR-ready hand-off, or when the change scope is broad enough that targeted checks are not sufficient:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## 11. Fork-Specific: HenkDz/paperclip

This is a fork of `paperclipai/paperclip` with QoL patches and a **built-in** Hermes adapter story on branch `feat/externalize-hermes-adapter` ([tree](https://github.com/HenkDz/paperclip/tree/feat/externalize-hermes-adapter)).

### Branch Strategy

- `feat/externalize-hermes-adapter` now ships `hermes_local` and `hermes_gateway` as built-in core adapters.
- Older fork branches may still document plugin-only Hermes; treat this file as authoritative for the current branch.

### Hermes (built-in)

- `hermes_local` is available without Adapter manager installation and runs the local Hermes CLI.
- `hermes_gateway` is available without Adapter manager installation and calls an already-running Hermes API server.
- Operators may still install external Hermes packages through Adapter manager to override/shadow the built-ins.
- Optional: `file:` entry in `~/.paperclip/adapter-plugins.json` remains useful for local development of override packages.

### Local Dev

- Fork runs on port 3101+ (auto-detects if 3100 is taken by upstream instance)
- `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead
- Server startup from NTFS takes 30-60s — don't assume failure immediately
- Kill ALL paperclip processes before starting: `pkill -f "paperclip"; pkill -f "tsx.*index.ts"`
- Vite cache survives `rm -rf dist` — delete both: `rm -rf ui/dist ui/node_modules/.vite`

### Fork QoL Patches (not in upstream)

These are local modifications in the fork's UI. If re-copying source, these must be re-applied:

1. **stderr_group** — amber accordion for MCP init noise in `RunTranscriptView.tsx`
2. **tool_group** — accordion for consecutive non-terminal tools (write, read, search, browser)
3. **Dashboard excerpt** — `LatestRunCard` strips markdown, shows first 3 lines/280 chars

### Plugin System

PR #2218 (`feat/external-adapter-phase1`) adds external adapter support. See root `AGENTS.md` for full details.

- Adapters can be loaded as external plugins via `~/.paperclip/adapter-plugins.json`
- The plugin-loader should have ZERO hardcoded adapter imports — pure dynamic loading
- `createServerAdapter()` must include ALL optional fields (especially `detectModel`)
- Built-in UI adapters can shadow external plugin parsers; external override pause/resume should restore the built-in parser.
- Reference external adapters: Droid (npm); Hermes can also be tested as an override package.

## Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions. The token-only rule applies to all `ui/` changes: every color, spacing, radius, type, shadow, and motion value in `ui/src/components/**` and `ui/src/pages/**` comes from the token layer in `ui/src/index.css` — no hex, raw px, arbitrary Tailwind bracket values, or raw `font-size`/`fontSize` declarations in components, outside the documented allowlist in `ui/src/index.css`. Run `pnpm check:token-gates` (`scripts/check-token-gates.mjs`) before committing UI changes — it fails on any violation not covered by that allowlist.

## LOCAL OPERATIONS RULE — directive parameters override minimal-change instincts (Gate G8)

This section is local to the ThinkStack served tree (not upstream).

"Smallest relevant verification" and minimal-diff instincts apply to HOW you verify — never to WHAT you deliver. If the issue states explicit parameters (named wake paths to cover, a periodic mechanism to add, byte-identical operations, evidence formats, acceptance-criteria lists), those are acceptance criteria: deliver every one, or surface the conflict on the issue and get a decision BEFORE narrowing. Any shipped deviation must be labelled DEVIATION in the closeout and approved. Silent scope-narrowing is a malformed close (TSKB0055 Gate G8) and gets reopened.

<!-- BEGIN THINKSTACK OPS RULE: asset-custody-block -->
## Gate AC1 — durable artifact and TSKB custody (standing rule)

- Canonical knowledge base: `/Users/glad0s/TSKB`. A project or worktree `docs/TSKB/` folder is a consultation copy or draft pocket, never the permanent source of truth. Reusable process learning must be folded into the relevant canonical `~/TSKB/KB/` entry before the issue closes.
- **New KB entry? Use the door: `~/TSKB/bin/tskb-claim <SCOPE> "<Title>"`.** It allocates the number, writes the canonical file, and registers the `.numbers/` marker + README row in one step — never hand-write a `TSKBnnnn` filename or guess the next number. Already wrote the file some other way? `~/TSKB/bin/tskb-claim --adopt <path>` repairs it into the same registered state. Search first with `~/TSKB/bin/tskb-find <terms>` — if an entry already covers the topic, update it and bump its version instead of creating a sibling.
- Durable deliverables: create work under a path containing `work-products/<ISSUE-ID>/` (or the issue's established durable product folder), then upload every true review/delivery file to the Paperclip issue and create the matching artifact work product. A chat-only file, temp path, model cache, or worktree-only path is not a delivered asset.
- Preserve source plus render: for generated media, retain the editable/source inputs, prompts or provenance notes, and the final render. Do not overwrite an approved/released asset; create a new version and record what it supersedes.
- X10 custody is automatic only after the artifact reaches Paperclip storage or a recognized `work-products`/`artifacts` folder. The hourly custody job versions those roots into `/Volumes/X10 Pro/TSKB-Assets/TSAS - [ALL] - Paperclip Asset Custody - v1.0 - 07-26/`.
- Closeout evidence must link the Paperclip attachment/work product and cite any canonical TSKB delta. If no reusable learning occurred, say so; do not manufacture a KB change.
<!-- END THINKSTACK OPS RULE: asset-custody-block -->

<!-- BEGIN THINKSTACK OPS RULE: brand-mark-ban-block -->
## Gate BR1 — exact-file trio re-render ban (standing rule)

- **BANNED 2026-07-18:** only the three 1024px middle-column files confirmed in operator visual review: Cashflow Compass SHA `363a1f5202a3…`, Stack Lab SHA `e40056ee7176…`, and Vault Cases SHA `d54338e704ac…`. Their former paths and full hashes are in `/Users/glad0s/scripts/brand/banned-marks.json`.
- Do **not** extrapolate this into a shape, style, concept, family, colour, SVG, or future-original ban. The left-column shape/style is allowed and is being recreated. Future genuine originals are allowed.
- The right-column intro-slide stills (CC `37116fcfe690…`, SL `a91030eef30a…`, VC `84b8911db1b0…`) are approved reference evidence and must be preserved through the recreation pass; they are not canonical source files and may contain minor render discrepancies.
- Byte-identical copies of the three banned middle-column files are prohibited. Historical copies stay in quarantine/X10 versions as evidence only and must not return to active reference-lock paths.
- Originals are work in progress. Nothing from `/Volumes/X10 Pro/TSKB-Assets/Operator Review/Trio Originals - Working Review - 2026-07-18/WORKING COPY/` becomes canonical until the operator declares the review complete and a promotion pass records new hashes.
- Before trio brand work, run `/Users/glad0s/scripts/brand/check-banned-marks.sh`. A non-zero result blocks production and promotion.
<!-- END THINKSTACK OPS RULE: brand-mark-ban-block -->

<!-- BEGIN THINKSTACK OPS RULE: asset-rejection-block -->
## Gate AC2 — operator cleanup decisions (standing rule)

- The 2026-07-18 full custody review removed 209 files and installed 233 permanent additions. Exact decisions, paths, and SHA-256 hashes are in `/Users/glad0s/scripts/asset-custody/` and TSKB0069.
- A rejection is scoped to the exact former path plus exact bytes. Do not extrapolate it into a visual-family, file-type, brand, directory, or global same-hash ban. A different replacement at the former path is allowed; an identical file at another explicitly approved path is not automatically rejected.
- Never restore exact rejected bytes to a former source path from Git, X10 `versions/`, the immutable review baseline, Trash, model caches, work products, or chat attachments.
- The consolidated Hermes B-roll under `/Users/glad0s/scripts/brand/broll images/` and `/Users/glad0s/scripts/brand/broll video/` is an approved permanent asset library. New generated media must be saved to governed source/work-product paths, not left only in model caches.
- Before custody recovery, source restoration, or bulk asset promotion, run `/Users/glad0s/scripts/asset-custody/check-operator-rejections.sh`. A non-zero result blocks the operation.
<!-- END THINKSTACK OPS RULE: asset-rejection-block -->

<!-- BEGIN THINKSTACK OPS RULE: forge-studio-v1-block -->
## Gate FS1 — Forge Studio v1.2 is the canonical brand-production door

- Canonical source: `/Users/glad0s/scripts/brand-suite/forge-studio`; operator app: `/Users/glad0s/Applications/Forge Studio.app`; agent command: `/Users/glad0s/.local/bin/forge-studio`; full runbook: `/Users/glad0s/scripts/brand-suite/forge-studio/OPERATOR-AND-AGENT-RUNBOOK.md`.
- Require the CLI, local service and renderer to report `1.2.0` before producing assets. v1.2 retains the governed identity and material engine and adds the Founder Launch Kit: day-one readiness, exact virtual-meeting assets, contact/capabilities, onboarding and trust-template handoff within the hardened nine-step flow.
- For any new or upgraded canonical identity, responsive mark, brand pack, platform artwork, stationery, editable Office brand file, Founder Launch handoff, production handoff, brand adoption record, or drift audit, use the `forge-studio-ops` skill and start with `forge-studio doctor --json`.
- Complete the Business Launch Profile with real facts. Placeholder contact, proof, photography, credentials or legal details must remain visibly incomplete and must never be promoted into customer claims. Saved module switches define the release contents and manifest; do not imply a disabled module shipped.
- Dated `Studio-Forge-Working-Copy-*` directories are evidence only. Never install from them or hand their paths to a live consumer.
- Agents may create, verify, zip and acknowledge immutable **Candidate** releases. They may not approve, change source custody, restore known good, publish to X10, or register a Draft/Candidate as live usage.
- Reuse an Approved release before generating a replacement. Record the exact release entry, integrity count, permanent consumer path and drift result; a chat attachment or temporary render is not adoption evidence.
- The legacy `brandsuite forge` path is compatibility-only and must not create new canonical assets.
<!-- END THINKSTACK OPS RULE: forge-studio-v1-block -->

<!-- BEGIN THINKSTACK OPS RULE: verify-by-artifact-block -->
## Gate VA1 — closure is a measurement, not a claim (standing rule)

- An issue with a numeric quota/target closes ONLY when the artifact count at the governed path (`work-products/<ISSUE-ID>/` or the path named on the card) meets it. State the path and the count in the closing comment. Files in run scratch, git worktrees, or shared model caches (`~/.hermes/cache/…`) count as ZERO — those locations are purged or cross-contaminated.
- Bank every generated asset into the governed path IMMEDIATELY at creation. Never batch-copy later from a shared cache: concurrent lanes write to the same cache and timestamp-matching delivers other lanes' files (proven 2026-07-30).
- Renders of canon characters or locked brand marks MUST pass the locked reference images as image refs. Text-only prompts of canon subjects are a defect (Fluffy-as-cat class). No readable fake product content (fake planner pages, invented data) in listing or product imagery.
- A close that cites a run, model, or benchmark result must quote the artifact — run id, file path, or ledger row. A prose description of work is not evidence. Model labels name the REQUEST; served-model truth requires the retirement/alias map (grok-4-fast→grok-4.3 class).
- Before declaring an artifact missing through a search-class door or agent procedure, inspect `ARCHIVED.txt` pointers in its expected parent work-products tree (and `DR-ARCHIVE-INDEX.tsv` when present); an archived pointer is a location, not absence.
- An incident or defect close must name its recurrence mechanism AND the layer it is encoded in, preferring the highest that fits: platform guard > pipeline script/driver > standing rule (this registry) > skill > KB note. A lesson that exists only as prose in a comment is NOT closed.
<!-- END THINKSTACK OPS RULE: verify-by-artifact-block -->

<!-- BEGIN THINKSTACK OPS RULE: operating-model-qec-block -->
## Gate OM1 — Operating model: role architecture + QEC (standing rule)

Binding across all companies (operator directive 2026-08-06, TSMC-20266; forensics TSKB0403).

**Role architecture — who does what:**
- **Lower lanes (drafters / specialists / general):** cheap models + skills, biased for action, PRODUCE the deliverables. Cheap+skill is the target and beats strong for execution classes (validated).
- **C-level lanes (CTO/CMO/CFO): GUARD and DELEGATE.** Delegate with authority in SMALL BATCHES to able lanes; verify outcomes; keep the team unblocked. C-levels do NOT do routine work, do NOT write copy, do NOT execute deliverables. A C-level caught executing is a routing defect — file it.
- **CEO lanes:** orchestrate and delegate to C-level and down-chain. Focus on shipping, revenue, unblocking.
- **Routine work runs on cheap lanes or shell handlers ONLY** — never CEO/C-level lanes (TSMC-20230 script demotions, TSMC-20025 rail diet).

**Escalations flow to the NEXT IN LINE and resolve THERE.** specialist → their C-level → CEO(-Codex) → board (governance/spend) or TSMC (platform/runtime only). An escalation that skips a level is itself a defect. Rarely reach C-level; almost never the board.

**QEC gates — link every closure to them:**
- **Q**uality: two-tier QA (TSMC-20243) — cheap first-pass, strong on failure; G-class gates untouched; defect-escape reported weekly.
- **E**fficiency: batch pickup (TSMC-20250) + thread checkpoints (TSMC-20242) + delegation-in-small-batches; fresh-session ratio and runs/day on the daily rollup.
- **C**ost: price-weighted model selection (TSMC-20229 ledger weights) — every lane's model choice justified by weighted score for its role class; bench audit locks choices per role.
<!-- END THINKSTACK OPS RULE: operating-model-qec-block -->

<!-- BEGIN THINKSTACK OPS RULE: fleet-class-fix-escalation-block -->
## Gate FLEET1 — fleet-class local fix + TSMC card (standing rule)

When any OpCo fixes a defect whose CLASS plausibly exists in other OpCos (shared adapters, static-assignee dispatch, guard behaviours, poller patterns, platform-surface quirks), filing an **assigned** TSMC card is part of the fix in the same session — not optional follow-up. Local product/config stays yours; do not modify Paperclip the platform (see `escalate-platform-work-to-tsmc`). Card must describe the class (not only your instance), attach the local fix as template, and carry an assignee. Reference the TSMC id in the close comment. Canonical process: **TSKB0385**. TSMC owns dedupe/standardise/rollout — do not invent parallel fleet alert paths.
<!-- END THINKSTACK OPS RULE: fleet-class-fix-escalation-block -->
