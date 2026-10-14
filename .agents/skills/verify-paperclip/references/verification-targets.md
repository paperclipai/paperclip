# Checkout, data, and hosted targets

## Checkout and data modes

Read [DEVELOPING.md](../../../../doc/DEVELOPING.md) and
[DATABASE.md](../../../../doc/DATABASE.md) for the current startup contract.

- **Existing dev server:** use `pnpm dev` (watch) or `pnpm dev:once` from the
  intended checkout. Inspect its instance routing and data configuration first;
  do not assume the default port belongs to this checkout. Record the actual
  served commit and dirty state. Reuse a matching running server when appropriate.
- **Fresh empty instance:** use the skill's `launch.py` helper with a new data
  directory. Complete the UI or CLI onboarding journey under test. This is the
  credential-free route; a live model run needs separate provider setup.
- **Seeded test drive:** run the documented CLI `test-drive --no-browser` with
  an authorized environment-backed provider credential. It creates a temporary
  embedded instance, completes setup, and seeds Test Company and a CEO. It does
  not execute the first task. Verify that separately when required.
- **Reused test drive:** pass `--data-dir <existing-test-directory>`. If it already
  contains a company, bootstrap flags do not replace companies, agents, or
  secrets. Record existing state; do not label the result fresh onboarding.
  Test drive rejects external PostgreSQL configuration and database URL overrides.
- **Managed or cloned worktree:** use
  [dev-workspace run/verify/fix](../../paperclip-dev-workspace-run-verify-fix/SKILL.md).
  Verify seed completion, instance routing, and login handoff before driving it.
  Cloned data is existing-user evidence even when the checkout is new.

`--data-dir` alone is not proof of a fresh database: check effective config and
whether `DATABASE_URL` routes to an external database. Do not print its value.
For ordinary dev, inspect both environment overrides and the active database
config: with `DATABASE_URL` unset, `database.mode: postgres` and a saved
`connectionString` still select external PostgreSQL. Embedded PostgreSQL is the
default only when neither an environment override nor the active config selects
an external database; its instance directory may already hold data. Do not reset
shared data to make a test pass. Choose separate disposable data for first-run
checks and verify the effective backend before calling it isolated.

Record runtime PID, URL, port owner, checkout, and data location for a process you
start. Check `/api/health`, expected served revision, bootstrap/auth readiness,
and the actual page. Capture starting state and verify persistence after reload.
Use that launcher's documented stop procedure for an owned process; leave a
server you borrowed running.

## Platform scope

Ordinary development covers the current host unless the request or failure calls
for more. For a platform issue or release matrix, list required combinations:
macOS, Linux, native Windows, architecture, runtime, and install path. Mark each
combination passed, failed, blocked, or not run separately.

The local helper needs POSIX tools such as `lsof`; do not assume it qualifies
native Windows. Use the supported CLI and native shell for that platform, with
isolated instance/config/cache paths and platform-appropriate process cleanup.
A container proves its guest OS and selected architecture, not the host's native
installer, service manager, file permissions, or path behavior. Keep browser and
server platforms distinct when testing a remote Linux box from a Mac.

## Staging and production

Use the supplied tenant URL and intended identity. Determine whether the target
is the Paperclip tenant application or the Cloud control plane. Confirm the
environment from the operator's deployment record and authenticated routing;
a page title or local Git checkout is not evidence of the serving revision.

If a build/deploy is needed, follow the private skill handoff in `SKILL.md` first.
Record the exact serving SHA and release/image identity after deployment, not
just the requested branch, CI result, or fleet default. Recheck after a long run:
a staging auto-roll or another deployment can change the serving version. Mark
unknown or changing provenance as inconclusive for a claim about a specific SHA.

For staging, use a designated test workspace and its real hosted sign-in/entry
flow. Record fresh versus existing workspace state, experimental flags, relevant
provider connections, and whether dependencies are live. Check tenant readiness
and then the feature journey, including persistence or continuation. A control
plane `/healthz` response or tenant HTML 200 is not feature acceptance.

For production, keep verification within the requested stack, identity, and
journey. Prefer observation of existing state unless writes are authorized; use
an agreed test workspace for mutating checks. Do not run the empty-instance
onboarding smoke, reset data, change flags, or trigger paid agent work merely to
make a production check pass. If a necessary write is outside the request,
report that missing authorization and complete the read-only checks.

Never use local ownership helpers against a remote server. Close only browser
sessions you created and clean up only test records whose removal is authorized.
Keep shared services running. Report production Cloud verification separately
from stable npm verification; the shipped artifacts and configuration differ.
