# Preserve database-only failed controller evidence

A retained failed run can already have a complete encrypted controller checkpoint
and its original inline session snapshot while both legacy controller files are
absent. This is preserved evidence. It does not become successful or executable
recovery authority merely because the instance changes storage mode.

The migration owner accepts this case only after the canonical checkpoint decoder
validates every record and its company/issue/run encryption binding. The selected
run, admitted execution and inline snapshot must match company, agent, issue, run
and normalized session. The decoded checkpoint and protocol header must also match
the run, Runner instance and normalized session. The exact controller and supervisor
paths must both be absent. A remaining file, symbolic link, unsafe path, invalid
binding or failed read keeps the obligation blocked.

The earlier failed checkpoint case with no inline snapshot keeps its existing
predicate. The new case does not replace an inline snapshot, create recovery
metadata, change a failed status or coordinator, settle an action, or move a task
pointer. Present legacy payloads still need the existing preservation path.

The focused regression uses the existing encrypted PostgreSQL checkpoint fixture.
It first reproduces the startup blocker. It then verifies the absent-files case,
remaining controller and supervisor files, foreign inline identities and foreign
checkpoint Runner/session identities. Existing null-snapshot and online/offline
archive controls run with it. The original queued turn, run, coordinator and
checkpoint rows stay unchanged, and failed evidence stays non-recoverable.
