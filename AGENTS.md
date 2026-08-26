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
- `packages/skills-catalog/`: app-shipped skills catalog (`@paperclipai/skills-catalog`)
- `packages/teams-catalog/`: app-shipped teams catalog (`@paperclipai/teams-catalog`)
- `cli/`: `paperclipai` CLI package (published bin, agent-facing commands)
- `skills/`: Paperclip runtime/operational skills (not part of the app catalog)
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
- An implementation card (`[impl]`, platform/code change, or any card whose deliverable is a commit) closes ONLY with the commit SHA(s) in the closing comment, and the SHA must be reachable in the target repo (`git log --all`). If the change must be live to count, cite the promote receipt too. A `done` without a reachable SHA is a false close and will be reopened (TSMC-21553/54/55 class, 2026-08-25: three P0s closed with zero commits anywhere).
<!-- END THINKSTACK OPS RULE: verify-by-artifact-block -->

<!-- BEGIN THINKSTACK OPS RULE: operating-model-qec-block -->
## Gate OM1 — Operating model: role architecture + QEC (standing rule)

Binding across all companies (operator directive 2026-08-06, TSMC-20266; forensics TSKB0403).

**Role architecture — who does what:**
- **Lower lanes (drafters / specialists / general):** cheap models + skills, biased for action, PRODUCE the deliverables. Cheap+skill is the target and beats strong for execution classes (validated).
- **C-level lanes (CTO/CMO/CFO): GUARD and DELEGATE.** Delegate with authority in SMALL BATCHES to able lanes; verify outcomes; keep the team unblocked. C-levels do NOT do routine work, do NOT write copy, do NOT execute deliverables. A C-level caught executing is a routing defect — file it.
- **CEO lanes:** orchestrate and delegate to C-level and down-chain. Focus on shipping, revenue, unblocking.
- **Routine work runs on cheap lanes or shell handlers ONLY** — never CEO/C-level lanes (TSMC-20230 script demotions, TSMC-20025 rail diet).

**DELEGATION RECEIPT LAW (2026-08-21 — five hollow delegations in 24h: TSM CMO loop ×4, TSK provisioning).** "I'll route this to X" is NOT a delegation. A delegation is complete ONLY when, in the SAME run, you have ALL of:
1. the child card CREATED via the API and its returned issue id READ BACK (quote the id in your comment);
2. the executor lane INVOKED on that id (or the assignment event confirmed);
3. verification that the child card exists — re-read it before you claim the handoff.
A routing memo without a landed, verified child card is a FAILED run: say so plainly and leave the parent card todo — never close/complete on intent. Corollary for the board and routers: if a card in your hands requires EXECUTION (build, provision, render, write the deliverable), you either delegate it per the above IN THIS RUN or state you cannot — a C-level/CEO lane holding an execution card for more than one run without a landed child is the routing defect, and the card must be reassigned to an executor lane.

**Escalations flow to the NEXT IN LINE and resolve THERE.** specialist → their C-level → CEO(-Codex) → board (governance/spend) or TSMC (platform/runtime only). An escalation that skips a level is itself a defect. Rarely reach C-level; almost never the board.

**QEC gates — link every closure to them:**
- **Q**uality: two-tier QA (TSMC-20243) — cheap first-pass, strong on failure; G-class gates untouched; defect-escape reported weekly.
- **E**fficiency: batch pickup (TSMC-20250) + thread checkpoints (TSMC-20242) + delegation-in-small-batches; fresh-session ratio and runs/day on the daily rollup.
- **C**ost: price-weighted model selection (TSMC-20229 ledger weights) — every lane's model choice justified by weighted score for its role class; bench audit locks choices per role.

**Sprint-report / daily-summary closure counts (TSMC-20945 / TSMC-20879):**
Closed-task counts in every CEO daily summary or sprint report MUST be sourced from GET /companies/:id/issues/status-events/digest with since set to the reporting-window start; do not use updated_at heuristics or raw SQL for summary counts.
Prefer the governed rollup digest work-product when it already cites that endpoint; never invent closures.

**RUN DISPOSITION LAW (2026-08-22 — 470 runs/day measured ending with no disposition, each triggering a status-only corrective handoff run):** EVERY run ends with an explicit disposition in its final message: `continuing` (state exactly what the next step is), `done` (with artifacts that ls), or `blocked` (with the named blocker recorded as a blockedBy relation or unblockDescriptor). A run that ends in narration with none of these is a FAILED run and costs the fleet a corrective wake. If you are mid-task and out of turns, say `continuing:` plus the next concrete action in one line — that single line is the difference between seamless continuation and a recovery cycle.

**DELEGATION DOOR for confined ACP lanes (2026-08-22 — root cause of the recurring hollow-delegation disease):** confined ACP lanes (all codex C-levels) have NO control-plane write access — they cannot create child cards by API, which made the Receipt Law impossible for them and produced ~1,500 routing-narration runs/day with zero landed children. Their door is the marker: end your final message with one line per child (max 3 per run):
`PAPERCLIP_DELEGATION: {"title":"<child card title>","description":"<scope + close bar>","assignee":"<exact lane name>","priority":"high|medium|low"}`
The platform creates the child, assigns it, wakes the assignee, and posts the receipt on your card ("Delegation landed: XXX-123 → lane"). An open card with the identical title is REUSED, never re-minted. A delegation stated this way satisfies the Receipt Law; routing narration without either an API-created child or this marker remains a FAILED run. Lanes WITH API access keep using the API path.

**CAPABILITY ROUTING — engine economics (2026-08-22, data-backed):** codex ACP lanes cannot drive mutating local services (Site Studio :4683, Forge Studio :4680) or call the board API directly. **Network and host-side work routes to HERMES — see Gate NET1 for the lane capability table and the automatic handoff; do not restate it here.** Do NOT flip a high-volume codex lane to `engine: "cli"` to gain access: measured 2026-08-22, CLI-engine runs cost ~450K fresh tokens per issue versus ~50K warm ACP runs. `engine: "cli"` is reserved for LOW-volume access-bound lanes by explicit operator decision. Routers, C-levels and the board: never assign studio/CLI-mutating cards to codex ACP lanes.
<!-- END THINKSTACK OPS RULE: operating-model-qec-block -->

<!-- BEGIN THINKSTACK OPS RULE: fleet-class-fix-escalation-block -->
## Gate FLEET1 — fleet-class local fix + TSMC card (standing rule)

When any OpCo fixes a defect whose CLASS plausibly exists in other OpCos (shared adapters, static-assignee dispatch, guard behaviours, poller patterns, platform-surface quirks), filing an **assigned** TSMC card is part of the fix in the same session — not optional follow-up. Local product/config stays yours; do not modify Paperclip the platform (see `escalate-platform-work-to-tsmc`). Card must describe the class (not only your instance), attach the local fix as template, and carry an assignee. Reference the TSMC id in the close comment. Canonical process: **TSKB0385**. TSMC owns dedupe/standardise/rollout — do not invent parallel fleet alert paths.
<!-- END THINKSTACK OPS RULE: fleet-class-fix-escalation-block -->

<!-- BEGIN THINKSTACK OPS RULE: board-ask-verification-block -->
## Gate ASK-V — no board ask enters the queue unverified (standing rule, 2026-08-17)

Born from an operator session where 8 of 8 presented board asks were stale or false: packs "awaiting send" that the tracker already showed APPLIED; a "submit the packet" escalation for a packet the operator submitted weeks earlier (the external-wait card said so); "capture LinkedIn verification" after the resubmission had already gone in; five watch/listen gates with no validly-passed artifact behind any of them. Every false ask burns operator trust and buries the real ones.

Standing rules for ANY item aimed at the operator (boardAction, [BOARD ACTION], escalations, watch/listen requests, decision asks):

1. **Verify the premise at RAISE time, against artifacts** — the tracker/DB state, the external-wait card, the named file on disk, the register — never against card text or memory of card text. If the artifact already shows the action done, the ask is void: fix the stale card instead of raising the ask.
2. **Name the artifact in the ask.** Every ask must state WHAT was checked, WHERE it lives (path/id/URL), and WHEN it was checked. An ask without a named, checked artifact is malformed and must not be created.
3. **Duplicate-check first**: if an existing card already tracks the same action (especially an external-wait card), comment there — never mint a fresh escalation.
4. **Watch/listen asks** additionally require a named on-disk artifact behind a VALID gate pass (see Gate QA-AUTH). No artifact, no ask.
5. C-level premise audits (Gate META1) treat any ask lacking these fields as a defect: close it with the evidence of what the artifact actually shows, and register the minting lane on TSKB0055.
<!-- END THINKSTACK OPS RULE: board-ask-verification-block -->

<!-- BEGIN THINKSTACK OPS RULE: meta-card-audit-block -->
## Gate META1 — C-level premise audit of system-minted cards (standing rule, 2026-08-17)

System-minted meta cards — titles starting `Unblock:`, `Recover missing next step`, `Recover stalled issue`, `Starved lane:`, `Dead lane:`, `Agent config drift:`, `Review productivity`, or `[GUARD COURIER]` — are claims about the system, and claims go stale. On 2026-08-17 the board closed 95+ of them in one sweep because their premises were already false (the "paused" lane had 15 succeeded runs; the "dead" lane succeeded that morning; the blocker card was already cancelled). No lane had checked. That never happens again:

**Every CEO/CTO sprint-report or cadence pass MUST premise-audit the open meta cards in its own company (≤1 run of budget, artifacts only):**

1. **Lane-health mints** (`Starved/Dead/drift/productivity`): query the named lane's recent runs. A succeeded run inside the claimed window kills the premise → close the card quoting the run id (agent-lane-health law). A standby sister with zero assigned cards is POSTURE, not drift → close, and say so.
2. **Recovery/Unblock children**: read the root card they point at. Root terminal, superseded, or sanctioned-external-blocked (named external owner/action) → close the child citing that; the ROOT is the only card that stays.
3. **Guard couriers**: if the guard is green now, or the finding names a resolved state, close with the guard's current output.
4. **Never** mint a child on a meta card, never mint a second card for a premise that already has one — comment on the existing card instead. Duplicate meta cards are the defect (TSMC-20961), not diligence.
5. Anything you close, close with the artifact (run id, guard output, root card status) in the comment. A close without evidence is a malformed close (TSKB0055).

A meta card older than 48h that no C-level has premise-audited is itself a defect: register it on TSKB0055 with the company CEO as cause.
<!-- END THINKSTACK OPS RULE: meta-card-audit-block -->

<!-- BEGIN THINKSTACK OPS RULE: net-fetch-door-block -->
## Gate NET1 — external-network work is HERMES work; hand off, never block (standing rule, 2026-08-23)

⛔ There is **no net-fetch door**. An earlier version of this rule pointed at `$PAPERCLIP_NET_FETCH_URL`, which is not wired for any adapter this fleet runs. Do not look for it and do not cite it.

| lane | external network |
|---|---|
| `hermes_local` | **YES** — runs on the host |
| `codex_local` | **NO** — ACP sandbox, DNS fails. `trust_level = "trusted"` is FILESYSTEM trust only |
| `claude_local` | **NO** — treat as sandboxed |
| `antigravity_local` | unproven — do not rely on it |

Holding a credential is not the same as reaching the network.

**If your work needs to reach anything outside this machine and you are not a Hermes lane, it is not your work.** Etsy, Bluesky, x_search, image and video generation, the Studio suite, any vendor API, any credentialed POST, any web fetch.

**Do not open an Unblock child card and do not invent an escalation chain.** Leave ONE comment naming the surface you need and stating it requires host egress, then dispose `blocked`. That comment is the handoff.

The handoff is **mechanical**: `idle-lane-work-sweep` reassigns egress-class cards to a healthy Hermes sister, flips the card to `todo`, and wakes it. Do not reassign by hand.

**If you ARE a Hermes lane**, a card arriving with a handoff comment is yours — do not send it back. If it truly cannot be done (credential missing, account locked, vendor down), that is a credential gate: say exactly what the operator must provide. Never describe a credential gate as a sandbox problem.

### Three classes, three destinations

- **Egress** ("cannot reach", "DNS", "sandbox", "host-side") → routed to Hermes automatically. Not a board matter.
- **Credential gate** ("re-authenticate", "token ceiling", "secret custodian") → operator only. Routing it elsewhere just moves the block.
- **Dependency** ("waiting on card Y") → leave it; it clears when Y clears.

> Evidence: TSMC-21357, TSB-5476.
<!-- END THINKSTACK OPS RULE: net-fetch-door-block -->

<!-- BEGIN THINKSTACK OPS RULE: qa-signoff-authority-block -->
## Gate QA-AUTH — QA signoff authority is non-transferable and capability-bound (standing rule, 2026-08-17)

Born from TSM-6519: while the visual-QA lane (Cerberus) was paused, a lane-authored "requeue packet" transferred its sole signoff authority to an engineer lane whose only tools are terminal/read/search — a lane that cannot render or see a single frame — and it signed a visual QA PASS. The invalid pass then queued the operator to watch a master that had never actually been QA'd.

Standing rules, all lanes, all companies:

1. **No lane may transfer, delegate, or accept gate-signoff authority via packets, comments, or briefs.** Gate signers are set by the BOARD only. A lane-authored authority transfer is void the moment it is written, and acting on one is a TSKB0055 defect for both the author and the acceptor.
2. **A signer must possess the modality the gate checks.** Visual gates require a lane that renders/views frames; audio gates require audio tooling; copy gates require the deterministic lints. Signing a gate you cannot exercise is a false close — the PASS is void on its face, whatever the checklist says.
3. **A paused gate-signer means the gate WAITS** (sanctioned block naming the signer), or the board appoints a capable replacement. It never means the next available lane inherits the pen.
4. Any lane that discovers a pass signed outside these rules must void it in place (comment naming the signer and the missing capability) and re-queue the gate — never build on it.
<!-- END THINKSTACK OPS RULE: qa-signoff-authority-block -->

<!-- BEGIN THINKSTACK OPS RULE: search-scope-block -->
## Gate SRCH1 — scope every search (standing rule, 2026-08-24)

Tool output is **never cached** and is re-sent in full on every later turn, so a broad search costs its own size again each turn.

1. **Never search `~`, `/Users/<you>`, or a whole knowledge base.** Start in your project workspace; widen only after a scoped search has failed, and say why.
2. **Never grep a bare common word.** Use a distinctive phrase, filename pattern, or path prefix.
3. **Narrowest tool first**: known path → read it; known directory → list it; only then search.
4. **Two searches, then stop.** If two scoped searches have not found it, write `[OPERATOR: …]` or state the gap and continue. A third will not find it either.
5. Save output to disk **before** speculative searching — a run stopped on a ceiling keeps what is already written.

## Gate SRCH2 — one shell turn, not four

**Every tool call is a turn, and every turn re-sends your whole instruction bundle plus the conversation so far.** Turns are the dominant cost of a run, more than the size of any single result.

- **Chain with `&&`** everything you already know you need: `cd /path && ls -la && cat notes.md`. Do not run one command to decide the next when you could have run both.
- **`cd` alone is wasted** — the working directory does not persist between calls.
- **Read a file once.** If you need it again it is already above you in the conversation.
- Prefer `view_file` over `cat` for anything you will quote; one good `grep -n` over three narrowing ones.
- Verify your own write once, not twice.

## Writing a card for another lane? Name its inputs

The cheapest lever there is, and it outperforms both rules above.

- **Name the files.** `Read exactly: <path>` beats "consult the workspace".
- **Say what to do when it is not there** — a lane with no exit condition searches until something stops it.
- **Never write "find the existing X"** unless you have confirmed X exists.
- Bound the deliverable: word counts, item counts, one file out.

A card that names its inputs makes Gate SRCH1 unnecessary. A card that does not makes it unenforceable.

> Measurements behind these rules: TSMC-21369, TSMC-21370. Mechanical ceiling: `maxToolCallsPerRun` (TSMC-21368).
<!-- END THINKSTACK OPS RULE: search-scope-block -->

<!-- BEGIN THINKSTACK OPS RULE: deploy-scripts-operator-only-block -->
## Gate DEPLOY1 — pinned deploy scripts are operator/TSMC-only

`pinned-deploy-promote.sh` and any wrapper that can move a production deploy
pointer are operator/TSMC execution surfaces. Agent lanes must not invoke them,
delete or recreate their deployment lease, or receive the break-glass
`PAPERCLIP_PINNED_DEPLOY_ALLOW_AGENT_CALLER=1` environment variable. The script
itself refuses any mutating sub-command when it detects `PAPERCLIP_AGENT_ID` or
`PAPERCLIP_RUN_ID` in its environment (the signature Paperclip injects into
every agent run), unless an operator explicitly sets that override outside an
adapter wrapper. Read-only sub-commands (`show-receipt`, `assert-green`,
`lint-plists`) stay available to lanes. Implemented in
`scripts/pinned-deploy-promote.sh` (`assert_not_agent_lane`, commit `618796ffb`
in `~/paperclip-deploy`).

If a promotion is needed, an agent prepares evidence and hands the exact command
and candidate SHA to the operator/TSMC deploy owner; it does not attempt to
unblock itself by modifying the lease directory.
<!-- END THINKSTACK OPS RULE: deploy-scripts-operator-only-block -->

<!-- BEGIN THINKSTACK OPS RULE: episode-pipeline-block -->
## Gate EP1 — episode plans: write prose, never deck JSON (standing rule)

- **The deck spec is DERIVED, never hand-authored.** Run `~/scripts/deck/plan-to-episode.sh <ISSUE-ID> --channel <slug> --title "<Episode Title>"` — it lints the script, derives the deck, gates it, generates chapters + ad markers, and gates every banked artifact. **Exit 0 is the close bar; nothing else counts.** It is idempotent and there is no `--force`. On 2026-08-25 three lanes each hand-authored a deck spec, banked eight artifacts and closed: all three decks failed preflight and one had invented its own schema (`episode/runtime_s/canon/deck` where the pipeline reads `channel/slides/endScreen`). Full brief: `~/scripts/deck/EPISODE-PLAN-BRIEF.md`.
- **`channel` is the SLUG** — `vault-cases`, `cashflow-compass`, `stack-lab`, `jessica-james`. "Cashflow Compass" and "Stack Lab" are display names and fail the runtime-band gate silently.
- **A spoken line contains ONLY what is said.** Visual cues go on `[VISUAL]` lines and never enter the voice track. Real defects: `Ursa: "Lower-third: Flight 305 | 1971 Boeing 727..."` and three Cashflow paragraphs ending `[Disclaimers: Data from LendingTree / NY Fed Q1 2026...]` — both would have been read aloud, brackets and all. Disclosures belong on screen and in the description.
- **Write to the runtime band in WORDS.** ⛔ Timing headers do not add narration — only words do. All three 08-25 scripts declared a runtime in their own header and carried under half the prose to reach it. Targets: vault-cases 1638–2418 · cashflow-compass 897–1170 · stack-lab 1014–1482 · jessica-james 468–780.
- **B-roll must PROVE the claim it sits under.** ⛔ Never cover a spoken claim with an unrelated clip — that is what produced the slideshow corpus, and round-robin assignment produces it automatically ("a plane shot in a pirate episode"). Where the library has nothing relevant the converter declares a GAP with a generation prompt in `05-broll-gaps.json`; gate G9 blocks the build until gaps are filled. **A declared gap is honest; a wrong clip is a lie the viewer can see.** Atmosphere clips are backdrop for chapter/bullet slides only, never the sole visual under a fact.
- **Narrators come from `~/scripts/deck/canon-voices.json`.** That file is the lock, not a board comment. Narration is non-deterministic — use `deck/tts-take.sh` to generate N takes and bank them, because a performance cannot be regenerated.
- **Recommend what your research supports.** A tool we do not run internally is not disqualified on a teardown channel; sourcing is the standard, not our own stack (operator, 2026-08-25). An unsourced figure is a sourcing defect, not a topic defect.
- **A gate that counts artifacts is not a gate.** Existence was never the question — `artifact-gate.sh` validates, and `artifact-gate-sweep.sh` re-checks closed cards daily. A close bar written in a card description is prose, not enforcement.
- **Storyboard in STILLS before rendering video.** An image costs 200,000,000 ticks; a video costs 4,000,000,000 — **20×**. Run `deck/storyboard-frames.sh` to see every shot, review the contact sheet, mark `approved: true`, then convert survivors with `deck/fill-broll-gaps.sh --from-frames`, which passes the approved frame to the video call as `image_url` so the clip inherits the look that was signed off. ⛔ Rendering video straight from text is how a "1971 Boeing 727" prompt returned a modern widebody twice at full price; naming the three tail engines explicitly fixed it for 0.2 of one video's cost. `approved: null` is unreviewed, and unreviewed is not approved.
- **Storyboard frames cost nothing — render them.** `deck/storyboard-frames.sh` defaults to the **ChatGPT/Codex subscription** (`deck/gen-image-codex.py`) — off the Grok video allowance and off the Studio; `IMAGE_PROVIDER=xai` only when the frame must pass to the video call as `image_url`. ⛔ **No local/on-device image generation on the Studio** — FLUX on MLX peaked at 8.46 GB on the box running the live fleet and was removed; if we want it, it goes on the Mini. Review with `deck/review-frames.sh --approve 1,4,7`. ⛔ Every clip entering a library goes through `deck/clip-qa.sh` first — it catches burned-in garbage text, watermark residue, wrong aspect, a stray generated audio track and frozen footage, all of which have shipped before. Use `--kind ui_capture` when readable text is the proof rather than the defect. For Stack Lab's `ui_capture` beats use `deck/ui-capture.py`, which drives a real browser through real pages; ⛔ never log in and never capture anything behind a credential.
<!-- END THINKSTACK OPS RULE: episode-pipeline-block -->

<!-- BEGIN THINKSTACK OPS RULE: ceiling-disposition-block -->
## Gate CEIL1 — read WHICH ceiling was hit before you touch a stalled card

A card rejected *before model dispatch* can be in four states that look identical on the board
— `blocked`, going nowhere — and they need four different repairs. ⛔ **A status bounce to
`todo` is the wrong answer to all four**, and it is the one most often reached for: tried on
39 cards 2026-08-26, it would have fixed 14 and looked like a clean sweep.

Read the rejection comment, then act:

- **"already used 25 generation runs since the last board/user comment"** → a **board comment
  resets the counter**. Post one, then give the card a real disposition — often the work is
  already done and it should simply close.
- **"already recorded N weighted aggregate input tokens"** → past the 1M ceiling. **Now check
  the `This run` line on the rejection**, because there are two shapes and only one is fixed by
  a re-cut:
  - *no single run is near the cap* → **re-cut**; the fresh budget buys real headroom.
  - *`This run` alone exceeds the threshold* → ⛔ **a re-cut is useless.** The successor gets a
    clean 1M and its first run spends it. Bricks every time, forever, one full run per attempt.
    Seen: 1.82M in a single run on a re-cut whose description was 1,457 chars, so nothing was
    inherited. **Bound what the run reads, split the scope, or route the deterministic half to
    a script.** A card already labelled "re-cut #2" that bricks again is this shape by
    definition — stop cutting.
- **`origin_kind: routine_execution` and blocked** → that instance is the routine's
  **concurrency anchor**. While it sits there the routine cannot mint a new one and keeps
  reporting `active`. **Cancel it** — never re-cut, the routine is its own carrier. Measured:
  DP's `fallback-swap-back` dead six weeks, TSM's `Mission Control Inbound` dead four days,
  both showing `active` throughout.
- **`blocked` with every blocker terminal and no ceiling** → status correction only. The
  platform now does this itself when blockers resolve; anything older needs clearing by hand.

⛔ **Approval does not revive a ceiling-bricked card.** Only a fresh card or a real
`board_token_exceptions` entry changes the counter. Asking the board to "approve more budget"
on the bricked card is a no-op that costs a round trip.

Full taxonomy and evidence: **TSKB0493**.
<!-- END THINKSTACK OPS RULE: ceiling-disposition-block -->
