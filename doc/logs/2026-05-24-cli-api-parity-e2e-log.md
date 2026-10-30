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

### 2026-05-24T11:28:30+02:00 - Commit context fix

- Command: `git add cli/src/__tests__/context.test.ts cli/src/client/context.ts cli/src/commands/client/context.ts doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`; `git commit -m "Fix CLI context profile patching"`
- Purpose: Persist the verified context isolation fix before continuing broader parity testing.
- Prerequisites/IDs used: focused context test and CLI typecheck from previous entry.
- Expected result: Commit contains only the context patching fix and living parity log.
- Actual result: Commit `1da21a91` created with 4 files changed.
- Status: PASS.
- Output summary: The working tree was clean immediately after this commit.
- Follow-up: Continue full CLI inventory and commit each subsequent fix after focused verification.

### 2026-05-24T11:30:29+02:00 - Approval and issue subresource partial pass

- Command: `approval create/list/get/comment/request-revision/resubmit/approve/reject`; `issue approvals/approval:link/approval:unlink`; `issue read/unread/archive/unarchive`; `issue child:create/get`; `issue document:put/get/lock/unlock/revisions/restore`; `issue work-product:create/list/update/delete`
- Purpose: Exercise approval lifecycle and issue subresource CLI/API parity with JSON outputs.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`; issue `f0250734-95f1-4c28-9e10-f1954649fffb`; project `d32032ce-d95e-4c4e-a942-dd98498025fb`; goal `5b2a9135-1044-48d6-a17d-6b91dd9fdc74`.
- Expected result: Approval lifecycle commands mutate and read approvals; issue markers, child creation, documents, and work products succeed.
- Actual result: Approval lifecycle succeeded. Created/approved approval `c7f19d1c-fcb3-4e4d-87a7-e8a248a9eb09`; created/rejected approval `bbcfb3ae-38f1-43b0-8f9f-0661e291f29c`; linked and unlinked issue approvals successfully. Issue read/unread/archive/unarchive succeeded. Child issue `6e78d443-c9f4-46ba-9137-f1fa2b7a75c5` was created and fetched. Document create/get/lock/unlock/update/revisions/restore succeeded after supplying `--base-revision-id`; work product create/list/update/delete succeeded.
- Status: PASS with docs/operator learning.
- Output summary: A first document update attempt without `--base-revision-id` failed with `API error 409: Document update requires baseRevisionId`; help/source confirmed the flag exists and is required for updates.
- Follow-up: Continue interactions, tree holds, attachments, labels, feedback, and recovery checks.

### 2026-05-24T11:36:54+02:00 - Fix optional interaction accept keys

- Command: `issue interaction:create`; `issue interaction:accept <issue-id> <interaction-id>` without `--selected-client-keys`; edited `cli/src/commands/client/issue.ts` and `cli/src/__tests__/issue-subresources.test.ts`; `pnpm exec vitest run cli/src/__tests__/issue-subresources.test.ts`; `pnpm --dir cli typecheck`
- Purpose: Verify and fix request-confirmation acceptance without optional selected task keys.
- Prerequisites/IDs used: issue `f0250734-95f1-4c28-9e10-f1954649fffb`.
- Expected result: Omitting optional `--selected-client-keys` sends no `selectedClientKeys` field.
- Actual result: Before the fix, the CLI sent `selectedClientKeys: []` and local validation failed with `Array must contain at least 1 element(s)`. After the fix, the focused issue subresource test passed 4 tests and CLI typecheck passed.
- Status: PASS with fixed bug.
- Output summary: The command now preserves `undefined` for omitted optional CSV input while still parsing provided CSV values.
- Follow-up: Commit this fix before continuing, per user instruction.

### 2026-05-24T11:39:47+02:00 - Interaction lifecycle and tree hold retry

- Command: `issue interaction:create/accept/reject/respond/cancel`; `issue tree-state`; `issue tree-preview`; `issue tree-hold:create/list/get/release`
- Purpose: Exercise issue interaction lifecycle and tree control commands.
- Prerequisites/IDs used: issue `f0250734-95f1-4c28-9e10-f1954649fffb`.
- Expected result: Request confirmation accept/reject succeeds; question respond/cancel succeeds; tree hold create/list/get/release succeeds.
- Actual result: Request confirmation accept/reject succeeded. Ask-user-question respond succeeded. `interaction:cancel` only works for `ask_user_questions`; trying it against `request_confirmation` returned `API error 422: Only ask_user_questions interactions can be cancelled`. A corrected ask-user-question cancel succeeded. Tree hold create/list succeeded, but my script initially parsed the create response as `.id`; the API returns `.hold.id`, so the subsequent get used literal `null` and the server returned 500.
- Status: PASS with fixed server hardening and command UX mismatch.
- Output summary: Active tree hold `8f07dd71-092f-4746-9b6d-27bbb086b305` was later fetched and released using the correct `.hold.id`/list-derived ID.
- Follow-up: Harden tree hold routes so malformed hold IDs return 400 instead of database 500; log `interaction:cancel` kind-specific UX mismatch.

### 2026-05-24T11:41:28+02:00 - Fix malformed tree hold ID 500

- Command: edited `server/src/routes/issue-tree-control.ts` and `server/src/__tests__/issue-tree-control-routes.test.ts`; `pnpm exec vitest run server/src/__tests__/issue-tree-control-routes.test.ts`; `pnpm --dir server typecheck`
- Purpose: Prevent malformed tree hold IDs from reaching PostgreSQL UUID comparisons.
- Prerequisites/IDs used: reproduction path `/api/issues/<issue-id>/tree-holds/null`.
- Expected result: Invalid hold IDs return a client error and do not call the tree hold service.
- Actual result: Focused route test passed 9 tests; server typecheck passed.
- Status: PASS with fixed bug.
- Output summary: Both `GET /tree-holds/null` and `POST /tree-holds/null/release` now validate UUID shape and return 400.
- Follow-up: Commit this fix before continuing, per user instruction.

### 2026-05-24T11:43:22+02:00 - Attachments, labels, and feedback retry

- Command: `issue tree-hold:get/release`; `issue attachment:upload/list/download/delete`; `issue label:create/list/delete`; `issue feedback:vote/votes/list/export`; `token agent create/revoke`
- Purpose: Resume the subresource pass after fixing the tree hold script shape and route hardening.
- Prerequisites/IDs used: issue `f0250734-95f1-4c28-9e10-f1954649fffb`; tree hold `8f07dd71-092f-4746-9b6d-27bbb086b305`; company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`.
- Expected result: Active hold is released; attachment upload/download round trip matches bytes; label lifecycle succeeds; feedback vote succeeds against a valid target.
- Actual result: Tree hold get/release succeeded. Attachment upload/list/download/delete succeeded and `cmp` verified downloaded bytes. Label create/list/delete succeeded. Feedback vote against board-authored comment failed with `API error 422: Feedback voting is only available on agent-authored issue comments`. A retry that created an isolated temporary agent token `a67f4f69-7250-43d6-9988-96e7692da605` still failed because `issue comment --api-key <agent-token>` did not produce an agent-authored feedback target. The temporary token was revoked immediately after the failure.
- Status: PARTIAL.
- Output summary: No plaintext token values were written to this log. Token `a67f4f69-7250-43d6-9988-96e7692da605` is revoked.
- Follow-up: Inspect agent-authored comment command/auth semantics before retrying feedback voting.

### 2026-05-24T11:44:45+02:00 - Commit issue subresource fixes

- Command: `git add cli/src/__tests__/issue-subresources.test.ts cli/src/commands/client/issue.ts server/src/__tests__/issue-tree-control-routes.test.ts server/src/routes/issue-tree-control.ts doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`; `git commit -m "Fix CLI issue subresource parity bugs"`
- Purpose: Persist verified fixes immediately after focused verification, per user instruction.
- Prerequisites/IDs used: `pnpm exec vitest run cli/src/__tests__/issue-subresources.test.ts`; `pnpm --dir cli typecheck`; `pnpm exec vitest run server/src/__tests__/issue-tree-control-routes.test.ts`; `pnpm --dir server typecheck`.
- Expected result: Commit contains only the optional interaction accept fix, malformed tree hold ID hardening, tests, and updated parity log.
- Actual result: Commit `73997628` created with 5 files changed.
- Status: PASS.
- Output summary: No plaintext tokens included in the commit.
- Follow-up: Continue parity testing and commit future fixes immediately after focused verification.

### 2026-05-24T11:46:46+02:00 - Feedback and recovery completion

- Command: `token agent create`; `issue comment --api-key <agent-token>`; `issue feedback:vote`; `issue feedback:votes`; `issue feedback:list`; `issue feedback:export`; `token agent revoke`; `issue recovery-actions`; `issue recovery:resolve`
- Purpose: Complete feedback voting/export and recovery resolution after the earlier invalid target and output-shape mistakes.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`; issue `f0250734-95f1-4c28-9e10-f1954649fffb`.
- Expected result: Feedback vote is saved against an agent-authored target; feedback list/export work; temporary token is revoked; active recovery action resolves.
- Actual result: Correctly reading `token agent create` output from `.key.token` produced agent-authored comment `d4e2adbe-d94c-4d87-8205-828f3ddfa033`; feedback vote `24843ebd-456d-4534-89ec-bdbc0bb02170` was saved; feedback list/export completed. Temporary token `40e683ec-758f-4964-bdef-544bee16ee5a` was revoked. Recovery action `1151475f-c97f-456b-9c6a-8e0f936abe05` resolved after using `--source-issue-status todo`; the issue moved to `todo`.
- Status: PASS with command output-shape learning and help mismatch.
- Output summary: A parser mistake against feedback output (`.vote.id` instead of top-level `.id`) stopped one script after the vote succeeded; the token was manually revoked and the remaining list/export commands were run separately.
- Follow-up: Record recovery help mismatch and continue remaining CLI domains.

### 2026-05-24T11:50:09+02:00 - Restart isolated server after committed fixes

- Command: `kill <paperclip pid on 3197>`; `pnpm paperclipai onboard --yes --run --bind loopback`; `curl http://127.0.0.1:3197/api/health`; `issue tree-hold:get <issue-id> null --json`
- Purpose: Restart the disposable server so the committed server-side malformed hold ID fix is active in the running instance.
- Prerequisites/IDs used: scratch env from Isolation Contract; committed fix `73997628`.
- Expected result: Server restarts with the same scratch home/config/DB and returns 400 for malformed hold IDs.
- Actual result: Server restarted on `127.0.0.1:3197`, using the same embedded DB path and pg port `54330`; health returned `status: ok`; malformed hold ID now returns `API error 400: Invalid hold ID`.
- Status: PASS.
- Output summary: No real `~/.paperclip`, `~/.codex`, or `~/.claude` paths were used. The server session is currently running under the isolated environment.
- Follow-up: Continue remaining CLI domains.

### 2026-05-24T11:52:20+02:00 - Advanced agent command pass

- Command: disposable `agent create/list/get/update/delete`; `agent permissions:update`; `agent configuration`; `agent config-revisions`; `agent config-revision:get`; `agent runtime-state`; `agent runtime-state:reset-session`; `agent task-sessions`; `agent skills`; `agent skills:sync`; `agent instructions-path:update`; `agent instructions-bundle`; `agent instructions-bundle:update`; `agent instructions-file:get/put/delete`; `agent local-cli --no-install-skills`; `agent approve/pause/resume/heartbeat:invoke/terminate`; `token agent revoke`
- Purpose: Exercise advanced agent lifecycle, runtime, instructions, skills, and local CLI token flows on a disposable agent.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`; temp agent `f9dfad96-6045-4b97-a548-bdc95fb22ec4`.
- Expected result: Commands succeed without mutating the main parity worker; any token created by `local-cli` is revoked; temp agent is deleted.
- Actual result: Advanced agent commands passed after adapting `instructions-path:update` for process adapter constraints. `agent local-cli --no-install-skills` created key `a9bf0b28-8217-4c60-829c-cb1962203a21`, which was revoked. `agent heartbeat:invoke` passed. Temp agent `f9dfad96-6045-4b97-a548-bdc95fb22ec4` was terminated and deleted. A final key list for the main agent showed no unrevoked keys.
- Status: PASS with command UX mismatch.
- Output summary: First `instructions-path:update` attempt without `adapterConfigKey` failed with `No default instructions path key for adapter type 'process'. Provide adapterConfigKey.` A second relative-path attempt with `adapterConfigKey` failed because process adapters without `cwd` require an absolute path. The successful pass used `adapterConfigKey: instructionsFilePath` and an absolute scratch path.
- Follow-up: Record instructions-path UX mismatch and continue cost/finance/budget/access/admin domains.

### 2026-05-24T11:57:20+02:00 - Cost, finance, and budget command pass

- Command: `cost event:create`; `cost summary`; `cost by-agent`; `cost by-agent-model`; `cost by-provider`; `cost by-biller`; `cost by-project`; `cost window-spend`; `cost quota-windows`; `cost issue`; `finance event:create`; `finance events`; `finance summary`; `finance by-biller`; `finance by-kind`; `budget overview`; `budget policy:upsert`; `budget company:update`; `budget agent:update`
- Purpose: Exercise cost/finance event creation, rollups, issue cost lookup, and budget policy/update flows.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`; issue `f0250734-95f1-4c28-9e10-f1954649fffb`; project `d32032ce-d95e-4c4e-a942-dd98498025fb`; goal `5b2a9135-1044-48d6-a17d-6b91dd9fdc74`.
- Expected result: Cost and finance events are recorded; all rollup commands return JSON; budget updates work and are restored.
- Actual result: Cost event `63d757ae-a7f4-40e1-8ee8-e7d3174be1a4` and finance event `bd38c196-7598-4591-8750-f992d4d9babf` were created. All listed cost/finance read commands succeeded. Budget policy upsert succeeded. Company budget was changed to `23456` then restored to `12345`; agent budget was changed to `4321` then restored to `0`.
- Status: PASS.
- Output summary: `budget incident:resolve` was not run because no budget incident was created by this safe smoke path.
- Follow-up: Continue access/profile/invite/admin/instance/sidebar/inbox/auth domains.

### 2026-05-24T12:02:45+02:00 - Access, profile, invite, admin, instance, sidebar, inbox, and auth challenge pass

- Command: `whoami`; `auth whoami`; `profile session/get/update/company-user`; `invite create/list/show/onboarding/onboarding:text/skills:index/skill/logo/revoke`; `join list/reject`; `member list/user-directory/update/permissions/role-and-grants/archive`; `admin user list/company-access/company-access:update`; `instance scheduler-heartbeats/settings:general/settings:general:update/settings:experimental/settings:experimental:update/database-backup`; `sidebar preferences/preferences:update/project-preferences/project-preferences:update/badges`; `inbox dismissals/dismiss`; `auth challenge create/get/cancel/approve`; `auth logout`
- Purpose: Exercise board access, current profile, disposable invite, member/admin, instance settings, sidebar, inbox, and auth challenge surfaces.
- Prerequisites/IDs used: company `12e9db4b-f66c-459b-959e-d645002240fb`; member `373f91e2-a433-46ee-8362-e61ab5e06593`; user `local-board`; project `d32032ce-d95e-4c4e-a942-dd98498025fb`; approval `c7f19d1c-fcb3-4e4d-87a7-e8a248a9eb09`.
- Expected result: Read commands return JSON; no-op updates preserve scratch user/company access; disposable invites/challenges are revoked/cancelled/approved; unsafe self-removal is rejected.
- Actual result: Identity/profile/session commands passed. Profile update preserved name `Board`. Disposable invite `b3317c94-4e46-4ceb-9a5f-6df179c4f77e` was created, inspected through show/onboarding/onboarding text/skills index/skill, then revoked. `invite logo` was treated as optional because the company has no logo. Join list passed; two disposable pending join requests were rejected during cleanup. Member list/user-directory/update/permissions/role-and-grants passed; self archive returned expected `403: You cannot remove yourself`. Admin user list/company-access/company-access:update passed with the same company ID. Instance settings read/no-op update and database backup passed. Sidebar preferences/project preferences/badges and inbox dismissal passed. Auth challenge cancel `a52af778-39c1-41a4-8f87-46fd7b100d16` and approve `70b51e40-e6d4-4e01-ae5d-16734897375e` passed. `auth logout` completed safely against the isolated auth store.
- Status: PASS with expected negative path and mismatches.
- Output summary: `invite test-resolution` failed because the CLI does not provide the API-required `url` query. `join approve` on a disposable agent join request failed with `409: Join request cannot be approved because this company has no active CEO`; the request was rejected afterward.
- Follow-up: Continue public catalog/LLM docs, adapter/environment/workspace/asset/skill/plugin/setup command domains.

### 2026-05-24T12:04:55+02:00 - Public catalog and LLM docs command check

- Command: `openapi`; `available-skill list`; `available-skill index`; `available-skill get cmux`; `llm agent-configuration`; `llm agent-icons`; `llm agent-configuration:adapter process`
- Purpose: Exercise OpenAPI, public skill catalog, and LLM prompt documentation CLI surfaces.
- Prerequisites/IDs used: isolated server on `127.0.0.1:3197`.
- Expected result: Commands return JSON or text for registered public routes.
- Actual result: `available-skill list` and `available-skill index` passed. `openapi` returned `API error 404: API route not found`. `available-skill get cmux` returned `API error 404: Skill not found` even though `cmux` was returned by `available-skill list`. `llm agent-configuration`, `llm agent-icons`, and `llm agent-configuration:adapter process` returned `API error 404: API route not found`.
- Status: PARTIAL with missing route/route mismatch issues.
- Output summary: These look like CLI/API parity gaps rather than test data problems; no code fix was applied yet.
- Follow-up: Record mismatches and continue remaining command domains.

### 2026-05-24T12:10:10+02:00 - Adapter, environment, project workspace, plugin coverage

- Command: `curl -sf http://127.0.0.1:3197/api/health`; `pnpm paperclipai health --json`; `pnpm paperclipai adapter list/get/config-schema/ui-parser/models/model-profiles/detect-model/test-environment ... --json`; `pnpm paperclipai environment list/capabilities/probe-config/create ... --json`; `pnpm paperclipai project-workspace create/list/update/delete ... --json`; `pnpm paperclipai workspace list --company-id ... --json`; `pnpm paperclipai plugin list/examples/ui-contributions/tools/init ... --json`
- Purpose: Cover remaining adapter, environment/workspace, and plugin command families with safe disposable state.
- Prerequisites/IDs used: Company `12e9db4b-f66c-459b-959e-d645002240fb`; project `d32032ce-d95e-4c4e-a942-dd98498025fb`; isolated API `http://127.0.0.1:3197`.
- Expected result: API health passes; registered CLI commands map to supported routes; disposable project workspace can be created, updated, and deleted; plugin read-only routes and scaffold init work.
- Actual result: API health passed. `paperclipai health` is not registered. Adapter list/get/model commands passed for `process`; `process` config schema and UI parser returned expected unsupported 404s. `adapter test-environment process` returned a structured failure because no process command was supplied. Environment list/capabilities/probe-config passed, but creating a second local environment returned a 500 due to the unique `environments_company_driver_idx` constraint. Project workspace create/list passed; the first update/delete attempt failed because my shell ID extraction broke, then the workspace was recovered from `project-workspace list` and deleted successfully with `project-workspace delete d32032ce-d95e-4c4e-a942-dd98498025fb e271b6bc-368e-4a89-9824-d9e2b2bedb66 --json`. Workspace list passed. Plugin list/examples/ui-contributions/tools passed; `plugin init` scaffolded a disposable plugin under `tmp/cli-api-parity/artifacts/cli-parity-plugin`.
- Status: MIXED.
- Output summary: New mismatches/bugs recorded as `MISMATCH-008` and `BUG-004`. No external plugin install was attempted; no built-in adapter delete/reinstall was attempted.
- Follow-up: Fix the duplicate local environment 500 and restart the isolated server before rerunning the failing CLI command against live code.

### 2026-05-24T12:12:50+02:00 - Asset and company skill coverage

- Command: `pnpm paperclipai asset image:upload --company-id <company-id> --file doc/assets/avatars/zinc.png --namespace cli-parity --alt ... --title ... --json`; `pnpm paperclipai asset content <asset-id> --out tmp/cli-api-parity/artifacts/asset-download.png --json`; `pnpm paperclipai asset logo:upload --company-id <company-id> --file ui/public/favicon-32x32.png --json`; `pnpm paperclipai skill list/create/get/file/file:update/update-status/install-update/delete/scan-projects ... --json`
- Purpose: Cover asset upload/download/logo and company skill CRUD/file commands with disposable resources.
- Prerequisites/IDs used: Company `12e9db4b-f66c-459b-959e-d645002240fb`; image asset `829fbd86-cd5c-4aaa-ad17-276faac7888b`; logo asset `1b3e7979-1359-4361-b3f5-c8a845e11659`; temporary skill `126ad416-864b-4136-8f48-f5adcf324f20`.
- Expected result: Image upload returns an asset ID; content download writes bytes; logo upload succeeds; local skill create/get/file/update/delete works; update check reports unsupported for local skills.
- Actual result: Image upload returned `assetId` and content download wrote `27949` bytes. Logo upload returned `assetId`. Skill list/create/get/file/file:update/update-status/delete/scan-projects passed. `skill install-update` returned `422: Only GitHub-managed skills support update checks`, matching the preceding `update-status supported: false` result.
- Status: PASS with expected negative check.
- Output summary: Temporary local skill was deleted. Uploaded image/logo assets remain in the disposable scratch storage as part of the test instance.
- Follow-up: None for asset/skill surface.

### 2026-05-24T12:13:24+02:00 - Fix duplicate local environment create error

- Command: `pnpm exec vitest run server/src/__tests__/environment-routes.test.ts`; `pnpm --dir server typecheck`
- Purpose: Verify the route-level fix for duplicate local environment creation before committing.
- Prerequisites/IDs used: `BUG-004` reproduction from isolated E2E.
- Expected result: Creating a second local environment returns a controlled conflict instead of leaking a database unique constraint as a 500.
- Actual result: Focused route suite passed with 31 tests; server typecheck passed.
- Status: PASS.
- Output summary: Added a pre-insert `local` environment conflict check and regression coverage.
- Follow-up: Commit immediately, then restart the isolated server and rerun the failing CLI command against the updated code.

### 2026-05-24T12:16:05+02:00 - Rerun duplicate local environment create on restarted server

- Command: `env -u DATABASE_URL -u DATABASE_MIGRATION_URL ... pnpm paperclipai environment create --company-id 12e9db4b-f66c-459b-959e-d645002240fb --payload-json '{"name":"CLI parity local env","description":"Disposable CLI parity environment","driver":"local","config":{"cwd":"/Users/aronprins/Documents/PaperclipAI/paperclip"}}' --json`
- Purpose: Verify `BUG-004` against the restarted isolated source-tree server.
- Prerequisites/IDs used: Same scratch env; server restarted with `pnpm paperclipai onboard --yes --run --bind loopback`; company `12e9db4b-f66c-459b-959e-d645002240fb`.
- Expected result: Controlled conflict instead of internal server error.
- Actual result: CLI returned `API error 409: A local environment already exists for this company.`
- Status: PASS.
- Output summary: Confirms the live CLI/API path now exercises the fixed route behavior.
- Follow-up: Continue remaining parity/fix pass.

### 2026-05-24T12:17:05+02:00 - Environment, plugin, and secrets lifecycle coverage

- Command: `pnpm paperclipai environment create/get/leases/probe/update/delete ... --json`; `pnpm paperclipai plugin install/list/inspect/health/config/jobs/local-folders/ui-contributions/disable/enable/uninstall ... --json`; `pnpm paperclipai secrets list/create/link/declarations/migrate-inline-env ... --json`
- Purpose: Add positive non-local environment coverage, plugin lifecycle coverage, and deeper secrets coverage.
- Prerequisites/IDs used: Company `12e9db4b-f66c-459b-959e-d645002240fb`; bundled plugin path `/Users/aronprins/Documents/PaperclipAI/paperclip/packages/plugins/plugin-workspace-diff`; temporary SSH environment `cc5ae311-13f5-42b8-8044-11065b4e1af0`; temporary plugin install `e8421ed5-c103-4950-afb7-1463a0fbb9c5`; temporary secret `20c74546-7bec-4766-80cd-0b6c57545f7d`.
- Expected result: SSH environment can be created, read, updated, and deleted; SSH probe can fail gracefully when local SSH is unavailable; bundled plugin can install and uninstall in the isolated instance; managed secret can be created and inspected through supported CLI flows.
- Actual result: SSH environment create/get/leases/update/delete passed; probe returned structured `ok: false` with connection refused, as expected on this host. Plugin install/list/inspect/health/config/jobs/local-folders/ui-contributions/disable/enable/uninstall passed; final plugin list returned `[]`. Secret create/list/declarations/migrate-inline-env dry-run passed. `secrets link --provider local_encrypted --external-ref ...` returned `400: local_encrypted does not support external reference secrets`, which is expected provider behavior. The batch exposed missing CLI wrappers for secret update/rotate/usage/access-events/delete.
- Status: MIXED.
- Output summary: New fixed parity gap recorded as `BUG-005`. Plugin was uninstalled; SSH environment was deleted; one managed secret remained briefly for lifecycle verification.
- Follow-up: Add missing secret lifecycle CLI commands, then update/rotate/inspect/delete the temporary secret through the new CLI paths.

### 2026-05-24T12:19:37+02:00 - Fix missing secret lifecycle CLI commands

- Command: `pnpm exec vitest run cli/src/__tests__/secrets.test.ts`; `pnpm --dir cli typecheck`
- Purpose: Verify the CLI wrappers for API-backed secret update, rotate, usage, access events, and delete.
- Prerequisites/IDs used: `BUG-005` parity gap from OpenAPI reference and E2E.
- Expected result: Commands map to `PATCH /api/secrets/:id`, `POST /api/secrets/:id/rotate`, `GET /api/secrets/:id/usage`, `GET /api/secrets/:id/access-events`, and `DELETE /api/secrets/:id`.
- Actual result: Focused CLI secrets test passed with 8 tests; CLI typecheck passed.
- Status: PASS.
- Output summary: Added destructive delete confirmation via `--yes --confirm <secret-id>`.
- Follow-up: Run new commands against temporary scratch secret.

### 2026-05-24T12:20:20+02:00 - Live-verify new secret lifecycle commands

- Command: `pnpm paperclipai secrets update 20c74546-7bec-4766-80cd-0b6c57545f7d --payload-json ... --json`; `pnpm paperclipai secrets rotate 20c74546-7bec-4766-80cd-0b6c57545f7d --value ... --json`; `pnpm paperclipai secrets usage 20c74546-7bec-4766-80cd-0b6c57545f7d --json`; `pnpm paperclipai secrets access-events 20c74546-7bec-4766-80cd-0b6c57545f7d --json`; `pnpm paperclipai secrets delete 20c74546-7bec-4766-80cd-0b6c57545f7d --yes --confirm 20c74546-7bec-4766-80cd-0b6c57545f7d --json`; `pnpm paperclipai secrets list --company-id 12e9db4b-f66c-459b-959e-d645002240fb --json`
- Purpose: Verify fixed commands against the live disposable instance and clean up the temporary managed secret.
- Prerequisites/IDs used: Temporary secret `20c74546-7bec-4766-80cd-0b6c57545f7d`.
- Expected result: Update/rotate/usage/access-events/delete all succeed; final list is empty.
- Actual result: All new commands passed. Usage returned no bindings, access-events returned `[]`, delete returned `{ "ok": true }`, and final list returned `[]`.
- Status: PASS.
- Output summary: No test secrets remain in the company after this verification.
- Follow-up: Commit the CLI fix and updated log.

### 2026-05-24T12:22:36+02:00 - Fix access, health, invite, join, and issue UX mismatches

- Command: `pnpm exec vitest run cli/src/__tests__/access-parity.test.ts cli/src/__tests__/issue-subresources.test.ts`; `pnpm --dir cli typecheck`
- Purpose: Verify CLI fixes for `MISMATCH-001`, `MISMATCH-002`, `MISMATCH-003`, `MISMATCH-005`, `MISMATCH-006`, and `MISMATCH-008`.
- Prerequisites/IDs used: Mismatches from earlier E2E batches.
- Expected result: `paperclipai health` exists; `paperclipai access whoami` works; `invite test-resolution` has a URL option; `join list --status pending` maps to `pending_approval`; issue help text no longer overstates valid cancel/recovery inputs.
- Actual result: Focused tests passed with 6 tests; CLI typecheck passed.
- Status: PASS.
- Output summary: Added a top-level health command, an `access whoami` alias, `invite test-resolution --url`, pending status normalization, and more precise issue command descriptions.
- Follow-up: Live-verify changed commands against scratch instance.

### 2026-05-24T12:23:25+02:00 - Live-verify access/health/invite/join fixes

- Command: `pnpm paperclipai health --json`; `pnpm paperclipai access whoami --json`; `pnpm paperclipai join list --company-id 12e9db4b-f66c-459b-959e-d645002240fb --status pending --request-type agent --json`; `pnpm paperclipai invite create --company-id 12e9db4b-f66c-459b-959e-d645002240fb --payload-json '{}' --json`; `pnpm paperclipai invite test-resolution <token> --url https://example.com/invite/<token> --json`; `pnpm paperclipai invite revoke <invite-id> --json`; `pnpm paperclipai issue recovery:resolve --help`; `pnpm paperclipai issue interaction:cancel --help`
- Purpose: Verify fixed commands on the disposable instance and confirm help text updates.
- Prerequisites/IDs used: Company `12e9db4b-f66c-459b-959e-d645002240fb`; disposable invite `57d7fb29-e29e-4327-9d11-7be325831da6` revoked after test. A first test-resolution attempt against `http://127.0.0.1:3197/...` intentionally hit the server's private-address guard and was replaced with a public HTTPS URL.
- Expected result: Health and alias commands pass; pending alias is accepted; invite test-resolution sends the URL query and returns route data; help text mentions the narrower constraints.
- Actual result: `health`, `access whoami`, and `join list --status pending` passed. Public invite resolution returned `status: reachable`, method `HEAD`, HTTP `404` from `example.com`, proving the command now supplies the URL. Invite was revoked. Help output includes `todo, done, or in_review for restored outcomes; blocked is only valid for blocked outcomes` and `Cancel an ask_user_questions issue thread interaction`.
- Status: PASS.
- Output summary: All fixed UX/parity paths are verified. No invite from this batch remains active.
- Follow-up: Commit this fix batch and continue unresolved docs/catalog parity gap investigation.

### 2026-05-24T12:28:46+02:00 - Fix LLM docs and available skill catalog isolation

- Command: `pnpm exec vitest run server/src/__tests__/llms-routes.test.ts cli/src/__tests__/access-parity.test.ts`; `pnpm --dir server typecheck`; `pnpm --dir cli typecheck`
- Purpose: Fix the docs/catalog subset of `MISMATCH-007` that was straightforward and isolation-sensitive.
- Prerequisites/IDs used: Isolated `CLAUDE_HOME=/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/claude-home`.
- Expected result: CLI LLM commands reach mounted routes, and available skill discovery does not read the real `~/.claude/skills` when `CLAUDE_HOME` is set.
- Actual result: Focused tests passed; server and CLI typechecks passed.
- Status: PASS.
- Output summary: Mounted `llmRoutes` under `/api` in addition to the existing root mount. Updated available-skill discovery to read `CLAUDE_HOME/skills` when configured, include built-in Paperclip repo skills in `available-skill list`, and allow `available-skill get` for safe listed/built-in skill names.
- Follow-up: Restart isolated server and live-verify LLM docs plus available skill list/get behavior.

### 2026-05-24T12:30:05+02:00 - Live-verify LLM docs and available skill catalog isolation

- Command: `pnpm paperclipai llm agent-configuration --json`; `pnpm paperclipai llm agent-icons --json`; `pnpm paperclipai llm agent-configuration:adapter process --json`; `pnpm paperclipai available-skill list --json`; `pnpm paperclipai available-skill get paperclip --json`; `pnpm paperclipai available-skill get cmux --json`; `pnpm paperclipai openapi --json`
- Purpose: Verify docs/catalog fixes on the restarted disposable source-tree server.
- Prerequisites/IDs used: Same isolated env; server restarted after code changes.
- Expected result: LLM docs commands pass; built-in Paperclip skills are listed and fetchable; real-user `~/.claude` skills are not listed; `openapi` still documents the unresolved gap if no route exists.
- Actual result: LLM docs commands passed. `available-skill list` returned Paperclip repo skills such as `diagnose-why-work-stopped`; `available-skill get paperclip` returned markdown. `available-skill get cmux` now returns 404 because `cmux` is no longer listed from the real Claude home. `openapi` still returns `404: API route not found`.
- Status: MIXED.
- Output summary: Fixed the LLM route and available-skill isolation/list-get consistency parts of `MISMATCH-007`; `GET /api/openapi.json` remains unresolved.
- Follow-up: Commit scoped fixes and leave OpenAPI generation as the remaining docs/catalog parity gap.

### 2026-05-24T12:32:12+02:00 - Final cleanup and isolation verification

- Command: environment echo; `pnpm paperclipai health --json`; `pnpm paperclipai token board list --json`; `pnpm paperclipai token board revoke <redacted-board-token-id> --json`; `pnpm paperclipai token agent list --company-id 12e9db4b-f66c-459b-959e-d645002240fb --agent 1dd601a1-031a-4225-b005-419427fd059f --json`; `pnpm paperclipai plugin list --json`; `pnpm paperclipai secrets list --company-id 12e9db4b-f66c-459b-959e-d645002240fb --json`; `pnpm paperclipai environment list --company-id 12e9db4b-f66c-459b-959e-d645002240fb --json`; `pnpm paperclipai project-workspace list d32032ce-d95e-4c4e-a942-dd98498025fb --json`; `pnpm paperclipai openapi --json`
- Purpose: Confirm the disposable instance remains isolated, clean up leftover tokens, and record final known gap.
- Prerequisites/IDs used: Isolated env from the Isolation Contract; board token `<redacted-board-token-id>`; main agent `1dd601a1-031a-4225-b005-419427fd059f`.
- Expected result: All env vars point under `tmp/cli-api-parity`; database env vars remain unset; health passes; no active disposable tokens, plugins, secrets, project workspaces, or non-default environments remain; OpenAPI still fails as the documented unresolved gap.
- Actual result: Env echoed the scratch paths and `DATABASE_URL`/`DATABASE_MIGRATION_URL` as unset. Health passed. Board token list found one active key (`<redacted-board-token-id>`) from the earlier board-token test, which was revoked. Agent token list showed only revoked keys. Plugin list and secrets list returned empty arrays. Environment list contains the default local environment only. Project workspace list returned empty. `openapi` still returned `404: API route not found`.
- Status: PASS with known OpenAPI gap.
- Output summary: No active API tokens created by this run remain. Scratch instance remains running on `http://127.0.0.1:3197`.
- Follow-up: Final report should call out `openapi` as unfixed and explain that implementing it needs a real OpenAPI generator/route rather than a small CLI wrapper correction.

### 2026-05-24T12:45:40+02:00 - Root setup and local maintenance command coverage

- Command: `pnpm paperclipai doctor --config <scratch-config>`; `pnpm paperclipai doctor --config <scratch-config> --repair --yes`; `pnpm paperclipai env --config <scratch-config>`; `pnpm paperclipai db:backup --config <scratch-config> --dir tmp/cli-api-parity/artifacts/root-setup/backups --retention-days 1 --filename-prefix cli-parity --json`; `pnpm paperclipai allowed-hostname cli-parity.test --config <scratch-config>`; `pnpm paperclipai auth bootstrap-ceo --config <scratch-config> --force --base-url http://127.0.0.1:3197`; `pnpm paperclipai auth whoami --json`; `pnpm paperclipai routines disable-all --config <scratch-config> --company-id 12e9db4b-f66c-459b-959e-d645002240fb --json`; `pnpm paperclipai env-lab doctor --instance cli-api-parity --json`; `pnpm paperclipai env-lab status --instance cli-api-parity --json`
- Purpose: Cover root/setup commands and local maintenance utilities against the disposable instance without touching real home state.
- Prerequisites/IDs used: Scratch config `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/config.json`; company `12e9db4b-f66c-459b-959e-d645002240fb`.
- Expected result: Doctor and env introspection use scratch config; DB backup writes under scratch artifacts; allowed-hostname mutates only scratch config; bootstrap CEO is a no-op in `local_trusted`; routines disable-all is harmless with no routines; env-lab reports host capability/status without starting services.
- Actual result: All commands passed. `doctor` and `doctor --repair --yes` completed. `env` printed scratch deployment variables; the generated agent JWT secret is not copied here. `db:backup` created a one-off backup under `tmp/cli-api-parity/artifacts/root-setup/backups`. `allowed-hostname` added `cli-parity.test` to the scratch config and noted a restart is required for it to take effect. `auth bootstrap-ceo` correctly reported that bootstrap CEO invites are only required in authenticated mode. `auth whoami` returned the local implicit board identity. `routines disable-all` reported zero routines. `env-lab doctor` reported SSH env-lab is disabled on macOS unless explicitly opted in, and `env-lab status` reported no running fixture.
- Status: PASS.
- Output summary: This batch covered root setup/maintenance command surfaces that were previously only indirectly covered. Some artifact output files under `tmp/cli-api-parity/artifacts/root-setup` contain command output from the disposable instance.
- Follow-up: Continue remaining untested command families, especially cloud/worktree surfaces and any server-backed command gaps discovered by targeted help/source review.

### 2026-05-24T12:47:54+02:00 - Worktree and cloud command gated coverage

- Command: `PAPERCLIP_WORKTREES_DIR=tmp/cli-api-parity/worktrees-home pnpm paperclipai worktree:list --json`; `pnpm paperclipai worktree env --config <scratch-config> --json`; `pnpm paperclipai worktree:merge-history --from current --to current --company CLI --dry`; `pnpm paperclipai cloud push --company 12e9db4b-f66c-459b-959e-d645002240fb --dry-run --json`
- Purpose: Start worktree/cloud parity coverage with read-only or dry-run commands before attempting any lifecycle command that creates branches, worktrees, or external cloud connections.
- Prerequisites/IDs used: Scratch config `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/config.json`; scratch worktree root `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/worktrees-home`; company `12e9db4b-f66c-459b-959e-d645002240fb`.
- Expected result: Worktree list and env introspection should use scratch config/environment; merge-history should reject identical source/target configs without mutating state; cloud push should fail safely if cloud sync is not enabled/configured.
- Actual result: `worktree:list` passed and showed the current repo branch `improvement/cli-api-parity` with no Paperclip worktree config. `worktree env --config <scratch-config> --json` passed and printed the scratch `PAPERCLIP_CONFIG` plus generated env values; the generated JWT secret is intentionally not copied into this log. `worktree:merge-history --from current --to current --company CLI --dry` failed as expected with `Source and target Paperclip configs are the same. Choose different --from/--to worktrees.` `cloud push --dry-run` failed as expected with `Cloud sync is disabled. Enable the cloud sync experimental setting before running paperclipai cloud push.`
- Status: PASS for safe/gated coverage.
- Output summary: Worktree read-only/dry-run paths behaved safely. Cloud push was not attempted against a real upstream and remained blocked by scratch instance settings.
- Follow-up: Continue with a scratch-only worktree lifecycle test. Cloud requires an experimental setting plus a configured upstream; keep it gated unless a disposable fake upstream can be wired without touching the real install.

### 2026-05-24T12:55:45+02:00 - Scratch worktree lifecycle and fix verification

- Command: `HOME=tmp/cli-api-parity/shell-home PAPERCLIP_WORKTREES_DIR=tmp/cli-api-parity/worktree-instances pnpm paperclipai worktree:make cli-parity-wt --home <scratch-worktree-home> --from-config <scratch-config> --server-port 3198 --db-port 54331 --seed-mode minimal`; `pkill` only for the runaway scratch install attempt; edited `cli/src/commands/worktree.ts` and `cli/src/__tests__/worktree.test.ts`; `pnpm exec vitest run cli/src/__tests__/worktree.test.ts`; `pnpm --dir cli typecheck`; `paperclipai worktree:cleanup cli-parity-wt --home <scratch-worktree-home> --force`; reran `paperclipai worktree:make ...`; `paperclipai worktree:list --json`; `paperclipai worktree env --config <scratch-worktree-config> --json`; `paperclipai worktree:merge-history --from paperclip-cli-parity-wt --to current --company CLI --dry`
- Purpose: Exercise scratch-only worktree creation, initialization, dependency install, minimal DB seed, list/env introspection, dry-run merge history, and cleanup behavior without touching the real home or default instance.
- Prerequisites/IDs used: Scratch `HOME` `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/shell-home`; scratch worktree instance home `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/worktree-instances`; source config `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/config.json`; worktree branch/path `paperclip-cli-parity-wt`.
- Expected result: `worktree:make` creates `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/shell-home/paperclip-cli-parity-wt`, installs dependencies once, writes repo-local `.paperclip/config.json` and `.paperclip/.env`, seeds a minimal isolated DB on ports `3198`/`54331`, and leaves normal `worktree:list`, `worktree env`, and `worktree:merge-history --dry` usable.
- Actual result: The first live attempt exposed BUG-007: dependency installation recursively invoked the user pnpm shim when `HOME` was overridden. After the fix, focused worktree tests and CLI typecheck passed. `worktree:cleanup --force` removed the partial scratch branch/worktree. The rerun completed successfully: dependencies installed, minimal DB seed succeeded, repo config/env were written under the scratch worktree, instance data was written under scratch worktree home, `worktree:list` showed the new worktree with `hasPaperclipConfig: true`, `worktree env --json` printed the scratch worktree env, and `worktree:merge-history --dry` previewed zero inserts with existing company history already present. The generated worktree JWT secret is intentionally not copied here.
- Status: PASS after BUG-007 fix.
- Output summary: One disposable worktree remains for manual continuation at `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/shell-home/paperclip-cli-parity-wt`; its isolated config is `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/shell-home/paperclip-cli-parity-wt/.paperclip/config.json`.
- Follow-up: Commit BUG-007 fix, then continue remaining non-worktree command families. Cloud still requires a configured upstream or fake upstream harness for deeper coverage.

### 2026-05-24T13:06:21+02:00 - Agent prompt, heartbeat, feedback, board claim, OpenClaw, and configure coverage

- Command: `token agent create --company-id 12e9db4b-f66c-459b-959e-d645002240fb --agent 1dd601a1-031a-4225-b005-419427fd059f --name cli-agent-prompt-smoke --json`; `agent-prompt 1dd601a1-031a-4225-b005-419427fd059f <agent-token> "CLI parity agent-prompt smoke without wake" --title "CLI parity agent-prompt smoke" --no-wake --json`; `token agent revoke <key-id> --company-id ... --agent ... --json`; `heartbeat run --agent-id 1dd601a1-031a-4225-b005-419427fd059f --source on_demand --trigger manual --timeout-ms 5000 --json`; `feedback report/export/trace/bundle`; `company feedback:list`; `board-claim show invalid-claim-token --json`; `board-claim claim invalid-claim-token --payload-json '{}' --json`; `openclaw invite-prompt --company-id ... --payload-json '{"goal":"CLI parity OpenClaw invite prompt smoke"}' --json`; `configure --config <scratch-config> --section invalid-section`
- Purpose: Cover remaining safe operator/helper command surfaces that were not part of the earlier company/issue/agent/core batches.
- Prerequisites/IDs used: Company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`; feedback trace `6193ff3a-55d3-4c01-bfbf-78e82ed55793`; temporary agent token stored only under scratch artifacts and revoked after use.
- Expected result: `agent-prompt` creates or updates work through an agent token and no-wake path; heartbeat run returns a bounded on-demand invocation result; feedback report/export/trace/bundle can read the existing feedback trace; invalid board claim calls fail with controlled user-facing errors; OpenClaw invite prompt returns prompt data; invalid configure section should fail non-zero.
- Actual result: First `agent-prompt` attempts failed with `401` because the test script passed the wrong token field (`.key` object / empty shell variable) instead of `.key.token`. Retrying with `.key.token` passed and the token was revoked. `heartbeat run` completed within the timeout. Feedback report/export and trace/bundle passed using the existing trace. `board-claim show` returned expected `404: Board claim challenge not found`; `board-claim claim` returned expected `400: Claim code is required`. OpenClaw invite prompt passed. `configure --section invalid-section` initially printed an error but exited `0`, exposing BUG-008; after the fix, it exits `1`.
- Status: PASS after BUG-008 fix; board-claim paths covered only with invalid/gated tokens because no active board claim challenge exists in `local_trusted`.
- Output summary: Agent token artifacts are under `tmp/cli-api-parity/artifacts/agent-prompt-token*.json`; the token was revoked. Feedback artifacts are under `tmp/cli-api-parity/artifacts/feedback-*`. No real home state was used.
- Follow-up: Continue cloud/connect/run coverage decisions. `connect` and positive board-claim flows are interactive/bootstrap-token dependent and may remain documented as gated if no disposable token source is available.

### 2026-05-24T13:11:19+02:00 - Cloud fake-upstream and remaining run/connect coverage

- Command: disposable Node fake upstream on `http://127.0.0.1:3199`; `instance settings:experimental:update --payload-json '{"enableCloudSync":true}' --json`; `cloud connect http://127.0.0.1:3199 --no-browser --json`; `cloud push --company 12e9db4b-f66c-459b-959e-d645002240fb --remote-url http://127.0.0.1:3199 --dry-run --json`; `run live --company-id ... --limit 5 --min-count 1 --json`; `run issues 9c686a91-c88a-47aa-9326-a889c4281d2b --json`; `run workspace-operations 9c686a91-c88a-47aa-9326-a889c4281d2b --json`; `run workspace-log 00000000-0000-4000-8000-000000000000 --json`; `run cancel 9c686a91-c88a-47aa-9326-a889c4281d2b --json`; `run watchdog-decision 9c686a91-c88a-47aa-9326-a889c4281d2b --decision continue --reason "CLI parity watchdog decision smoke" --json`; `connect --persona board --api-base http://127.0.0.1:3197 --profile cli-connect-smoke --context <scratch-context> --json`
- Purpose: Exercise cloud connect/push without a real external Paperclip Cloud stack, finish run subcommands that were not covered by earlier run list/get/events/log checks, and verify `connect` behavior in the non-interactive test runner.
- Prerequisites/IDs used: Fake cloud server on loopback port `3199`; company `12e9db4b-f66c-459b-959e-d645002240fb`; heartbeat run `9c686a91-c88a-47aa-9326-a889c4281d2b` created by `heartbeat run`; scratch context and config paths.
- Expected result: Cloud sync can be enabled only in the scratch instance; `cloud connect` stores a fake upstream connection under scratch `PAPERCLIP_HOME`; `cloud push --dry-run` exports local company data and posts a preview bundle to the fake upstream; run read/control commands return structured results or controlled 404 for a nonexistent workspace operation; `connect` refuses non-interactive execution with guidance.
- Actual result: Experimental `enableCloudSync` was enabled in the scratch instance. `cloud connect --no-browser` completed against the fake upstream and stored a fake connection. `cloud push --dry-run` returned a fake preview response with summary `{create:0, update:0, adopt:0, skip:1, conflict:0, staleMapping:0}`. `run live`, `run issues`, and `run workspace-operations` passed; workspace operations returned an empty list. `run workspace-log` on a sentinel ID returned expected `404: Workspace operation not found`. `run cancel` on the already completed run returned the run unchanged with status `succeeded`. `run watchdog-decision` created a watchdog decision record. `connect` returned expected non-interactive error: use `--api-base/--api-key` or context/token commands for scripts.
- Status: PASS for fake-cloud dry-run and remaining safe run/connect coverage.
- Output summary: Fake cloud artifacts are under `tmp/cli-api-parity/artifacts/cloud-*`. The fake cloud token is synthetic and stored only in scratch Paperclip home. `connect` remains intentionally interactive; scriptable equivalent coverage is via `context set`, token commands, `whoami`, and agent/board prompt flows already tested.
- Follow-up: Stop the fake upstream server. Keep the real scratch Paperclip server running on `127.0.0.1:3197`.

### 2026-05-24T13:15:09+02:00 - Routine lifecycle coverage

- Command: `routine create --company-id 12e9db4b-f66c-459b-959e-d645002240fb --payload-json '{"title":"CLI parity routine smoke",...}' --json`; `routine list`; `routine get 8254ead3-7edd-43fc-97ca-cb3f477cefc9`; `routine update`; `routine revisions`; `routine runs`; `routine trigger:create <routine-id>` for API and webhook triggers; `routine trigger:update <api-trigger-id>`; `routine trigger:rotate-secret <api-trigger-id>`; `routine trigger:rotate-secret <webhook-trigger-id>`; `routine trigger:fire <webhook-public-id>`; `routine run <routine-id>` without and then with `assigneeAgentId`; `routine trigger:delete` for both triggers; final `routine update <routine-id> --payload-json '{"status":"archived"}'`
- Purpose: Exercise routine CRUD, revision/runs inspection, manual run, trigger create/update/delete, trigger secret rotation, public trigger fire validation, and cleanup by archiving the disposable routine.
- Prerequisites/IDs used: Company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`; routine `8254ead3-7edd-43fc-97ca-cb3f477cefc9`.
- Expected result: Routine can be created, listed, read, updated, inspected, manually run when an assignee is supplied, and archived. API trigger secret rotation should fail because only webhook triggers have secrets. Disabled webhook fire should fail cleanly. Trigger delete should remove disposable triggers.
- Actual result: Routine create/list/get/update/revisions/runs passed. API trigger create/update/delete passed. `trigger:rotate-secret` on the API trigger returned expected `422: Only webhook triggers can rotate secrets`; webhook trigger create and rotate passed. `trigger:fire` on the disabled webhook returned expected `409: Routine trigger is not active`. `routine run` without assignee returned expected `422: Default agent required`; rerun with `assigneeAgentId` passed and produced one routine run. Both triggers were deleted and the routine was archived.
- Status: PASS with expected validation failures.
- Output summary: Routine artifacts are under `tmp/cli-api-parity/artifacts/routine`. No active routine/trigger from this batch remains; the disposable routine is archived.
- Follow-up: Final inventory and status check.

### 2026-05-24T13:19:42+02:00 - Final token-list fix verification

- Command: `token agent list --company-id 12e9db4b-f66c-459b-959e-d645002240fb --agent 1dd601a1-031a-4225-b005-419427fd059f --json`; edited `cli/src/commands/client/token.ts` and `cli/src/__tests__/token.test.ts`; `pnpm exec vitest run cli/src/__tests__/token.test.ts`; `pnpm --dir cli typecheck`; reran the same live `token agent list` command.
- Purpose: Verify agent token list accepts the documented `--agent <agent-id>` shape during final cleanup.
- Prerequisites/IDs used: Company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`.
- Expected result: Agent token list resolves an agent ID directly and returns the key list.
- Actual result: Initial final cleanup attempt returned `404: Agent not found` for the agent ID, while `agent list` showed the agent exists and using `--agent "Parity Worker"` worked. After BUG-009 fix, the same ID-based command passed and showed no active unrevoked agent keys.
- Status: PASS after BUG-009 fix.
- Output summary: Verification artifact written to `tmp/cli-api-parity/artifacts/final-agent-tokens-by-id.json`.
- Follow-up: Commit BUG-009 fix, then run final clean status checks.

### 2026-05-24T13:20:43+02:00 - Final status sweep

- Command: `health --json`; `token board list --json`; `token agent list --company-id 12e9db4b-f66c-459b-959e-d645002240fb --agent 1dd601a1-031a-4225-b005-419427fd059f --json`; `routine list --company-id ... --json`; `plugin list --json`; `openapi --json`; `git status --short --branch`; `lsof -nP -iTCP:3197 -sTCP:LISTEN`; `lsof -nP -iTCP:3199 -sTCP:LISTEN`
- Purpose: Confirm the disposable instance is still healthy, no temporary token/plugin/routine resources remain active, the fake cloud server is stopped, and git state is clean after all fixes.
- Prerequisites/IDs used: Same scratch env and company/agent IDs.
- Expected result: Paperclip remains running on `127.0.0.1:3197`; fake cloud port `3199` is stopped; no active board or agent tokens from the test remain; plugin list is empty; disposable routine is archived; `openapi` remains the one documented unresolved API route gap.
- Actual result: Health returned `status: ok`; process `11566` is listening on `127.0.0.1:3197`; no process is listening on `3199`; final board token list has 2 revoked keys and no active keys; final agent token list has 4 revoked keys and no active keys; plugin list is empty; routine list contains the archived disposable routine and no active routines; `openapi --json` still returns `404: API route not found`; git status was clean before this final log update.
- Status: PASS with known unresolved OpenAPI gap.
- Output summary: Final artifacts are under `tmp/cli-api-parity/artifacts/final-*`.
- Follow-up: Final report should include restart commands and call out `openapi --json` as not fixed because the OpenAPI branch/generator has not been integrated into this repo.

### 2026-05-24T13:25:20+02:00 - OpenAPI route fix verification

- Command: Generated `server/src/routes/openapi.ts` from the route inventory in `doc/plans/2026-05-23-cli-api-parity-openapi-reference.ts`; mounted `openApiRoutes()` under `/api`; added `server/src/__tests__/openapi-routes.test.ts`; ran `pnpm exec vitest run server/src/__tests__/openapi-routes.test.ts`; `pnpm --dir server typecheck`; restarted the isolated runbook server with the scratch environment; `curl -fsS http://127.0.0.1:3197/api/openapi.json | jq '{openapi, pathCount:(.paths|keys|length)}'`; `pnpm --silent paperclipai openapi --json > tmp/cli-api-parity/artifacts/openapi-live-after-fix.json`.
- Purpose: Close the remaining documented `openapi` CLI/API parity gap without introducing a new generator dependency during the live parity run.
- Prerequisites/IDs used: Same scratch env, API URL `http://127.0.0.1:3197`, and local source-tree install.
- Expected result: `/api/openapi.json` and `paperclipai openapi --json` return a valid OpenAPI 3.0 document with the reference route inventory, including representative CLI/API parity paths such as `/api/companies/{companyId}/agents` and `/api/agents/{id}/keys`.
- Actual result: Focused test and `server` typecheck passed. After restart, direct curl returned `{"openapi":"3.0.0","pathCount":247}`. The CLI command returned `openapi: "3.0.0"`, title `Paperclip API`, `247` paths, `/api/openapi.json` summary `Get the generated OpenAPI document`, and `/api/agents/{id}/keys` POST summary `Create an agent API key`.
- Status: PASS after MISMATCH-007 OpenAPI fix.
- Output summary: Live OpenAPI artifact is `tmp/cli-api-parity/artifacts/openapi-live-after-fix.json`. The route exposes operation inventory, tags, summaries, and standard responses from the parity reference; it intentionally does not yet include full request/response schemas.
- Follow-up: Commit the OpenAPI route fix, then rerun the final inventory/status sweep.

### 2026-05-24T13:31:50+02:00 - Instructions path help fix verification

- Command: Edited `cli/src/commands/client/agent.ts`; ran `pnpm exec vitest run cli/src/__tests__/agent-lifecycle.test.ts`; `pnpm --dir cli typecheck`; `pnpm --silent paperclipai agent instructions-path:update --help`.
- Purpose: Close the remaining logged UX mismatch where process-adapter instructions path requirements were only discoverable through failing API calls.
- Prerequisites/IDs used: Local source-tree CLI; no live server mutation required.
- Expected result: Help text explains that process adapters require `adapterConfigKey`, relative paths require `adapterConfig.cwd`, and the JSON payload option includes a concrete example.
- Actual result: Focused agent lifecycle test and CLI typecheck passed. Help output now includes the process-adapter requirement, the relative path `adapterConfig.cwd` requirement, and example payload `{"path":"/tmp/AGENTS.md","adapterConfigKey":"instructionsFilePath"}`.
- Status: PASS after MISMATCH-004 help fix.
- Output summary: This is a help-only CLI change; no scratch instance resources were created.
- Follow-up: Commit the help fix, then continue residual command coverage.

### 2026-05-24T13:33:50+02:00 - Residual company and skill command coverage

- Command: `company stats`; disposable `company create`; `company branding:update`; `company archive`; `company delete`; `company export:preview`; `company export:api`; `company import:preview`; `company import:apply`; cleanup `company delete`; `skill import`; cleanup `skill delete`.
- Purpose: Cover company subcommands and `skill import` not explicitly exercised in earlier batches.
- Prerequisites/IDs used: Company `12e9db4b-f66c-459b-959e-d645002240fb`; disposable archive company `342c1b91-0f48-4a63-a9c5-fc7ffc758483`; raw-import company `dab6758c-dd30-4066-87f0-4df76bd21ea5`; imported skill `be9538e4-9827-426f-b82a-4228c5d3f851`.
- Expected result: Company stats read succeeds; disposable company can be branded, archived, and deleted; raw API portability commands work with API-shaped payloads; skill import from a local repo skill path succeeds and the imported skill can be deleted.
- Actual result: Company stats passed. Disposable company branding/archive/delete passed. First raw export attempt using CLI wrapper-style `{"include":["company"]}` returned expected API validation `include` object error, so the test was adapted to raw API shape `{"include":{"company":true}}`; export preview and export API then passed. Full exported package import via a shell variable was abandoned because markdown code fences in the large JSON payload caused shell transport issues; a minimal inline company package was used instead, and raw import preview/apply/delete passed. `skill import` imported one local skill and cleanup delete passed.
- Status: PASS after adapting raw API payload shape.
- Output summary: Artifacts are under `tmp/cli-api-parity/artifacts/residual-company-skill`. No disposable company or imported skill from this batch remains active.
- Follow-up: Continue advanced plugin surface coverage.

### 2026-05-24T13:37:45+02:00 - Advanced plugin command coverage and tool-dispatch failure

- Command: Installed bundled kitchen-sink plugin; `plugin list/inspect/health/logs/config/jobs/job:runs/job:trigger/webhook/dashboard/bridge:data/data/action/local-folders/upgrade/disable/enable/uninstall`; initial `plugin config:test/config:set/bridge:action/tool:execute/local-folder:*` attempts; corrected `config:test`, `config:set`, and `bridge:action`; final uninstall.
- Purpose: Exercise plugin command surfaces that require a plugin declaring jobs, webhooks, tools, bridge handlers, and UI contributions.
- Prerequisites/IDs used: Bundled plugin path `packages/plugins/examples/plugin-kitchen-sink-example`; company `12e9db4b-f66c-459b-959e-d645002240fb`; project `d32032ce-d95e-4c4e-a942-dd98498025fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`; run `9c686a91-c88a-47aa-9326-a889c4281d2b`.
- Expected result: Plugin installs, exposes its manifest surfaces, handles job/webhook/bridge/data/action calls, rejects unsupported stream/local-folder calls cleanly, and uninstalls. Tool execution should work for the listed kitchen-sink echo tool.
- Actual result: Install/list/inspect/health/logs/config/jobs/job:runs/job:trigger/webhook/dashboard/bridge:data/data/action/upgrade/disable/enable/uninstall passed. Config commands initially failed until payloads were corrected to `{"configJson":{...}}`; bridge action initially failed until payload used `key` instead of `action`. `bridge:stream` returned expected `Plugin stream bridge is not enabled`. Local-folder calls returned expected validation because the kitchen-sink manifest declares no local folders. `plugin tools` listed `paperclip-kitchen-sink-example:echo`, but `plugin tool:execute` returned `502: worker for plugin "paperclip-kitchen-sink-example" is not running` even though bridge calls to the same plugin worker succeeded.
- Status: PASS for safe plugin surfaces; FAIL for `plugin tool:execute`, recorded as BUG-010.
- Output summary: Artifacts are under `tmp/cli-api-parity/artifacts/residual-plugin` and `tmp/cli-api-parity/artifacts/residual-plugin-corrected`. The kitchen-sink plugin was uninstalled after each batch.
- Follow-up: Fix BUG-010 and rerun `plugin tool:execute` live.

### 2026-05-24T13:41:40+02:00 - Plugin tool-dispatch fix verification

- Command: Edited `server/src/services/plugin-tool-dispatcher.ts`, `server/src/services/plugin-loader.ts`, and `server/src/__tests__/plugin-database.test.ts`; ran `pnpm exec vitest run server/src/__tests__/plugin-database.test.ts`; `pnpm --dir server typecheck`; restarted the isolated server; installed kitchen-sink plugin; `plugin tools`; `plugin tool:execute --payload-json '{"tool":"paperclip-kitchen-sink-example:echo",...}'`; cleanup `plugin uninstall --force`.
- Purpose: Verify plugin tool execution uses the plugin database ID for worker lookup while preserving plugin-key namespaced tool names.
- Prerequisites/IDs used: Same scratch server and kitchen-sink plugin; tool `paperclip-kitchen-sink-example:echo`.
- Expected result: The listed echo tool dispatches to the running kitchen-sink worker and returns the echo result.
- Actual result: Focused test and server typecheck passed. After restart, `plugin tools` listed `paperclip-kitchen-sink-example:echo`; `plugin tool:execute` returned `content: "CLI parity tool after fix"` and the expected run context. The plugin was uninstalled and `plugin list` returned `[]`.
- Status: PASS after BUG-010 fix.
- Output summary: Live verification artifacts are under `tmp/cli-api-parity/artifacts/residual-plugin-after-fix`.
- Follow-up: Commit BUG-010 fix, then rerun final inventory/status sweep.

### 2026-05-24T13:47:02+02:00 - Routine webhook secret cleanup fix verification

- Command: Final inventory found active managed secret `156c6074-37b7-4f8e-8619-a62027c2147e`; inspected routine trigger secret handling; edited `server/src/services/routines.ts` and `server/src/__tests__/routines-service.test.ts`; ran `pnpm exec vitest run server/src/__tests__/routines-service.test.ts`; `pnpm --dir server typecheck`; restarted isolated server; deleted the older leaked disposable secret; created temporary routine `60ac06c9-f8c4-4cb1-b9fd-ae52163eb3e6`; created webhook trigger `02838bc3-5b48-4f1e-aad0-ca63a48b926b`; deleted the trigger; verified secret `140c2608-0d8e-4f1e-aad0-ca63a48b926b` was absent from `secrets list`; archived the temporary routine.
- Purpose: Fix and verify cleanup for routine webhook trigger generated secrets.
- Prerequisites/IDs used: Company `12e9db4b-f66c-459b-959e-d645002240fb`; scratch server restarted with the patched code.
- Expected result: Deleting a webhook routine trigger removes the generated paperclip-managed secret and binding. No active secrets remain from parity cleanup.
- Actual result: Focused routine service test and server typecheck passed. Live trigger delete removed the generated secret; final `secrets list` returned `0` rows. The older leaked disposable secret was deleted through the CLI.
- Status: PASS after BUG-011 fix.
- Output summary: Artifacts are under `tmp/cli-api-parity/artifacts/routine-secret-cleanup-fix`.
- Follow-up: Commit BUG-011 fix, then rerun final inventory/status sweep.

### 2026-05-24T13:48:40+02:00 - Final clean inventory sweep

- Command: `health --json`; `openapi --json`; `token board list --json`; `token agent list --company-id 12e9db4b-f66c-459b-959e-d645002240fb --agent 1dd601a1-031a-4225-b005-419427fd059f --json`; `plugin list --json`; `routine list --company-id ... --json`; `secrets list --company-id ... --json`; `environment list --company-id ... --json`; `project-workspace list d32032ce-d95e-4c4e-a942-dd98498025fb --json`; `git status --short --branch`; `lsof -nP -iTCP:3197 -sTCP:LISTEN`; `lsof -nP -iTCP:3199 -sTCP:LISTEN`; environment echo for required isolation variables and unset database variables.
- Purpose: Confirm the disposable instance is healthy, isolated, cleaned up, and ready for manual continuation.
- Prerequisites/IDs used: Same scratch env and company/agent IDs.
- Expected result: Health and OpenAPI pass; all required env vars point under `tmp/cli-api-parity`; `DATABASE_URL` and `DATABASE_MIGRATION_URL` are unset; no active board/agent tokens, plugins, secrets, non-default environments, project workspaces, or active routines remain; only the scratch server listens on `127.0.0.1:3197`; fake cloud port `3199` is stopped; git is clean before this final log update.
- Actual result: Summary was `{health:"ok", openapi:"3.0.0", pathCount:247, activeBoardTokens:0, activeAgentTokens:0, plugins:0, routines:2, activeRoutines:0, secrets:0, environments:1, projectWorkspaces:0}`. `PAPERCLIP_HOME`, `PAPERCLIP_CONFIG`, `PAPERCLIP_CONTEXT`, `PAPERCLIP_AUTH_STORE`, `CODEX_HOME`, and `CLAUDE_HOME` all point under the scratch path. `DATABASE_URL` and `DATABASE_MIGRATION_URL` were `UNSET`. `node` PID `70429` is listening on `127.0.0.1:3197`; no process is listening on `3199`; git status was clean before this log update.
- Status: PASS.
- Output summary: Final clean artifacts are under `tmp/cli-api-parity/artifacts/final-clean-sweep`.
- Follow-up: Leave the scratch instance running for manual testing.

### 2026-05-24T13:50:00+02:00 - Final user-facing handoff summary

- Command: Recorded the final assistant handoff summary in this living log after the clean inventory sweep.
- Purpose: Preserve the exact user-facing closeout in the reproducible CLI/API parity audit trail.
- Prerequisites/IDs used: Scratch server on `http://127.0.0.1:3197`; company `12e9db4b-f66c-459b-959e-d645002240fb`; agent `1dd601a1-031a-4225-b005-419427fd059f`; final clean sweep artifacts under `tmp/cli-api-parity/artifacts/final-clean-sweep`.
- Expected result: The log includes the final paths, command coverage, bug/fix summary, cleanup state, verification commands, and manual continuation instructions that were reported to the user.
- Actual result: Final handoff stated that the full isolated CLI/API parity pass completed and was committed, the scratch Paperclip server was still running on `http://127.0.0.1:3197`, and goal usage was 2,625,855 tokens over about 2h 23m.
- Status: PASS.
- Output summary:

```json
{
  "health": "ok",
  "openapi": "3.0.0",
  "pathCount": 247,
  "activeBoardTokens": 0,
  "activeAgentTokens": 0,
  "plugins": 0,
  "routines": 2,
  "activeRoutines": 0,
  "secrets": 0,
  "environments": 1,
  "projectWorkspaces": 0
}
```

- Final paths:
  - Scratch home: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home`
  - Config: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/config.json`
  - Context: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/context.json`
  - Auth store: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/auth.json`
  - Embedded DB: `/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/db`, active on pg port `54330`
  - API URL: `http://127.0.0.1:3197`
  - Log: `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`
- Commands covered: health; context; auth/access/profile/session/invite/join/member/admin/sidebar/inbox/openclaw; company CRUD/export/import/raw portability/stats/branding/archive; goals; projects; agents; tokens; issues and subresources; approvals; feedback; dashboard/activity/cost/finance/budget; secrets lifecycle; adapters; environments; workspaces/project-workspaces; assets; skills/import; routines/triggers; prompt/wake/run/heartbeat; cloud fake upstream; worktree helpers; setup/doctor/env/db backup/env-lab; OpenAPI; advanced plugin lifecycle/tool/job/webhook/bridge/config surfaces.
- Latest continuation commits:
  - `01579595` Log final CLI parity sweep
  - `ce16de70` Clean up routine webhook secrets
  - `1de4174f` Fix plugin tool worker lookup
  - `ec3cb727` Clarify instructions path CLI help
  - `c811bf07` Add OpenAPI CLI route
- Remaining caveats:
  - Positive interactive `connect` was initially not run because the CLI intentionally rejects non-TTY use; this was resolved in the follow-up with prompt-driven board and agent persona command tests plus the already covered scriptable auth/context/token flows.
  - Positive `board-claim claim` was initially not run because the live scratch server was `local_trusted`; this was resolved in the follow-up with an isolated authenticated-mode service test.
  - OpenAPI initially worked only at route/operation inventory level; this was resolved in the follow-up with a schema-backed generator.
- Tokens and cleanup: All created board and agent tokens were revoked. Plugins were uninstalled. Temporary secrets are gone. Temporary non-default environments and project workspaces are gone. Two routines remain archived in the disposable instance.
- Verification run:
  - `pnpm exec vitest run server/src/__tests__/openapi-routes.test.ts`
  - `pnpm exec vitest run cli/src/__tests__/agent-lifecycle.test.ts`
  - `pnpm exec vitest run server/src/__tests__/plugin-database.test.ts`
  - `pnpm exec vitest run server/src/__tests__/routines-service.test.ts`
  - `pnpm --dir cli typecheck`
  - `pnpm --dir server typecheck`
  - live isolated CLI reruns for each fixed failure
- Manual continuation:

```sh
export PAPERCLIP_HOME=/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home
export PAPERCLIP_INSTANCE_ID=cli-api-parity
export PAPERCLIP_CONFIG=/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/config.json
export PAPERCLIP_CONTEXT=/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/context.json
export PAPERCLIP_AUTH_STORE=/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/auth.json
export PAPERCLIP_API_URL=http://127.0.0.1:3197
export PAPERCLIP_SERVER_PORT=3197
export PORT=3197
export CODEX_HOME=/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/codex-home
export CLAUDE_HOME=/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/claude-home
unset DATABASE_URL DATABASE_MIGRATION_URL
pnpm paperclipai health --json
```

- Follow-up: Commit this log-only update so the final handoff is preserved in git history.

### 2026-05-24T14:07:24+02:00 - Caveat follow-up investigation

- Command: `rg -n "openapi|OpenAPI|board-claim|connect" server cli packages doc/plans/2026-05-23-cli-api-parity-openapi-reference.ts`; `sed -n ... server/src/routes/openapi.ts`; `sed -n ... doc/plans/2026-05-23-cli-api-parity-openapi-reference.ts`; `sed -n ... server/src/board-claim.ts`; `sed -n ... cli/src/commands/client/connect.ts`; `lsof -nP -iTCP:3197 -sTCP:LISTEN`; `git status --short --branch`.
- Purpose: Re-open the three final caveats and distinguish true implementation gaps from harness-gated coverage.
- Prerequisites/IDs used: Existing isolated scratch server on `127.0.0.1:3197`, PID `70429`; same scratch env and repo branch `improvement/cli-api-parity`.
- Expected result: Determine whether OpenAPI requires more implementation, whether a positive board-claim claim can be tested, and whether interactive `connect` has untested behavior beyond the already verified scriptable equivalents.
- Actual result: OpenAPI is a true implementation-depth gap: `server/src/routes/openapi.ts` currently serves a 247-path operation inventory with generic responses, while `doc/plans/2026-05-23-cli-api-parity-openapi-reference.ts` already contains a real `OpenAPIRegistry`/`OpenApiGeneratorV3` implementation with request bodies from shared Zod schemas, auth/security fixups, and status overrides. Positive board-claim requires an authenticated-mode instance whose only instance admin is `local-board`; the current disposable server is `local_trusted`, where no challenge is generated. Interactive `connect` intentionally exits in non-TTY mode before any prompts; its network/token/context side effects are covered by scriptable command paths, but the prompt flow itself has not been PTY-tested.
- Status: PASS with OpenAPI implementation gap confirmed and fixed in the next entry.
- Output summary: OpenAPI needed to be upgraded from inventory stub to generated schema-backed document. Board-claim positive coverage needs a separate isolated authenticated-mode harness or focused route/service test. Interactive `connect` can be checked with a PTY/script harness if a local board-login challenge can be approved non-interactively.
- Follow-up: Implement full OpenAPI route from the reference file first, verify and commit, then evaluate scoped board-claim and connect harness options.

### 2026-05-24T14:12:30+02:00 - Full OpenAPI generator implementation

- Command: `pnpm add @asteasolutions/zod-to-openapi@7.3.4 --filter @paperclipai/server`; replaced `server/src/routes/openapi.ts` inventory stub with the schema-backed generator from `doc/plans/2026-05-23-cli-api-parity-openapi-reference.ts`; added route wrapper exports; tightened `server/src/__tests__/openapi-routes.test.ts`; `pnpm exec vitest run server/src/__tests__/openapi-routes.test.ts`; `pnpm --dir server typecheck`; restarted isolated server with the scratch env; `pnpm paperclipai openapi --json`.
- Purpose: Resolve the final OpenAPI caveat by serving a proper generated OpenAPI document with shared Zod request schemas, auth/security metadata, and response status fixups.
- Prerequisites/IDs used: Isolated scratch server restarted on `127.0.0.1:3197`; `DATABASE_URL` and `DATABASE_MIGRATION_URL` unset; `PAPERCLIP_HOME`, `PAPERCLIP_CONFIG`, `PAPERCLIP_CONTEXT`, `PAPERCLIP_AUTH_STORE`, `CODEX_HOME`, and `CLAUDE_HOME` all under `tmp/cli-api-parity`.
- Expected result: `/api/openapi.json` and `paperclipai openapi --json` return OpenAPI 3.0 with schema-backed request bodies, security schemes, public-operation security overrides, and create-operation `201` responses.
- Actual result: Focused OpenAPI test passed and asserts `BoardSessionAuth`, `BoardApiKeyAuth`, `AgentBearerAuth`, public `/api/health` security `[]`, `POST /api/companies` request body schema, `POST /api/companies` `201` response, and `POST /api/agents/{id}/keys` request body schema. Server typecheck passed. Live CLI returned `{openapi:"3.0.0", pathCount:259, security:["BoardSessionAuth","BoardApiKeyAuth","AgentBearerAuth"], companyCreateRequest:{type:"string",minLength:1}, companyCreateStatus:["201","400","401","403"], agentKeyRequest:{type:"string",minLength:1,default:"default"}}`.
- Status: PASS after OpenAPI caveat fix.
- Output summary: Live schema-backed OpenAPI artifact is `tmp/cli-api-parity/artifacts/caveat-followup/openapi-live-schema-backed.json`.
- Follow-up: Commit the OpenAPI fix, then continue positive board-claim and interactive connect follow-up testing.

### 2026-05-24T14:16:10+02:00 - Positive board-claim claim verification

- Command: Added `server/src/__tests__/board-claim.test.ts`; ran `pnpm exec vitest run server/src/__tests__/board-claim.test.ts`; ran `pnpm --dir server typecheck`.
- Purpose: Resolve the board-claim caveat with positive coverage for the authenticated-mode claim path without mutating the long-running `local_trusted` scratch instance.
- Prerequisites/IDs used: Fresh embedded-postgres test database; seeded one company, a real auth user, and `local-board` as the only `instance_admin`; initialized board-claim challenge with `deploymentMode: "authenticated"`.
- Expected result: A claim warning URL is generated; `inspectBoardClaimChallenge(token, code)` returns `available`; claiming as the signed-in user returns `claimed`; `local-board` loses instance admin; the signed-in user gains instance admin and active owner membership for the existing company; subsequent inspect returns `claimed`.
- Actual result: Initial test attempt exposed cleanup ordering only because the claim path creates `principal_permission_grants`; cleanup was fixed to delete grants before companies. The rerun passed. Server typecheck passed.
- Status: PASS.
- Output summary: Positive board-claim behavior is now covered by a focused authenticated-mode regression test. The live scratch instance remains `local_trusted`, which is correct for the main parity harness.
- Follow-up: Commit the board-claim positive coverage, then evaluate whether interactive `connect` can be PTY-tested or should remain classified as lower-risk because its side effects were exercised through scriptable paths.

### 2026-05-24T14:18:20+02:00 - Interactive connect flow verification

- Command: Added `cli/src/__tests__/connect.test.ts`; ran `pnpm exec vitest run cli/src/__tests__/connect.test.ts`; ran `pnpm --dir cli typecheck`.
- Purpose: Resolve the interactive `connect` caveat by exercising the actual TTY-gated command path with mocked prompts and mocked board-login approval, without opening a real browser or touching real auth state.
- Prerequisites/IDs used: Temp context files under the OS temp directory; mocked `process.stdin.isTTY` and `process.stdout.isTTY` to true; mocked `loginBoardCli` to return a board credential; mocked API responses for health, company list, board API key create, agent list, and agent API key create.
- Expected result: Board persona flow verifies health, completes board auth, lists companies, creates a board token, writes the selected board profile to context, and emits JSON output. Agent persona flow verifies health, completes board auth, lists companies and agents, creates an agent token, writes the selected agent profile to context, and emits JSON output.
- Actual result: Both prompt-driven `connect` tests passed. CLI typecheck passed. The test intentionally does not launch a browser; browser approval itself is already covered by CLI auth challenge route tests and mocked here as the boundary before profile selection/token creation.
- Status: PASS.
- Output summary: Interactive `connect` no longer has an untested command-flow caveat. Remaining real-browser/device approval behavior is covered by lower-level CLI auth challenge route tests and scriptable auth commands, not by manually approving in this terminal.
- Follow-up: Commit the connect flow coverage, then rerun final status and isolation checks.

### 2026-05-24T14:19:04+02:00 - Caveat follow-up final status

- Command: `pnpm paperclipai health --json`; `pnpm paperclipai openapi --json`; `lsof -nP -iTCP:3197 -sTCP:LISTEN`; `git status --short --branch`, all with the scratch `PAPERCLIP_*`, `CODEX_HOME`, and `CLAUDE_HOME` environment and with `DATABASE_URL`/`DATABASE_MIGRATION_URL` unset.
- Purpose: Confirm the three caveats are no longer unresolved after the follow-up fixes and coverage.
- Prerequisites/IDs used: Isolated scratch server restarted from local source on `127.0.0.1:3197`; PID `84908`; same `tmp/cli-api-parity` home/config/context/auth paths.
- Expected result: Scratch server is healthy; OpenAPI is schema-backed; git has no code changes before this final log entry; the only remaining difference is this log update.
- Actual result: Health returned `status:"ok"`, version `0.3.1`, deployment mode `local_trusted`, exposure `private`, auth ready, bootstrap ready. OpenAPI returned `{openapi:"3.0.0", pathCount:259, security:["BoardSessionAuth","BoardApiKeyAuth","AgentBearerAuth"], companyCreateStatus:["201","400","401","403"]}`. `node` PID `84908` is listening on `127.0.0.1:3197`. Git status was clean before this final log update.
- Status: PASS.
- Output summary: OpenAPI caveat fixed in commit `1ab85cb5`; positive board-claim caveat covered in commit `678fd3a8`; interactive connect caveat covered in commit `40480f38`.
- Follow-up: Commit this final log-only status entry.

### 2026-05-24T14:22:00+02:00 - Detached scratch server continuation

- Command: Stopped the foreground scratch server process; started the same runbook command in detached screen session `paperclip-cli-parity`; verified `pnpm paperclipai health --json`; checked `lsof -nP -iTCP:3197 -sTCP:LISTEN`; checked `screen -ls`.
- Purpose: Leave the disposable instance running without tying it to the active tool session.
- Prerequisites/IDs used: Same scratch env and unset database variables; detached screen session `91568.paperclip-cli-parity`.
- Expected result: Server continues running on non-default port `3197` with the same isolated home/config/context/auth paths.
- Actual result: Health returned `status:"ok"` with deployment mode `local_trusted`; `node` PID `91583` is listening on `127.0.0.1:3197`; `screen -ls` shows detached session `91568.paperclip-cli-parity`.
- Status: PASS.
- Output summary: Detached server log is `tmp/cli-api-parity/artifacts/caveat-followup/server-screen.log`.
- Follow-up: Manual continuation can use the same env block and `screen -r paperclip-cli-parity` to inspect the server session.

### 2026-05-24T14:27:44+02:00 - Rename bug log directory to logs

- Command: `git mv doc/bugs doc/logs`; appended this entry in `doc/logs/2026-05-24-cli-api-parity-e2e-log.md`; `git status --short --branch`; `git diff --check`.
- Purpose: Rename the living test/bug log directory from `doc/bugs` to `doc/logs` while preserving the existing audit trail.
- Prerequisites/IDs used: Existing clean branch `improvement/cli-api-parity`; single log file `2026-05-24-cli-api-parity-e2e-log.md`.
- Expected result: Git records the file as moved from `doc/bugs/` to `doc/logs/`; historical command strings inside the log remain unchanged because they record what was run at the time.
- Actual result: Directory rename is staged as a path move with this follow-up log entry.
- Status: PASS.
- Output summary: New log path is `doc/logs/2026-05-24-cli-api-parity-e2e-log.md`.
- Follow-up: Commit the directory rename.

## Bugs And Mismatches

### BUG-011 - Deleting a webhook routine trigger left its managed secret active

- Status: Fixed and live-verified.
- Severity: Medium resource lifecycle leak.
- Reproduction command: `routine trigger:create <routine-id> --payload-json '{"kind":"webhook","signingMode":"bearer"}' --json`; `routine trigger:delete <trigger-id> --json`; `secrets list --company-id <company-id> --json`.
- Expected result: The webhook trigger's generated paperclip-managed secret and binding are removed when the trigger is deleted.
- Actual result: The trigger was deleted, but the generated secret stayed active with `referenceCount: 1` and description `Webhook auth for routine ...`.
- Suspected cause: `deleteTrigger()` deleted only the `routine_triggers` row and appended a revision; it did not remove `existing.secretId`.
- Files changed: `server/src/services/routines.ts`, `server/src/__tests__/routines-service.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: After successful trigger deletion, call `secretsSvc.remove(existing.secretId)` for webhook triggers with managed secrets. Added assertions that deleting a webhook trigger removes both `company_secrets` and `company_secret_bindings` rows.
- Verification command: `pnpm exec vitest run server/src/__tests__/routines-service.test.ts`; `pnpm --dir server typecheck`; live isolated webhook trigger create/delete; live `secrets list --company-id <company-id> --json`.
- Remaining risk: Low. If secret removal failed after trigger deletion, the trigger would already be gone; current provider-backed removal path was verified for the local encrypted provider.

### BUG-010 - Plugin tools were listed but could not execute against a running plugin worker

- Status: Fixed and live-verified.
- Severity: Medium plugin CLI/API parity bug.
- Reproduction command: Install `packages/plugins/examples/plugin-kitchen-sink-example`, then run `pnpm paperclipai plugin tool:execute --payload-json '{"tool":"paperclip-kitchen-sink-example:echo","parameters":{"message":"CLI parity tool"},"runContext":{"companyId":"<company-id>","projectId":"<project-id>","agentId":"<agent-id>","runId":"<run-id>"}}' --json`.
- Expected result: The listed tool dispatches to the running kitchen-sink worker and returns a `ToolResult`.
- Actual result: `plugin tools` listed `paperclip-kitchen-sink-example:echo`, and bridge data/action calls to the same plugin worker succeeded, but `tool:execute` returned `502: Cannot execute tool ... worker for plugin "paperclip-kitchen-sink-example" is not running`.
- Suspected cause: `plugin-loader` registered tools with only the plugin key, so `RegisteredTool.pluginDbId` defaulted to the plugin key. `plugin-worker-manager` tracks running workers by database plugin UUID, so the dispatcher looked up the wrong worker ID.
- Files changed: `server/src/services/plugin-tool-dispatcher.ts`, `server/src/services/plugin-loader.ts`, `server/src/__tests__/plugin-database.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Extended `registerPluginTools` to accept an optional database plugin ID, passed the database ID from the plugin loader, and added regression coverage that plugin activation registers manifest-key namespaced tools with the database ID for worker lookup.
- Verification command: `pnpm exec vitest run server/src/__tests__/plugin-database.test.ts`; `pnpm --dir server typecheck`; restarted isolated server; live kitchen-sink `plugin tools`; live `plugin tool:execute`; cleanup `plugin uninstall --force`.
- Remaining risk: Low; lifecycle DB-backed registration already used the database ID, and this aligns initial loader registration with that path.

### BUG-009 - `token agent list --agent <agent-id>` failed even when the agent exists

- Status: Fixed and live-verified.
- Severity: Low CLI argument parity bug.
- Reproduction command: `pnpm paperclipai token agent list --company-id 12e9db4b-f66c-459b-959e-d645002240fb --agent 1dd601a1-031a-4225-b005-419427fd059f --json`.
- Expected result: `--agent` accepts the documented agent ID, shortname, or unambiguous name.
- Actual result: The command returned `404: Agent not found` for the ID form; the name form worked.
- Suspected cause: The token command always called the reference lookup route `/api/agents/:ref?companyId=...`; the server route did not resolve the UUID ref in that lookup mode.
- Files changed: `cli/src/commands/client/token.ts`, `cli/src/__tests__/token.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Detect UUID-form agent refs in the CLI, fetch `/api/agents/:id` directly, and verify the returned agent belongs to the requested company before listing/creating/revoking keys.
- Verification command: `pnpm exec vitest run cli/src/__tests__/token.test.ts`; `pnpm --dir cli typecheck`; live isolated `token agent list --company-id <company-id> --agent <agent-id> --json`.
- Remaining risk: Low; non-ID references continue to use the existing company-scoped lookup path.

### BUG-007 - `worktree:make` can recurse through pnpm shim when `HOME` is isolated

- Status: Fixed and live-verified.
- Severity: Medium local-dev/worktree reliability bug.
- Reproduction command: `HOME=/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/shell-home pnpm paperclipai worktree:make cli-parity-wt --home /Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/worktree-instances --from-config /Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/config.json --server-port 3198 --db-port 54331 --seed-mode minimal`.
- Expected result: The command creates the scratch git worktree and runs one dependency install inside it.
- Actual result: After creating the git worktree, `installDependenciesBestEffort()` executed bare `pnpm install`. With `HOME` redirected for isolation, the user's pnpm shim repeatedly spawned `pnpm add pnpm@9.15.4` under the scratch home and the command did not reach worktree initialization until the runaway process tree was stopped.
- Suspected cause: The CLI did not reuse the pnpm executable that launched the current Paperclip command, so dependency installation was subject to PATH/shim behavior under an overridden `HOME`.
- Files changed: `cli/src/commands/worktree.ts`, `cli/src/__tests__/worktree.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Added `resolvePnpmInstallInvocation()` and changed worktree dependency installation to reuse `npm_execpath` when the CLI was launched through pnpm, falling back to bare `pnpm` only when no pnpm launcher is available.
- Verification command: `pnpm exec vitest run cli/src/__tests__/worktree.test.ts`; `pnpm --dir cli typecheck`; live isolated `worktree:cleanup --force` for the partial worktree; live isolated `worktree:make ... --seed-mode minimal`; `worktree:list --json`; `worktree env --config <scratch-worktree-config> --json`; `worktree:merge-history --from paperclip-cli-parity-wt --to current --company CLI --dry`.
- Remaining risk: Low. If Paperclip is launched outside pnpm, dependency installation still falls back to PATH lookup as before.

### BUG-008 - `configure --section <invalid>` printed an error but exited 0

- Status: Fixed and live-verified.
- Severity: Low command UX/scripting bug.
- Reproduction command: `pnpm paperclipai configure --config /Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/home/instances/cli-api-parity/config.json --section invalid-section`.
- Expected result: Invalid non-interactive configuration input should produce a failing process exit code so scripts can detect the error.
- Actual result: CLI printed `Unknown section: invalid-section...` but exited with status `0`.
- Suspected cause: `configure()` logged and returned without setting `process.exitCode`.
- Files changed: `cli/src/commands/configure.ts`, `cli/src/__tests__/configure.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Set `process.exitCode = 1` for missing config and unknown section early returns; added regression coverage for both paths.
- Verification command: `pnpm exec vitest run cli/src/__tests__/configure.test.ts`; `pnpm --dir cli typecheck`; live isolated `configure --config <scratch-config> --section invalid-section` returned exit code `1`.
- Remaining risk: Low; interactive configure paths were not changed.

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

- Status: Fixed and live-verified.
- Severity: Low command UX/docs drift.
- Reproduction command: `pnpm paperclipai access whoami --json`.
- Expected result: Access identity command succeeds as documented in the runbook.
- Actual result: CLI exits with `unknown command 'access'`.
- Suspected cause: `registerAccessCommands` registers `whoami` as a top-level command, not under an `access` group.
- Files changed: `cli/src/commands/client/access.ts`, `cli/src/__tests__/access-parity.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Added `paperclipai access whoami` as an alias for the existing top-level `whoami` command.
- Verification command: `pnpm exec vitest run cli/src/__tests__/access-parity.test.ts`; `pnpm --dir cli typecheck`; `pnpm paperclipai access whoami --json`.
- Remaining risk: Low.

### BUG-002 - `issue interaction:accept` rejected omitted optional selected keys

- Status: Fixed.
- Severity: Medium CLI/API parity bug; the command help marks `--selected-client-keys` optional, but omitting it made the CLI fail before calling the API.
- Reproduction command: `pnpm paperclipai issue interaction:accept <issue-id> <request-confirmation-interaction-id> --json`.
- Expected result: The CLI sends `{}` and the API accepts the pending request confirmation.
- Actual result: CLI validation failed with `selectedClientKeys` too small because omitted input was converted to `[]`.
- Suspected cause: `parseCsv(undefined)` returns `[]`, and `interaction:accept` always included that value in the payload.
- Files changed: `cli/src/commands/client/issue.ts`; `cli/src/__tests__/issue-subresources.test.ts`.
- Fix summary: Preserve `undefined` when `--selected-client-keys` is omitted; keep CSV parsing for explicit values.
- Verification command: `pnpm exec vitest run cli/src/__tests__/issue-subresources.test.ts`; `pnpm --dir cli typecheck`.
- Remaining risk: Low; focused CLI command wrapper coverage now includes omitted and explicit selected-key cases.

### BUG-003 - Malformed tree hold ID returned server 500

- Status: Fixed.
- Severity: Medium API robustness bug; malformed user input reached a UUID database comparison and surfaced as a 500.
- Reproduction command: `pnpm paperclipai issue tree-hold:get <issue-id> null --json` or `pnpm paperclipai issue tree-hold:release <issue-id> null --json`.
- Expected result: Invalid hold IDs return a 400 client error without querying the tree hold service.
- Actual result: Server returned `API error 500: Internal server error`; server log showed `invalid input syntax for type uuid: "null"`.
- Suspected cause: Tree hold routes did not validate `holdId` before passing it to service/database code.
- Files changed: `server/src/routes/issue-tree-control.ts`; `server/src/__tests__/issue-tree-control-routes.test.ts`.
- Fix summary: Validate `holdId` with `isUuidLike` in get/release routes and return `{ error: "Invalid hold ID" }` with status 400.
- Verification command: `pnpm exec vitest run server/src/__tests__/issue-tree-control-routes.test.ts`; `pnpm --dir server typecheck`.
- Remaining risk: Low; route-level regression covers both malformed get and release paths.

### MISMATCH-002 - `issue interaction:cancel` command is generic but API only cancels questions

- Status: Fixed help text.
- Severity: Low command UX drift.
- Reproduction command: `pnpm paperclipai issue interaction:cancel <issue-id> <request-confirmation-interaction-id> --reason "..." --json`.
- Expected result: Either the command help states it only applies to `ask_user_questions`, or request confirmations expose a cancel/supersede flow.
- Actual result: API returns `422: Only ask_user_questions interactions can be cancelled`.
- Suspected cause: CLI command name/help is generic while server service method is `cancelQuestions`.
- Files changed: `cli/src/commands/client/issue.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Updated command description to say it cancels an `ask_user_questions` interaction.
- Verification command: `pnpm exec vitest run cli/src/__tests__/issue-subresources.test.ts`; `pnpm --dir cli typecheck`; `pnpm paperclipai issue interaction:cancel --help`.
- Remaining risk: Low; server still enforces the interaction kind.

### MISMATCH-003 - `issue recovery:resolve` help overstates valid restored statuses

- Status: Fixed help text.
- Severity: Low command UX drift.
- Reproduction command: `pnpm paperclipai issue recovery:resolve <issue-id> --action-id <action-id> --outcome restored --source-issue-status blocked --json`.
- Expected result: Help text and validation agree on valid source statuses for `restored` outcomes.
- Actual result: Help says `--source-issue-status` accepts `todo, done, in_review, or blocked`; validator rejects `blocked` for `--outcome restored` with `Restored recovery actions must move the source issue to todo, done, or in_review`.
- Suspected cause: CLI option description lists the broad enum rather than outcome-specific constraints.
- Files changed: `cli/src/commands/client/issue.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Updated option description to state `blocked` is only valid for blocked outcomes.
- Verification command: `pnpm exec vitest run cli/src/__tests__/issue-subresources.test.ts`; `pnpm --dir cli typecheck`; `pnpm paperclipai issue recovery:resolve --help`.
- Remaining risk: Low; validation remains server-side/schema-driven.

### MISMATCH-004 - `agent instructions-path:update` help does not expose process adapter requirements

- Status: Fixed and verified.
- Severity: Low command UX drift.
- Reproduction command: `pnpm paperclipai agent instructions-path:update <process-agent-id> --payload-json '{"path":"docs/cli-parity.md"}' --json`.
- Expected result: Help or validation guidance makes clear that process adapters need an explicit `adapterConfigKey`, and relative paths need `adapterConfig.cwd`.
- Actual result: First attempt failed with `No default instructions path key for adapter type 'process'. Provide adapterConfigKey.` A second attempt with a relative path and `adapterConfigKey` failed with `Relative instructions path requires adapterConfig.cwd to be set to an absolute path`.
- Suspected cause: CLI help only describes the JSON payload type; adapter-specific path requirements are enforced server-side.
- Files changed: `cli/src/commands/client/agent.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Updated the command description and `--payload-json` help to call out process-adapter `adapterConfigKey`, relative path `adapterConfig.cwd`, and an example payload.
- Verification command: `pnpm exec vitest run cli/src/__tests__/agent-lifecycle.test.ts`; `pnpm --dir cli typecheck`; `pnpm paperclipai agent instructions-path:update --help`.
- Remaining risk: Low; this is help text only and server-side validation remains authoritative.

### MISMATCH-005 - `invite test-resolution` omits required URL query

- Status: Fixed and live-verified.
- Severity: Low command/API parity bug.
- Reproduction command: `pnpm paperclipai invite test-resolution <invite-token> --json`.
- Expected result: Command either supplies a documented URL option or the API accepts token-only resolution testing.
- Actual result: API returns `400: url query parameter is required`.
- Suspected cause: CLI wrapper maps `invite test-resolution <token>` directly to `/api/invites/:token/test-resolution` without any `url` query option.
- Files changed: `cli/src/commands/client/access.ts`, `cli/src/__tests__/access-parity.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Added required `--url <url>` option and forwards it as the `url` query parameter.
- Verification command: `pnpm exec vitest run cli/src/__tests__/access-parity.test.ts`; `pnpm --dir cli typecheck`; `pnpm paperclipai invite test-resolution <token> --url https://example.com/invite/<token> --json`.
- Remaining risk: Low; local/private URLs are still rejected by the API guard as intended.

### MISMATCH-006 - `join list --status pending` is rejected; API expects `pending_approval`

- Status: Fixed and live-verified.
- Severity: Low command UX drift.
- Reproduction command: `pnpm paperclipai join list --company-id <company-id> --status pending --request-type agent --json`.
- Expected result: Help or docs clarify valid join statuses, or common alias `pending` is accepted.
- Actual result: API validation rejects `pending`; valid values include `pending_approval`, `approved`, and `rejected`.
- Suspected cause: CLI exposes a free-form status string with no enum guidance.
- Files changed: `cli/src/commands/client/access.ts`, `cli/src/__tests__/access-parity.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: `join list --status pending` now normalizes to `pending_approval`; help lists canonical statuses.
- Verification command: `pnpm exec vitest run cli/src/__tests__/access-parity.test.ts`; `pnpm --dir cli typecheck`; `pnpm paperclipai join list --company-id <company-id> --status pending --request-type agent --json`.
- Remaining risk: Low.

### MISMATCH-007 - Public docs/catalog CLI routes missing or inconsistent

- Status: Fixed and live-verified.
- Severity: Medium CLI/API parity gap.
- Reproduction command: `pnpm paperclipai openapi --json`; `pnpm paperclipai available-skill get cmux --json`; `pnpm paperclipai llm agent-configuration --json`; `pnpm paperclipai llm agent-icons --json`; `pnpm paperclipai llm agent-configuration:adapter process --json`.
- Expected result: Registered CLI commands map to available API routes and return the OpenAPI document, skill markdown, and LLM prompt docs.
- Actual result: Initially, `openapi` and all tested `llm` commands returned `404: API route not found`. `available-skill list` returned `cmux` from the real Claude home, but `available-skill get cmux` returned `404: Skill not found`.
- Suspected cause: LLM routes were mounted at root while the CLI calls `/api/llms`; available-skill discovery used `HOME/.claude/skills` instead of `CLAUDE_HOME`; OpenAPI generation was referenced by CLI/docs but no route was mounted.
- Files changed: `server/src/app.ts`, `server/src/routes/access.ts`, `server/src/routes/openapi.ts`, `server/src/__tests__/openapi-routes.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Mounted LLM docs routes under `/api`; made available-skill discovery honor `CLAUDE_HOME`, include built-in Paperclip repo skills, and fetch safe skill markdown consistently; added `/api/openapi.json`, then upgraded it from the initial path inventory to the schema-backed `OpenAPIRegistry`/`OpenApiGeneratorV3` implementation from the parity reference.
- Verification command: `pnpm exec vitest run server/src/__tests__/llms-routes.test.ts cli/src/__tests__/access-parity.test.ts`; `pnpm --dir server typecheck`; `pnpm --dir cli typecheck`; live `llm` and `available-skill` commands after restart; `pnpm exec vitest run server/src/__tests__/openapi-routes.test.ts`; live `curl http://127.0.0.1:3197/api/openapi.json`; live `pnpm paperclipai openapi --json`; follow-up live schema-backed `paperclipai openapi --json`.
- Remaining risk: Medium-low; the generator now includes shared Zod request schemas and security metadata, but response schemas remain intentionally generic for most endpoints until the API exports reusable response schemas.

### BUG-006 - Available skill catalog ignored isolated `CLAUDE_HOME`

- Status: Fixed and live-verified.
- Severity: Medium isolation bug for local E2E runs.
- Reproduction command: `CLAUDE_HOME=/Users/aronprins/Documents/PaperclipAI/paperclip/tmp/cli-api-parity/claude-home pnpm paperclipai available-skill list --json`.
- Expected result: Skill discovery uses the isolated Claude home or built-in repo skills only.
- Actual result: Before the fix, the list included `cmux` from the real user Claude skills home, and `available-skill get cmux` failed because only a hardcoded Paperclip subset was fetchable.
- Suspected cause: Server code read `HOME/.claude/skills` directly and did not add built-in Paperclip skills unless they were present in Claude's skills directory.
- Files changed: `server/src/routes/access.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Use `CLAUDE_HOME/skills` when `CLAUDE_HOME` is set, include built-in Paperclip skills in catalog output, and resolve safe skill markdown from both Claude and Paperclip skills directories.
- Verification command: live `available-skill list`, `available-skill get paperclip`, and `available-skill get cmux` after restarting the isolated server.
- Remaining risk: Low; this is runtime environment-sensitive and covered by live isolated verification.

### MISMATCH-008 - `paperclipai health` is not registered

- Status: Fixed and live-verified.
- Severity: Low command/API parity gap.
- Reproduction command: `pnpm paperclipai health --json`.
- Expected result: The CLI has a documented health command, or docs consistently direct users to `curl <api-url>/api/health`.
- Actual result: Commander returned `unknown command 'health'`.
- Suspected cause: Health checking exists as an API endpoint and setup/doctor workflow, but not as a CLI client command.
- Files changed: `cli/src/commands/client/access.ts`, `cli/src/__tests__/access-parity.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Added a top-level `health` command that calls `/api/health`.
- Verification command: `pnpm exec vitest run cli/src/__tests__/access-parity.test.ts`; `pnpm --dir cli typecheck`; `pnpm paperclipai health --json`.
- Remaining risk: Low.

### BUG-004 - Creating a second local environment returned 500 instead of conflict

- Status: Fixed and live-verified.
- Severity: Medium API error handling bug.
- Reproduction command: `pnpm paperclipai environment create --company-id 12e9db4b-f66c-459b-959e-d645002240fb --payload-json '{"name":"CLI parity local env","description":"Disposable CLI parity environment","driver":"local","config":{"cwd":"/Users/aronprins/Documents/PaperclipAI/paperclip"}}' --json`.
- Expected result: Controlled `409` or other user-facing validation error because a default local environment already exists for the company.
- Actual result: API returned `500: Internal server error`; server log showed duplicate key violation for `environments_company_driver_idx`.
- Suspected cause: The route attempted the insert without checking the partial unique constraint on `(company_id, driver)` for `driver = 'local'`.
- Files changed: `server/src/routes/environments.ts`, `server/src/__tests__/environment-routes.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Added a route-level pre-insert check that throws `409` when a local environment already exists for the company; added regression coverage.
- Verification command: `pnpm exec vitest run server/src/__tests__/environment-routes.test.ts`; `pnpm --dir server typecheck`; restarted isolated server and reran the reproduction command, which now returns `409`.
- Remaining risk: Low; create flow for non-local environment drivers still needs separate positive coverage.

### BUG-005 - Secret lifecycle API endpoints lacked CLI wrappers

- Status: Fixed and live-verified.
- Severity: Medium CLI/API parity gap.
- Reproduction command: `pnpm paperclipai secrets --help` did not expose commands for `PATCH /api/secrets/:id`, `POST /api/secrets/:id/rotate`, `GET /api/secrets/:id/usage`, `GET /api/secrets/:id/access-events`, or `DELETE /api/secrets/:id`.
- Expected result: CLI can update, rotate, inspect usage/access events, and delete a secret, matching the OpenAPI parity reference.
- Actual result: CLI only supported list/create/link/provider/import/declaration/migration commands; a disposable managed secret could be created but not cleaned up through CLI.
- Suspected cause: Secret provider/import commands were added without completing the single-secret lifecycle wrapper set.
- Files changed: `cli/src/commands/client/secrets.ts`, `cli/src/__tests__/secrets.test.ts`, `doc/bugs/2026-05-24-cli-api-parity-e2e-log.md`.
- Fix summary: Added `secrets update`, `secrets rotate`, `secrets usage`, `secrets access-events`, and guarded `secrets delete --yes --confirm <secret-id>` commands.
- Verification command: `pnpm exec vitest run cli/src/__tests__/secrets.test.ts`; `pnpm --dir cli typecheck`; live scratch commands for update/rotate/usage/access-events/delete.
- Remaining risk: Low; `secrets link` remains provider-dependent and correctly rejects `local_encrypted` external references.
