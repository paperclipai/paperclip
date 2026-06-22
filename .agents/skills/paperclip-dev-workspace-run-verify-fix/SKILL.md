---
name: paperclip-dev-workspace-run-verify-fix
description: >
  Run, verify, reseed, and repair a Paperclip isolated dev workspace service.
  Use when asked to start or fix a Paperclip project/worktree service and prove
  that it is managed by the Paperclip runtime, has the full bootstrapped cloned
  database, is healthy, accepts normal dev credentials, exposes populated app
  data, and is visible as running from both the control-plane and the served
  workspace app.
---

# Paperclip Dev Workspace Run / Verify / Fix

This skill is for Paperclip-specific development workspaces whose service is
started through project execution workspace runtime services, typically a
worktree service such as `paperclip-dev`.

Success means all of these are true:

- the service was started through the normal managed runtime path, not a
  detached workaround
- the worktree database is a full bootstrapped isolated clone of the primary
  instance database
- `/api/health` returns `status: ok` and `bootstrapStatus: ready`
- the root page returns `200` and does not show the first-admin setup gate
- the board user can log in with their normal dev credentials
- the app shows populated cloned data, not only a manually copied auth user
- the main control plane shows the service as `running` / `healthy` with the
  expected URL
- the served workspace app also knows about that service and shows it as
  `running` / `healthy`

If any item fails, keep fixing. Do not mark the issue done because one probe
passed.

## Hard rules

- Read `doc/DEVELOPING.md` before running Paperclip CLI, dev server, worktree,
  database, build, or test commands.
- Use the Paperclip CLI and API as the source of truth for worktree and
  database operations. Do not use `psql`, raw embedded-Postgres commands, or
  ad hoc row copying for the normal fix path.
- Do not manually copy only auth rows as the final fix. That proves login, but
  it does not prove the isolated workspace has the full bootstrapped database.
- Prefer managed runtime start/stop routes over `pnpm dev` or detached shell
  processes when the task is about a reusable workspace service.
- Avoid destructive git or database actions. Preserve user changes in the
  worktree.
- Run the smallest verification that proves the repair. Add focused tests only
  when code changed.
- Leave an issue comment with root cause, exact fix, verification, and any
  commit link. Set a clear final status.

## Inputs to collect

Use environment variables when available. Do not print API keys or passwords.

- `PAPERCLIP_API_URL`: main control-plane API URL
- `PAPERCLIP_API_KEY`: agent API key
- `PAPERCLIP_RUN_ID`: current run id for runtime-service mutations
- `PAPERCLIP_TASK_ID`: current issue id
- `PAPERCLIP_COMPANY_ID`: company id
- `PAPERCLIP_AGENT_ID`: current agent id
- execution workspace id for the worktree service
- runtime workspace command id, usually `service:paperclip-dev`
- expected service URL, for example `http://paperclip-dev:40631`
- dev credential owner, if the user supplied one; never post the password

If the execution workspace id or service command id is missing, read the issue,
project, or execution-workspace API records first. Do not guess and start an
unmanaged server on a random port.

## Normal run sequence

Use this when the user says to start the workspace, start it again, or fix a
workspace that should be freshly ready.

1. Confirm the latest issue comment and restate the success condition in your
   own words.
2. Inspect current runtime state from the main control plane.
3. Stop any managed instance of the target runtime service.
4. Reseed the worktree with a full clone from the primary instance when there
   is any doubt about database completeness.
5. Start the runtime service through the managed runtime API.
6. Verify health, bootstrap state, login readiness, populated data, and runtime
   visibility from both the main control plane and served workspace app.
7. If a verification item fails, diagnose that exact failure and loop back to
   the narrowest repair step.
8. Comment on the issue and set the final disposition.

## Managed start / stop

Use the runtime-service endpoints on the main control plane. Include
`X-Paperclip-Run-Id` so the mutation is associated with the current heartbeat.

```sh
curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/execution-workspaces/$EXECUTION_WORKSPACE_ID/runtime-services/stop" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data-binary '{"workspaceCommandId":"service:paperclip-dev"}'
```

```sh
curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/execution-workspaces/$EXECUTION_WORKSPACE_ID/runtime-services/start" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  --data-binary '{"workspaceCommandId":"service:paperclip-dev"}'
```

If the API returns an existing service, treat that as a candidate only. Verify
its real `/api/health` before trusting it.

## Full database reseed

Use a full reseed when the app says setup is incomplete, login works but data
is missing, the cloned app does not have the expected companies/issues/agents,
or the user explicitly asks for the normal isolated-workspace database.

```sh
pnpm paperclipai worktree reseed --from-instance default --seed-mode full --yes
```

After reseed, restart through the managed runtime path. A reseed can copy
runtime-service rows whose ids no longer match the local process registry, so
runtime adoption and reconciliation must be verified after the start.

Do not consider the reseed complete until the served app has both auth and
populated product data. A one-off inserted user/account row is a diagnostic
clue, not the final state.

## Core verification probes

Set `SERVICE_URL` to the service URL returned by the runtime API.

```sh
curl -sS "$SERVICE_URL/api/health" | jq
curl -sS -I "$SERVICE_URL/" | head
```

Expected health:

- `status: "ok"`
- `bootstrapStatus: "ready"`
- `bootstrapInviteActive: false`

Failures to reject:

- `bootstrap_pending`: the instance will show the first-admin setup gate
- `database_unreachable`: a web process is listening but its database is dead
- a root `200` with unhealthy `/api/health`: stale process adoption bug or a
  dead embedded database behind a live Node process

Check the port owner when a process is already listening:

```sh
lsof -nP -iTCP:"$SERVICE_PORT" -sTCP:LISTEN || true
```

Use this only to identify and remove a stale matching Paperclip dev-runner
process after managed stop fails. Do not kill unrelated processes.

## Verify main control-plane runtime state

Read the execution workspace from the main API and inspect the runtime service
record.

```sh
curl -sS \
  "$PAPERCLIP_API_URL/api/execution-workspaces/$EXECUTION_WORKSPACE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq
```

The target service should show:

- matching workspace command id, usually `service:paperclip-dev`
- `status: "running"`
- healthy health fields, if present
- the same URL you are probing
- a local provider reference that maps to the running port owner

If the main app says running but `/api/health` is bad, stop and replace the
stale process through the managed runtime.

## Verify served workspace runtime state

The cloned Paperclip app must also know about the service. Query the same
execution workspace through the served app when agent auth is available there:

```sh
curl -sS \
  "$SERVICE_URL/api/execution-workspaces/$EXECUTION_WORKSPACE_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq
```

The served app should agree that the service is `running` / `healthy` at the
same URL. If the main control plane and served app disagree after a reseed,
the cloned database may contain copied runtime-service ids that do not match
the local process registry. Use the normal start/adoption path again and verify
both sides. If code changed in this area, add a focused regression test.

## Verify auth and populated data

Auth and data checks should use product APIs and browser/QA review, not raw DB
queries.

Minimum API checks:

```sh
curl -sS "$SERVICE_URL/api/health" | jq '.status, .bootstrapStatus'
curl -sS "$SERVICE_URL/api/companies" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq
curl -sS "$SERVICE_URL/api/agents/me" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" | jq
```

Then verify at least one expected cloned product record through the API, such
as a known project, issue key, company, or execution workspace that should
exist in the primary instance. Pick a record relevant to the current issue
rather than a random table count.

Browser or QA check:

- open the service URL
- confirm the first-admin setup gate is gone
- sign in with normal dev credentials
- confirm the board loads populated companies/projects/issues/runs
- confirm the workspace service appears with the running URL

If this environment cannot launch a browser, ask QA to do the visual/login
check and still complete all API checks you can run. Report that browser
verification was delegated and why.

## Common failures and fixes

### Setup gate appears

Symptom: the page says no admin has claimed the instance.

Fix: run a full worktree reseed from the primary instance, then restart the
managed service. Claiming a first admin can clear the gate, but if the user
asked for the normal isolated workspace database, full reseed is the correct
fix.

Verify: `/api/health` has `bootstrapStatus: ready`, login works, and populated
data exists.

### Login fails

Symptom: bootstrap is ready, but the user's normal dev credentials do not work.

Likely cause: the isolated DB has roles or bootstrap state but lacks the
primary instance auth users/accounts.

Fix: full reseed. Do not manually copy only Better Auth user/account rows as
the final fix.

Verify: user login through browser/QA and `/api/agents/me` with the agent key.

### Login works but data is missing

Symptom: user can sign in, but companies/issues/projects/runs are empty or
clearly incomplete.

Likely cause: a partial auth repair was done instead of a full cloned database.

Fix: full reseed, managed restart, then verify representative cloned records.

### Port listens but health says database unreachable

Symptom: `curl -I /` returns a response, but `/api/health` reports
`database_unreachable`.

Likely cause: stale Node/web process remained alive after embedded Postgres
died.

Fix: managed stop first. If the process survives, identify the matching
Paperclip dev-runner process group for the target port and terminate only that
group. Then managed start.

Verify: `/api/health` is ok after a stability wait and the runtime record is
healthy.

### Main control plane loses track of a running service

Symptom: the service URL works, but the main app says the service was not
created or is stopped.

Likely cause: detached workaround process, stale provider ref, or service
adoption trusted the root URL instead of health.

Fix: shut down the unmanaged process and restart through the managed runtime.
If code repair is needed, ensure adoption checks `/api/health`, replaces
unhealthy adopted processes, and records the current provider ref.

Verify: main runtime row and `/api/health` agree.

### Served app loses track after full reseed

Symptom: the main app sees `paperclip-dev` running, but the cloned app copied a
runtime-service row whose id does not match the local registry.

Likely cause: normal DB clone copied persisted runtime rows from the primary
instance into an isolated environment with different local process metadata.

Fix: use managed start/adoption again. If code repair is needed, adoption
should reconcile by service identity and port, not only by copied row id.

Verify: main app and served app both show the same service as
`running` / `healthy`.

### Runtime start returns permission or run-FK errors in the cloned app

Symptom: starting from the served app returns `403` or a mutation partially
applies before activity logging fails.

Likely causes: the cloned issue/run/agent state does not match the current
heartbeat, or the run id is absent in the cloned database after reseed.

Fix: prefer the main control-plane managed runtime path and full reseed. If
the cloned app state itself must be repaired, use normal Paperclip issue/run
transitions first. Do not hide the condition with raw DB edits; report the
exact guard or missing row if it blocks the normal path.

## When code changes are required

Make a code change only when the normal operational repair exposes a product
bug. Examples from this failure class:

- local port owner detection used the wrong `lsof` arguments
- service adoption trusted root `200` instead of `/api/health`
- unhealthy adopted services were not terminated/replaced
- reseeded runtime-service ids were not reconciled with local process registry

Add focused tests in the affected service test file. For workspace runtime
repairs, the narrow verification is usually:

```sh
pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts
git diff --check
```

Commit logical code changes and link the commit in the issue comment. If no
tracked code changed, say so explicitly.

## Final issue comment template

Use concrete evidence, not a vague "it works".

```md
Fixed and verified the workspace service.

Root cause:
- <why it broke>

Fix:
- <normal reseed/start/repair steps>
- <code commit if any>

Verified:
- main control plane shows <service> running/healthy at <url>
- served workspace app shows the same service running/healthy
- <url>/api/health is ok with bootstrapStatus ready
- root page returns 200 and no setup gate
- dev login verified by <agent browser / QA / user> without posting credentials
- cloned data verified via <specific API records>
- targeted tests: <commands>

Remaining:
- <none, or named owner/action if blocked>
```

Mark the issue `done` only when every success-condition item is satisfied. If
not, mark `blocked` with a named unblock owner and the exact action needed.
