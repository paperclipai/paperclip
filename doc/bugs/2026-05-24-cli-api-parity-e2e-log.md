# 2026-05-24 CLI API Parity E2E Log

## Scope

Full Paperclip CLI/API parity smoke pass against a disposable local source-tree instance.

## Isolation Contract

- Repo: `/Users/aronprins/Documents/PaperclipAI/paperclip`
- Scratch root: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity`
- `PAPERCLIP_HOME`: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home`
- `PAPERCLIP_INSTANCE_ID`: `cli-api-parity`
- `PAPERCLIP_CONFIG`: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/config.json`
- `PAPERCLIP_CONTEXT`: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/context.json`
- `PAPERCLIP_AUTH_STORE`: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/auth.json`
- `PAPERCLIP_API_URL`: `http://127.0.0.1:3197`
- `PAPERCLIP_SERVER_PORT`: `3197`
- `PORT`: `3197`
- `CODEX_HOME`: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/codex-home`
- `CLAUDE_HOME`: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/claude-home`
- `DATABASE_URL`: unset
- `DATABASE_MIGRATION_URL`: unset

## Current IDs

- Company ID: `12e9db4b-f66c-459b-959e-d645002240fb`
- Imported Company ID: `0bdc6f69-733d-4b1c-b5c6-2246f9582598` (deleted from DB)
- Agent ID: `1dd601a1-031a-4225-b005-419427fd059f`
- Goal ID: `5b2a9135-1044-48d6-a17d-6b91dd9fdc74`
- Project ID: `d32032ce-d95e-4c4e-a942-dd98498025fb`
- Issue ID: `f0250734-95f1-4c28-9e10-f1954649fffb` (`CLI-1`)
- Checkout/release Issue ID: `1f7540d3-a3d3-48d2-b6c5-00d72c064e8f`
- Prompt Issue ID: `38b89e46-a775-43bc-a39a-c44ccd1f7f30`
- Board token ID: `45d843a2-9334-4dda-b53a-cd6f7e62149a` (revoked)
- Agent token ID: `d464c3fe-c760-4c1c-b6cd-f8f0cd6c1797` (revoked)

## Command Log

### 2026-05-24T11:06:22+02:00 - Read runbook and docs

- Command: `sed -n ... paperclip-localdev-runbook.md`, `doc/DEVELOPING.md`, `doc/CLI.md`, `doc/DATABASE.md`, `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEPLOYMENT-MODES.md`, `doc/plans/2026-05-23-cli-api-parity-openapi-reference.ts`
- Purpose: Establish the required isolated local-dev workflow and CLI/API parity reference.
- Prerequisites/IDs used: none.
- Expected result: Docs confirm scratch home, non-default port, embedded DB, and CLI command shapes.
- Actual result: Runbook requires explicit scratch paths, port `3197`, unset database env vars, `pnpm paperclipai onboard --yes --run --bind loopback`, and pre-test isolation checks.
- Status: PASS.
- Output summary: No destructive command run yet. `doc/bugs` did not exist, so this file defines the log format.
- Follow-up: Start isolated instance only after environment verification.

### 2026-05-24T11:06:22+02:00 - Pre-start isolation check

- Command: `env -u DATABASE_URL -u DATABASE_MIGRATION_URL ... zsh -lc 'printf ...'`; `lsof -nP -iTCP:3197 -sTCP:LISTEN || true`
- Purpose: Confirm all required environment variables resolve to the scratch instance and the non-default server port is free.
- Prerequisites/IDs used: none.
- Expected result: All Paperclip/Codex/Claude paths point under `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity`; `DATABASE_URL` and `DATABASE_MIGRATION_URL` are unset; port `3197` has no listener.
- Actual result: All required variables matched the isolation contract, database URLs were `<unset>`, and no listener was present on `3197`.
- Status: PASS.
- Output summary: No references to `~/.paperclip`, `~/.codex`, `~/.claude`, or `localhost:3100`.
- Follow-up: Start Paperclip with the runbook command.

### 2026-05-24T11:06:45+02:00 - Start isolated instance

- Command: `env -u DATABASE_URL -u DATABASE_MIGRATION_URL ... pnpm paperclipai onboard --yes --run --bind loopback`
- Purpose: Create and start the disposable source-tree Paperclip instance.
- Prerequisites/IDs used: scratch env from Isolation Contract.
- Expected result: Onboarding writes config, `.env`, secrets key, logs, storage, and embedded DB under the scratch instance; server listens on `127.0.0.1:3197`.
- Actual result: Server started in `local_trusted/private` mode on `127.0.0.1:3197`, with embedded PostgreSQL data at `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/db`.
- Status: PASS.
- Output summary: Doctor passed 9 checks. Server selected embedded PostgreSQL port `54330` after `54329` was already in use. Health URL: `http://127.0.0.1:3197/api/health`.
- Follow-up: Run second-shell isolation checks before parity mutations.

### 2026-05-24T11:07:15+02:00 - Verify started instance isolation

- Command: `pnpm paperclipai env`; `pnpm paperclipai context show --json`; `curl -sS http://127.0.0.1:3197/api/health`; `find tmp/cli-api-parity/home -maxdepth 4 -type d`
- Purpose: Confirm the CLI and API target the disposable instance.
- Prerequisites/IDs used: isolated env; server session from previous step.
- Expected result: Config/context/auth paths are scratch paths; context path is scratch; health succeeds on `127.0.0.1:3197`; DB directory is under scratch home.
- Actual result: Config path, context path, storage path, secrets key path, and DB directory all resolve under `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity`; health returned `status: ok`, version `0.3.1`, `deploymentMode: local_trusted`, `companyDeletionEnabled: true`.
- Status: PASS.
- Output summary: `paperclipai env` redacted here because it prints the generated `PAPERCLIP_AGENT_JWT_SECRET`. Context existed at the scratch path with an empty `default` profile.
- Follow-up: Set API context and begin CLI parity checks.

### 2026-05-24T11:08:20+02:00 - Basic context/auth/connectivity

- Command: `pnpm paperclipai context set --api-base http://127.0.0.1:3197 --use --json`; `pnpm paperclipai whoami --json`; `pnpm paperclipai company list --json`; `pnpm paperclipai access whoami --json`
- Purpose: Exercise context setup/show, auth/access identity, and initial company listing.
- Prerequisites/IDs used: isolated env; no company ID yet.
- Expected result: Context stores non-default API base; `whoami` reports the implicit local board; company list is empty; documented `access whoami` either works or reveals current command drift.
- Actual result: `context set --api-base` wrote `apiBase: http://127.0.0.1:3197`; `whoami` returned `local-board` with `isInstanceAdmin: true`; company list returned `[]`; `access whoami` failed with `unknown command 'access'`.
- Status: PASS with docs/runbook mismatch.
- Output summary: Current CLI exposes `whoami` as a top-level command. The runbook/docs command `access whoami` is stale for this checkout.
- Follow-up: Use top-level `whoami` for access checks and record the mismatch below.

### 2026-05-24T11:09:14+02:00 - Company create/get/update/context

- Command: `pnpm paperclipai company create --payload-json '{"name":"CLI API Parity Test","description":"Disposable company for CLI API parity testing","goal":"Exercise the CLI API surface end to end"}' --json`; `pnpm paperclipai context set --company-id 12e9db4b-f66c-459b-959e-d645002240fb --use --json`; `pnpm paperclipai company get 12e9db4b-f66c-459b-959e-d645002240fb --json`; `pnpm paperclipai company update 12e9db4b-f66c-459b-959e-d645002240fb --payload-json '{"description":"Updated by CLI API parity test","budgetMonthlyCents":12345}' --json`
- Purpose: Exercise company creation, retrieval, update, and default company context.
- Prerequisites/IDs used: board identity; API base context.
- Expected result: Company is created, can be fetched, update persists, and context keeps both `apiBase` and `companyId`.
- Actual result: Company create/get/update succeeded. Created company `12e9db4b-f66c-459b-959e-d645002240fb`. Update changed description and `budgetMonthlyCents` to `12345`. `context set --company-id` unexpectedly removed the previously stored `apiBase`.
- Status: PASS with fixed bug.
- Output summary: Company issue prefix is `CLI`; status is `active`.
- Follow-up: Fix the context profile merge bug before continuing so later commands cannot fall back to `localhost:3100`.

### 2026-05-24T11:11:00+02:00 - Fix and verify context profile merge

- Command: edited `cli/src/commands/client/context.ts`, `cli/src/client/context.ts`, and `cli/src/__tests__/context.test.ts`; `pnpm exec vitest run cli/src/__tests__/context.test.ts`; `pnpm --dir cli typecheck`; `pnpm paperclipai context set --api-base http://127.0.0.1:3197 --company-id 12e9db4b-f66c-459b-959e-d645002240fb --use --json`; `pnpm paperclipai context show --json`
- Purpose: Preserve existing context profile fields when setting a subset of fields.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`.
- Expected result: Undefined patch fields do not erase existing profile values; context keeps both `apiBase` and `companyId`.
- Actual result: Targeted Vitest context test passed; CLI typecheck passed; scratch context now contains both `apiBase: http://127.0.0.1:3197` and `companyId: 12e9db4b-f66c-459b-959e-d645002240fb`.
- Status: PASS.
- Output summary: Added regression coverage for undefined context patch fields.
- Follow-up: Continue parity testing.

### 2026-05-24T11:14:05+02:00 - Core domain CRUD and issue comments

- Command: `dashboard get`; `goal list/create/get/update`; `project list/create/get/update`; `agent list/create/get/update/configuration`; `issue list/create/get/update/comment/comments/comment:get/checkout`; `activity list`
- Purpose: Exercise core company-scoped CLI/API parity with JSON outputs and captured IDs.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`; context profile with scratch `apiBase`; process adapter agent payload.
- Expected result: Goal, agent, project, and issue CRUD succeeds; comments can be created and read; checkout succeeds for a todo issue.
- Actual result: Goal `5b2a9135-1044-48d6-a17d-6b91dd9fdc74`, agent `1dd601a1-031a-4225-b005-419427fd059f`, project `d32032ce-d95e-4c4e-a942-dd98498025fb`, issue `f0250734-95f1-4c28-9e10-f1954649fffb`, and comment `231fd48a-9ed2-4e72-a3dc-3b762842f57d` were created/updated/read successfully. Explicit checkout of the first issue failed with 409 because assigning it at creation triggered automatic local process runs and checkout first.
- Status: PASS with expected concurrency conflict.
- Output summary: The assigned `process` adapter agent ran automatically and generated heartbeat runs. The issue later moved to `blocked` via recovery handling because the smoke process printed output without a concrete Paperclip disposition.
- Follow-up: Create a second unassigned issue for an uncontended checkout/release command test.

### 2026-05-24T11:15:41+02:00 - Issue checkout/release

- Command: `issue create --status todo` without assignee; `issue checkout 1f7540d3-a3d3-48d2-b6c5-00d72c064e8f --agent-id 1dd601a1-031a-4225-b005-419427fd059f --expected-statuses todo --json`; `issue release 1f7540d3-a3d3-48d2-b6c5-00d72c064e8f --json`
- Purpose: Exercise atomic checkout and release semantics without automatic assignment races.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`; project `d32032ce-d95e-4c4e-a942-dd98498025fb`; goal `5b2a9135-1044-48d6-a17d-6b91dd9fdc74`.
- Expected result: Checkout moves issue to `in_progress` and assigns the agent; release moves issue to `todo` and clears assignee.
- Actual result: Checkout returned `status: in_progress` with the expected agent ID; release returned `status: todo` with `assigneeAgentId: null`.
- Status: PASS.
- Output summary: Issue `1f7540d3-a3d3-48d2-b6c5-00d72c064e8f`.
- Follow-up: Exercise token flows.

### 2026-05-24T11:16:43+02:00 - Board and agent token lifecycle

- Command: `token board create --company-id ... --name cli-parity-board --never-expires --json`; `token board list --json`; `whoami --api-key <board-token> --json`; `token agent create --company-id ... --agent ... --name cli-parity-agent --json`; `token agent list --company-id ... --agent ... --json`; `context set --profile cli-agent --persona agent ... --api-key-env-var-name PAPERCLIP_API_KEY --json`; `agent me --profile cli-agent --json`; `agent inbox --profile cli-agent --json`; `issue list --profile cli-agent --company-id ... --json`; `company list --profile cli-agent --json`; `token agent revoke ...`; `token board revoke ...`
- Purpose: Exercise board token creation/use/list/revoke; agent token creation/list/use/revoke; verify agent tokens cannot use board-only company list.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`.
- Expected result: Board token works for `whoami`; agent token works for agent persona commands and company-scoped issue list; board-only command fails with clear 403; both tokens are revoked.
- Actual result: Board token `45d843a2-9334-4dda-b53a-cd6f7e62149a` was listed and `whoami` reported `source: board_key`. Agent token `d464c3fe-c760-4c1c-b6cd-f8f0cd6c1797` was listed; `agent me`, `agent inbox`, and issue list succeeded; `company list` failed with `API error 403: Board access required`; both tokens were revoked and later list output showed `revokedAt`.
- Status: PASS.
- Output summary: Plaintext token values were captured only in shell variables and were not written to repo files or this log.
- Follow-up: Exercise prompt/wake/run and safe ancillary surfaces.

### 2026-05-24T11:18:06+02:00 - Prompt, wake, runs, and ancillary safe surfaces

- Command: `board prompt --company-id ... --agent ... --title "CLI parity prompt issue" --no-wake ... --json`; `agent wake ... --reason "cli parity wake smoke" --payload '{"source":"cli-api-parity"}' --json`; `run list/get/events/log`; `dashboard get`; `activity list`; `cost summary`; `cost by-agent`; `finance summary`; `budget overview`; `secrets list/doctor/provider-configs`; `routine list`; `adapter list`; `plugin list`; `org get`; `agent-config list`
- Purpose: Exercise prompt handoff, wake/run inspection, and safe read-only activity/dashboard/cost/secrets/plugin/routine surfaces.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`.
- Expected result: Prompt creates an issue without waking; wake creates/returns a run; run inspection endpoints work; safe list/read commands return JSON.
- Actual result: Prompt created issue `38b89e46-a775-43bc-a39a-c44ccd1f7f30`; wake/run ID `7b18a3ca-9875-4bfc-b910-db31deb2c0fa`; run list returned 10 recent runs; activity returned 50 rows; secrets and routines were empty; adapter list returned 13 adapters; plugin list succeeded.
- Status: PASS.
- Output summary: One transient UI/API background request for a just-created run log returned 404 and then succeeded on retry; direct CLI `run log` for the selected run succeeded.
- Follow-up: Exercise import/export and destructive operations in scratch data.

### 2026-05-24T11:19:35+02:00 - Company export/import/delete and object deletes

- Command: `company export 12e9db4b-f66c-459b-959e-d645002240fb --out tmp/cli-api-parity/exports/company-package --include company,agents,projects,issues,skills --json`; `company import <export-dir> --target new --new-company-name "Imported Company" --yes --json`; `company get <imported-id> --json`; `company delete <imported-id> --yes --confirm <imported-id> --json`; disposable `goal create/delete`, `project create/delete`, and `issue create/delete`; final list checks.
- Purpose: Exercise portability and destructive operations only in the isolated instance.
- Prerequisites/IDs used: original company `12e9db4b-f66c-459b-959e-d645002240fb`.
- Expected result: Export writes a package under scratch; import creates a new company; company delete removes the imported company; object delete commands remove disposable records.
- Actual result: Export wrote `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/exports/company-package`; import created company `0bdc6f69-733d-4b1c-b5c6-2246f9582598` named `Imported Company`; company delete returned `ok: true`; final list checks confirmed the imported company and disposable goal/project/issue were absent.
- Status: PASS.
- Output summary: Goal/project/issue delete commands return the deleted object rather than `{ ok: true }`, so success was verified by final absence from list commands.
- Follow-up: Run final lifecycle and verification checks.

### 2026-05-24T11:20:45+02:00 - Agent pause/resume and final checks

- Command: `agent pause 1dd601a1-031a-4225-b005-419427fd059f --json`; `agent resume 1dd601a1-031a-4225-b005-419427fd059f --json`; `agent get ... --json`; final `curl /api/health`; `token board list`; `token agent list`; `git status --short`; targeted verification commands.
- Purpose: Exercise agent pause/resume and confirm final service/token/code state.
- Prerequisites/IDs used: agent `1dd601a1-031a-4225-b005-419427fd059f`.
- Expected result: Agent pauses and resumes; health remains OK; tokens remain revoked; only expected repo files changed.
- Actual result: Pause returned `paused`, resume returned `idle`, final agent status is `idle`; health returned `status: ok`; board and agent tokens show `revokedAt`; git status shows only the context fix and this log.
- Status: PASS.
- Output summary: Server remains running on `127.0.0.1:3197`.
- Follow-up: Hand off summary and restart instructions.

### 2026-05-24T11:26:43+02:00 - Resume verification before commit

- Command: `git status --short --branch`; `curl -sS http://127.0.0.1:3197/api/health`; `git diff --stat`; `pnpm exec vitest run cli/src/__tests__/context.test.ts`; `pnpm --dir cli typecheck`
- Purpose: Re-establish current worktree/server state before committing the fixed bug and continuing the broader CLI parity loop.
- Prerequisites/IDs used: isolated server on `127.0.0.1:3197`; branch `improvement/cli-api-parity`.
- Expected result: Server remains healthy; worktree contains only the intended context fix and living log; focused test and CLI typecheck pass.
- Actual result: Health returned `status: ok`; worktree showed modifications to `cli/src/__tests__/context.test.ts`, `cli/src/client/context.ts`, `cli/src/commands/client/context.ts`, and new `doc/bugs/`; context Vitest file passed 5 tests; `pnpm --dir cli typecheck` passed.
- Status: PASS.
- Output summary: No additional files changed before commit.
- Follow-up: Stage and commit the context fix plus parity log, then continue with full CLI inventory and remaining command coverage.

## Bugs And Mismatches

### BUG-001 - `context set` erased existing profile fields

- Status: Fixed.
- Severity: High for isolated CLI testing; a non-default `apiBase` can be silently removed and later commands may fall back to `http://localhost:3100` if `PAPERCLIP_API_URL` is absent.
- Reproduction command: `pnpm paperclipai context set --api-base http://127.0.0.1:3197 --use --json`; then `pnpm paperclipai context set --company-id <company-id> --use --json`; then `pnpm paperclipai context show --json`.
- Expected result: Profile preserves existing `apiBase` while adding `companyId`.
- Actual result: Profile only contained `companyId`; `apiBase` was removed.
- Suspected cause: `context set` passed an object containing keys with `undefined` values into `upsertProfile`, and the merge spread those undefined values over existing properties.
- Files changed: `cli/src/commands/client/context.ts`; `cli/src/client/context.ts`; `cli/src/__tests__/context.test.ts`.
- Fix summary: Build context command patches from provided fields only, and make `upsertProfile` ignore undefined values while still allowing empty strings to delete fields.
- Verification command: `pnpm exec vitest run cli/src/__tests__/context.test.ts`; `pnpm --dir cli typecheck`; `pnpm paperclipai context show --json`.
- Remaining risk: Low; behavior is covered at the context store layer and typechecked.

### MISMATCH-001 - Documented `access whoami` command is not registered

- Status: Not fixed in this pass.
- Severity: Low command UX/docs drift.
- Reproduction command: `pnpm paperclipai access whoami --json`.
- Expected result: Access identity command succeeds as documented in the runbook.
- Actual result: CLI exits with `unknown command 'access'`.
- Suspected cause: `registerAccessCommands` registers `whoami` as a top-level command, not under an `access` group.
- Files changed: none.
- Fix summary: Not fixed; the implemented top-level `whoami` command is functional, and this pass is prioritizing functional parity bugs.
- Verification command: `pnpm paperclipai whoami --json`.
- Remaining risk: Docs/runbook users may try a stale command shape.
