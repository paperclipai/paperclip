# Failure patterns and useful regression oracles

These are self-contained examples distilled from task investigations. They are
mechanisms to test, not assumptions about the current incident. Read only the
sections that match the evidence. Resolve current contracts and implementation
from the repository; no historical task or private conversation is required.

## An interrupted turn becomes a permanent task failure

**Mechanism:** A server restart restores session history, but the old active turn
is now failed or indeterminate. Recovery treats that provider status as a final
task outcome, or validates saved input against today's defaults. Useful work is
left behind a manual gate even though continuation was authorized.

**Prove:** Interrupt at the observed point, including an in-flight tool call when
relevant. Exercise both a surviving process and a lost process. Reconcile command
receipts and preserve the session's input identity. Assert one owner, no duplicate
side effect, retained files/context, bounded continuation, and correct disposition.
Repeat an interruption to prove the recovery budget and genuine stops still work.

**Trap:** A reconnect between completed turns proves less. A list of old prompt
strings does not define compatibility. Disabling warm reuse may hide the failure
while imposing a new startup cost on every turn.

## A successful result gets stranded during finalization

**Mechanism:** The provider completed useful work, but result persistence, artifact
copyback, checkpoint reconciliation, outbound delivery, or disposition failed.
The UI then shows either success without the deliverable or failure that invites
rerunning an already-complete external action.

**Prove:** Retain the original result and side-effect receipt, fail the relevant
finalization stage, then recover. Assert the result is delivered/persisted once,
no provider work is repeated unnecessarily, the lock is released correctly, and
reload shows the final output. A known result can be recovered even if the original
task has since moved on; re-read current state before applying it.

**Trap:** A successful provider turn, request acknowledgement, or status badge is
not proof that a user received the report, document, chat reply, or voice answer.

## A routing repair permits a second executor

**Mechanism:** A mention or chat follow-up targets someone other than the assignee.
A shortcut lets that agent execute without changing the assignee field. A unit
test proves the field stayed constant while both agents can now perform the work.

**Prove:** Attempt the conflicting wake while the real owner is active. Assert
execution and external side effects cannot start twice, and the legitimate owner's
queued work still proceeds. Test cancellation and follow-up routing through the
real shared policy, including identity, company, and trust boundaries as affected.

**Trap:** Database ownership alone does not prove execution ownership. Broadening
credentials or bypassing checkout is not a routing fix.

## Runtime inputs are malformed before the model starts

**Mechanism:** A relational join duplicates tools; names exceed a provider limit
after namespacing; dispatch binds a tool to the wrong connection; an explicit
environment variable is lost at an allowlist; execution and logging hash different
versions of a redacted payload. Later errors obscure the first invalid input.

**Prove:** Exercise the real query, final name builder, environment filters, or
cross-language serializer with the failing input shape. Assert both the rejection
case and the intended valid case. Preserve distinct connection bindings, full
authorized execution input, redacted logs, and integrity checks. Where config is
cached, test added, changed, and removed values in fresh and resumed sessions.

**Trap:** Deduplicating every same-named tool, disabling digest validation, or
forwarding all ambient variables can turn a startup fix into a correctness or
credential leak. Retrying the same invalid tool definition is not recovery.

## The deployed artifact differs from the tested artifact

**Mechanism:** A dependency exists in source but not the image actually served; a
test checks an obsolete image target; a native package skipped installation; a host
binary works while the sandbox platform cannot run it; a fix is merged but absent
from the tenant's served revision. Separately built artifacts may differ despite
sharing a source revision.

**Prove:** Inspect the target revision and artifact identity, actual image target,
installed executable, OS/architecture, and launch protocol. Start the real packaged
provider in that environment. Exercise the relevant fallback/install path and a
second turn if session reuse is involved. Keep model/account compatibility separate
from process launch failures.

**Trap:** Adding a dependency to a manifest or obtaining a 200 from a provider
probe does not prove the launched runner can execute it. A new patch is unnecessary
when the existing repair only needs to reach the target.

## Recovery confuses useful waiting with a blocker

**Mechanism:** Work awaiting CI, an eligible monitor, or a durable continuation is
marked blocked or abandoned. The opposite error removes a real approval, budget,
credential, or uncertainty gate to force progress. Recovery issues can recursively
create more recovery issues.

**Prove:** Cover actionable work with a durable next wake, a genuine human wait,
an exhausted budget, already-covered work, and repeated recovery. Assert the right
next actor and bounded attempts. Let the harness determine facts it can observe;
reserve human input for decisions or facts it cannot establish.

**Trap:** Changing a status label without scheduling useful work is not liveness.
An operator form asking whether an internal controller is dead is not a substitute
for ownership reconciliation.

## “It works” hides a slow or incomplete user journey

**Mechanism:** The model is quick, but preparation, shared repository locks,
database queries, remote startup, or finalization dominates latency. A local mock
benchmark removes the stage responsible for most of the delay. Separately, an
integration test may never reach real authentication or the destination output.

**Prove:** Measure submit-to-usable-output and the critical stage with the affected
configuration. Compare cold and warm cases where relevant. Use the real remote
provider from a local harness when it shortens iteration without removing the
failure. Check actual output and persisted state, including the next turn. If
optimizing a query, verify equivalent results and authorization as well as speed.

**Trap:** Extra trace spans only improve observability until a measured repair
improves the path. A fresh greeting or an OAuth setup screen does not establish that
the original task completed. Do not quietly change the model or effort to get a
faster number.

## Error evidence is incomplete or misleading

**Mechanism:** The UI reports a generic native failure, an earlier recovered
warning looks fatal, or an exception disappears between a tenant and an error
collector. An enabled reporting flag and successful requests do not prove a
particular event arrived.

**Prove:** Preserve the original structured cause across the boundary with bounded
redaction. Distinguish event creation, transport acceptance, and recorded receipt.
Verify the concrete error is shown to the user when actionable. Test the failure
path itself, not only the happy-path logger configuration.

**Trap:** Better future evidence cannot establish an uncaptured historical cause.
Report what remains unknown; do not turn an instrumentation PR into a claim that
the original task failure was fixed.
