# Native recovery compatibility

Native recovery preserves saved work. Retry and automatic replacement must prove
that the previous execution stopped before they admit one successor. Unknown
ownership, active processes, pending cleanup, Stop, budgets and current task
authority keep their existing gates.

## Failed startup and older workspace records

Codex permission profiles deduplicate host Git and credential-broker paths before
startup. Failed-session recovery checks the durable command and process journals
and refuses incomplete evidence. The generic failed-session process-tree proof
remains Unix-only. Windows process enumeration rejects incomplete command lines.
Retry checks its latest failed source even when an older run owns the visible hold.

Older releases stored no-session evidence in coordinator failure details rather
than an execution-recovery receipt. Workspace admission requires all three saved
flags to deny a provider session, provider events and a checkpoint. It also checks
that no result, Runner checkpoint or remote lease exists. The latest server-authored
stop must be a machine `unidentified_runner_absent` receipt. Ordinary stops and
operator attestations do not prove unused startup. Saved checkpoints, copyback,
restore failures and unfinished cleanup retain the hold. Historical records remain
intact; admission does not replay them or mark them successful.

## Cancelled results and process settlement

Cancellation retains process identity until settlement records a verified stop and
clears the identity in one transaction. For older cancellation records whose mutable
identity was already cleared, settlement can recover only the latest server-authored
local launch. It verifies the original agent, host, recorded process space and process
birth. The controller and local leases must be settled and the process must be absent.
A newer launch, foreign or unknown process space, active controller or unresolved
environment retains the hold. A locked controller defers recovery without waiting
on its row lock. The existing scoped recovery worker wakes saved Retry after settlement.

Task Retry can preserve an accepted, fully committed cancelled result as history
when no user, agent or native Stop exists. The result terminal state must match the
run. Retry still checks controller, successor, process, workspace and lease ownership.
It authorizes a new continuation; it never replays the accepted result or changes
cancelled work to success.

## Closed read-only Windows Codex turns

Retry and automatic replacement can release a stopped local Windows session when
its saved Codex thread proves that the interrupted turn used only declared read
operations. The proof binds durable runner identity, independent session receipts,
workspace, provider thread and final turn. All turns must be closed. Native commands,
file changes, MCP calls, child agents, unknown items and writes retain the hold.

The reader uses a disposable home and never resumes the saved thread. It copies no
credentials or provider configuration. Orphan retirement requires that proof plus
the exact executable, parent, birth time and saved home. Readiness checks cannot
stop processes. Source changes invalidate the proof. Files, results and session
history remain intact. The trusted native Windows executable resolver is required;
without it, this recovery path refuses admission.

## Interrupted attachments before any turn

A local per-turn Codex attachment can stop while `run.attach` is pending, before any
turn or authenticated provider startup. Direct quarantine state or one archived
continuity source can qualify only when controller, runner, startup, run and released
environment records agree and every recorded process is absent. No provider turn,
tool invocation, result or active goal may exist. The original history, workspace and
saved source remain intact. Existing resume-or-replace policy decides provider startup.

Unverified state creates one reconciliation hold with permanent code
`native_session_continuity_unverified`. Dependency wakes cannot repeat setup against
that state. Explicit Retry rechecks the archived owner even after restart loses the
in-memory cleanup record. It cannot certify an unknown action outcome.
