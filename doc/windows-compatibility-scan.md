# Windows handoff fix and focused source scan

Date: 2026-11-02. Target: existing Windows compatibility PR #18144, based on upstream `master`.

## Handoff fix

Local legacy execution could accept a Case handoff, stop the outgoing agent, and
remain in `awaiting_release`: process-tree settlement always returned false on
Windows. ACPX also records no POSIX process group, so checking only a parent PID
or replacing the Windows check with an unconditional success is insufficient.

Owned Windows process adapters and local ACPX providers now launch through a
Windows Job Object. The provider starts suspended and joins the job before its
first instruction; descendants cannot break away. Normal completion and Stop
terminate the job and await its kernel completion event. Only a zero-active-process
observation creates a host receipt, bound to the captured supervisor generation.
Missing evidence still holds delivery. The ordinary Case release marker and
workspace cleanup remain separate requirements. No database schema changes.

The small supervisor is compiled lazily with Windows' .NET Framework compiler,
once per server process, in a unique temporary directory. Compilation failure
fails startup rather than falling back to an uncontained provider. Linux and
remote execution retain their existing paths. Recent settled generations are
bounded in memory; completed Case release proof is persisted by heartbeat.
An old pre-fix run, or a crash before settlement evidence is persisted, cannot
be made safe retrospectively from its PID alone.

ACPX's optional host spawn callback is added to the existing 0.12.0 package patch.
Provider commands, saved session identity, environment, and stdio remain under
ACPX's normal contract. The patch hash is the only dependency-lock change.
Both process routes use the existing PATH/PATHEXT lookup and batch-command
normalization, extracted into `process-command.ts`; configured bare executables
and `.CMD` provider shims are covered by real ACPX protocol tests.

## Verification record

Regression tests first reproduced failed Windows release, premature completion
before host identity persistence, and invalid batch-command quoting. An independent
review then found lost PATH/batch resolution in the ACPX route; real bare-command
and `.CMD` protocol tests failed before the shared normalization repair and passed
after it. Missing kernel receipts and mismatched process generations remain held.

The real HTTP/database handoff suite exercised cross-agent and same-agent transfer
on one task, and the missing-scratch path, on a disposable Postgres database.
Earlier runs exposed the missing metadata barrier, a ten-second cold-start fixture
deadline, and a sixty-second database setup hook deadline. The metadata barrier is
fixed. Windows fixture deadlines now use the existing embedded-Postgres cost-class
budget and bounded startup waits; the final complete integration run passed using
a fresh cluster (`PAPERCLIP_TEST_POSTGRES_TEMPLATE=0`). No personal database was used.

Adapter utility typecheck/build and the server source typecheck were checked locally.
The isolated checkout reused installed dependencies; the server check resolved the
Runner's current source rather than stale compiled declarations. Repository-wide
builds, remote CI, authenticated Claude/Codex turns and live-server activation are
separate checks and are not claimed by these tests.

## Additional confirmed findings (not changed in this patch)

| Location | Finding | Effect |
| --- | --- | --- |
| `server/src/services/native-runtime/setup-readiness.ts`, Codex source ownership check | Compares `stat.uid` directly with `process.getuid?.()`. On Windows these are `0` and `undefined`. | An existing Codex source credential is rejected before native readiness probing. |
| `packages/adapters/codex-local/src/server/codex-home.ts`, `additionalFiles` staging | Requires Unix private mode bits even on Windows. A synthetic file created with `mode: 0o600` reports `0666` on Windows. | Staging an additional managed observability profile is rejected. |
| `server/package.json`, `build` script | Still invokes `mkdir -p` and Unix `cp`; `where.exe cp` found no executable on the tested Windows host. | The full server packaging/build command still requires Unix shell tools; the targeted TypeScript build does not establish native Windows packaging support. |

These observations used synthetic temporary files, not personal credentials.
Repairs should use the existing platform-aware credential/file validation
contract; simply removing ownership checks would not preserve its guarantees.

The scan covered process signalling, shell invocation, UID/GID checks, permission
bits and path assumptions in server, adapter utilities, adapters and scripts.
Linux sandbox-only `sh`/Bubblewrap calls and Linux packaging smoke scripts were
kept distinct from Windows runtime defects. This is a focused scan, not a full
Windows qualification of every provider or the native Runner.
