# Dependency wakes and deliberate stops

A task can remain blocked after all recorded dependencies finish. Its assignee
may be waiting for an external action. Blocking its own task does not request
another dependency wake. The periodic recovery sweep preserves this decision,
including native status decisions attributed to the assignee's bound run.

Title, monitor, and other unrelated edits do not change this wait. A later
assignment, status, or blocker-set update permits reconciliation again. A blocker
that completes or finishes workspace export after the wait also permits a wake.
The export must name the blocker issue. An export from the waiting task or an
unattributed operation in the same shared workspace does not remove its wait.
Normal readiness, duplicate-wake, interaction, pause, and execution gates still
apply. A board transition into blocked keeps the existing recovery behavior.
A ready state whose wakes all end in a failed run gets one retry. After two
failed wakes on the same cycle key, the backstop stops. Failed wakes from an
earlier blocked cycle carry a different key and do not cover the current ready
state. `cancelled` and `skipped` wakes do not count. A blocked task with a spent
retry budget and a latest assignee run that failed workspace validation gets
the board recovery action, and the escalation clears the resolved blocker edges.

Cancelling a run or pausing its agent suppresses immediate stranded-work recovery.
A queued user message remains a separate continuation request. The release path
still preserves independently authorized deferred input; stopping the old run
does not discard that input or grant permission to replay its old tools.
