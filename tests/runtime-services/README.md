# Runtime service kernel acceptance

`linux-process-handoff.acceptance.ts` exercises the production process handoff
against real Linux processes and HTTP listeners. It requires Linux, a non-root
user and a reaper for orphaned fixture processes. The following isolated Docker
invocation works from macOS too. It mounts only the bundled test, requires no
provider credentials and does not share the host's process namespace or network.

From the repository root, with dependencies installed and Docker running:

```sh
mkdir -p test-results/runtime-services-v2/linux-process-handoff/manual
pnpm exec esbuild tests/runtime-services/linux-process-handoff.acceptance.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile=test-results/runtime-services-v2/linux-process-handoff/manual/acceptance.mjs \
  --metafile=test-results/runtime-services-v2/linux-process-handoff/manual/bundle-meta.json
docker run --rm --init --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 512m --user node \
  --tmpfs /tmp:rw,noexec,nosuid,mode=1777 \
  --mount "type=bind,source=$PWD/test-results/runtime-services-v2/linux-process-handoff/manual,target=/proof,readonly" \
  node:24.20.0-bookworm node --test --test-reporter=tap /proof/acceptance.mjs
```

The six scenarios verify uninterrupted HTTP during capture, idempotent stopping,
replacement servers on the original port, termination after the original agent
exits, rejected ownership claims, children created after capture, stale receipts,
and escalation when a command ignores SIGTERM. Test cleanup uses the verified
receipts and direct child handles; container removal bounds any failed cleanup.

This is local Linux process-registration evidence. It does not exercise Daytona's
API, agent tools, the database controller or browser previews, and does not prove
remote process registration. Use the dedicated runtime-service browser suites for
those user-facing flows.

`linux-remote-process-identity.acceptance.ts` checks the native Daytona launch
wrapper and its pre-exec kernel receipt. To run it, use the same bundle/container
commands above with that entrypoint and a separate output directory. Its two
scenarios prove that the launch RPC finishes while the detached runner remains
alive, the receipt matches `/proc` after exec, agent output and marker edits cannot
replace the response, and the identified runner's command can be stopped after
the runner exits. The Docker proof executes the real shell wrapper; it does not
call the Daytona API or establish the complete remote registration tool flow.

`linux-remote-runner-control.acceptance.ts` runs the production native remote
launcher and kernel control program through a local command transport. Bundle it
with the `createRequire` banner shown below and use a separate directory with the
same isolated container settings. Its eleven scenarios cover replaced/deleted
identity markers, exact runner cancellation, persistence rejection with stubborn
same-group children, a failed launch response carrying a valid receipt, lost
monitoring, mismatched kernel identities, and a surviving group after its root
exits. The warm-capability cases keep one native process across three command
capabilities, reject use of the completed launch run, and preserve ownership
when the current capability is unavailable. Restricted-control cases defer
observations during a simulated handoff, then resume monitoring and signal the
exact root; a signal rejected during handoff leaves that root alive. Those cases
exercise the production launcher and real kernel controls with fixture lifecycle
phases and state responses. They do not establish automatic database-to-idle
handoff. Each scenario retains an independent HTTP service and verifies that the
runner operation does not interrupt it. The agent executable is a fixture Node
program; there is no model, Daytona API, database or browser in this proof.

The group cleanup result covers the runner's own process group. It deliberately
does not grant recovery authority for provider children that created other groups
or sessions, or for an uncaptured group surviving an earlier root exit. Durable
per-run remote termination and reattachment need their separate end-to-end proof.

`linux-remote-runner-recovery.acceptance.ts` exercises the production Daytona
runner-control and recovery handlers with real Linux processes and pre-exec
receipts. Bundle it with the same banner and run in its own evidence directory.
Sixteen scenarios cover exact inspection/signalling, stubborn group cleanup and
retry after a lost response, rejected kernel/provider ownership, and
no-execute/no-wake handling of stopped or uncertain compute. They also exercise
existing-runner ingress, retained state reads after root exit, rejection of
ingress after root exit, and six hostile state-file cases: file/parent symlinks,
oversized data, a FIFO, invalid JSON and another run's state. An independent HTTP
listener remains reachable.
The checkpoint cases run actual archive commands through the separately
negotiated recovery handler. They cover running and exited original roots,
stopped compute, changed process birth, and ownership changes during the copy.
The native executor suite also exercises the production archive-copy fallback
through the recovery controls, retaining the previous backup when the provider
withholds an uncertain result and excluding credentials and scratch aliases.
The sandbox handle, compute states and SDK command transport are fixtures; the
kernel program and handler are production code. This does not establish live
Daytona API behavior or automatic controller reattachment. The host/database
binding suite is `server/src/services/native-runtime/remote-runner-recovery.test.ts`.

`server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts`
also runs a real runner and provider fixture through hot and hard controller
reattachment, using either local ownership or the host's remote recovery claim
and controls. It verifies the same runner, provider session and active turn, with
one initial turn and no duplicated steering or launcher invocation. The remote
case simulates the provider boundary around a local process and socket; it does
not exercise Daytona ingress or the production heartbeat/executor integration.
Its database cases check concurrent claims, lock ordering, ownership changes,
deletion fences and preservation when provider evidence is unavailable. Set
`PAPERCLIP_TEST_DATABASE_URL` to a dedicated migrated fixture database to use
external PostgreSQL, or let the suite start its own embedded instance.

`linux-remote-process-handoff.acceptance.ts` exercises the fixed provider-side
capture/stop program using the same native launch receipt and real Linux HTTP
servers. Bundle it into its own evidence directory and use the same container
command. It checks uninterrupted capture, duplicate requests, stopping after the
runner exits, replacement on the original port, stop retries, and rejection of
foreign process, workspace, UID, boot, PID-namespace and scope receipts. This is
kernel evidence; the host/database suite is `remote-process-handoff.test.ts`,
and live Daytona acceptance still requires a configured test connection.

`linux-acpx-process-ownership.acceptance.ts` runs the production process-session
bridge in both polled and streamed modes. Its four scenarios verify pre-exec
ownership, command capture and stop after the root exits, and teardown after
ownership persistence rejects. Bundle this fixture with the additional esbuild
option below because the bridge imports CommonJS dependencies:

```sh
--banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
```

Use a separate output directory with the same isolated container settings. The
fixture invokes its generated host relay through Node because `/tmp` is mounted
with `noexec`. This tests Linux processes and bridge plumbing without a model or
Daytona API access.

`linux-cli-process-ownership.acceptance.ts` tests the direct adapter CLI entrypoint
in both output modes, using the same bundling banner and container settings. Its
eight scenarios cover exact stdin/argv/environment/output delivery, nonzero exit
and duplex disposition, timeout cleanup, rejected ownership persistence, and an
HTTP command remaining alive after the CLI finishes. It exercises the production
receipt and handoff program with a fake agent CLI, without model credentials or
Daytona access.

For the related heartbeat recovery suite in a managed worktree, use a
command-scoped scheduling setting:

```sh
env PAPERCLIP_IN_WORKTREE=false pnpm exec vitest run \
  server/src/__tests__/heartbeat-process-recovery.test.ts --maxWorkers=1
```

This suite creates a temporary database and controls adapter dispatch through its
fixtures. Inheriting the managed worktree's `PAPERCLIP_IN_WORKTREE=true` setting
leaves those fixture runs queued before their assertions can exercise recovery.
The command above changes only the test process environment; the worktree's saved
configuration is preserved.
