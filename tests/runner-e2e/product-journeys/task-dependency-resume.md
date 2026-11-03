# Blocked task resumes after its human-owned blocker

`task-dependency-resume` is an explicit Product E2E journey for an authenticated
existing Cloud target or a target provider with a qualified native agent. It uses
the ordinary task UI and public observation APIs. Its registration is not evidence
of a local or deployed pass.

The browser creates two tasks assigned to the signed-in person. The blocker holds
a random review reference absent from the dependent's prompt. On the dependent,
the person adds the blocker, selects Blocked, and assigns the disposable agent.
The saved dependency, blocked status, and empty task/agent run histories must
remain observable for at least ten seconds. This is a finite measured wait,
not an unlimited claim that no execution can ever occur.

The person completes the blocker through the task's status control. Paperclip must
then start exactly one native run automatically. Its durable wake must name the
same resolved blocker, `issue_blockers_resolved`, and `issue.blocker_done`; manual
Run or a follow-up message cannot substitute. The run starts after the saved
blocker completion, uses the configured provider/model/environment, commits its
result, and completes the dependent. A task document named `dependency-proof`
contains the review reference and blocker identifier. Its current revision must
be authored by this agent and run. Reloading the task must show that same saved
revision and preserve the two tasks' descriptions, dependency, and board-owned
blocker completion audit. No agent work is permitted on the human-owned blocker.

The case requires `company`, `board-user`, `task-write`, and `agent`. It declares
one work run, uses the existing bounded case budget, and shares the original
campaign deadline. Agent setup usage is outside task-run accounting; missing
provider prices remain unknown. The owning target provider controls normal
cancellation, termination, retained history, and evidence cleanup. It never
changes a shared source agent, company budget, or execution environment.

The private evidence folder contains `task-dependency-observations.json` and
`observation-read-failures.json`, with allowlisted owned task, run, audit, and
document facts. The normal launcher captures the final owned task screenshot.
There are no direct database writes, private runner hooks, manually dispatched
resumption wakes, retry loops for failed model work, or fixture-authored outputs.
Independent controls reject premature or duplicate execution, a never-resumed
or manually started task, foreign/changed runtime identity, missing completion
audit, wrong output or revision authorship, and missing or shortened observations.
