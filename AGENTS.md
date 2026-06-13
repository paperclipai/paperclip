# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

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

This is a fork of `paperclipai/paperclip` with QoL patches and an **external-only** Hermes adapter story on branch `feat/externalize-hermes-adapter` ([tree](https://github.com/HenkDz/paperclip/tree/feat/externalize-hermes-adapter)).

### Branch Strategy

- `feat/externalize-hermes-adapter` → core has **no** `hermes-paperclip-adapter` dependency and **no** built-in `hermes_local` registration. Install Hermes via the Adapter Plugin manager (`@henkey/hermes-paperclip-adapter` or a `file:` path).
- Older fork branches may still document built-in Hermes; treat this file as authoritative for the externalize branch.

### Hermes (plugin only)

- Register through **Board → Adapter manager** (same as Droid). Type remains `hermes_local` once the package is loaded.
- UI uses generic **config-schema** + **ui-parser.js** from the package — no Hermes imports in `server/` or `ui/` source.
- Optional: `file:` entry in `~/.paperclip/adapter-plugins.json` for local dev of the adapter repo.

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
- Built-in UI adapters can shadow external plugin parsers — remove built-in when fully externalizing
- Reference external adapters: Hermes (`@henkey/hermes-paperclip-adapter` or `file:`) and Droid (npm)
