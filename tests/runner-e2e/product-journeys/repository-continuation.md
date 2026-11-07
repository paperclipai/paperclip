# Repository continuation journey

`repository-continuation` uses the target's configured native agent and execution
environment. It creates one owned project and one owned task. The project uses
the public `octocat/Hello-World` repository at commit
`7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`. The fixture never pushes or changes
the remote repository.

The first browser request creates a random reference file and a short note in
the project checkout. The agent makes one local commit and registers the
reference and a self-contained Git bundle as downloads. The observer downloads
and verifies them before it sends the second request. That request supplies no
reference value or commit ID. It requires the original files to remain intact,
adds one follow-up file, and delivers a second committed Git bundle.

The oracle inspects actual Git objects in disposable bare repositories. It runs
no checkout, hook, project script, or remote fetch. Each commit must have the
expected parent and only the declared file additions. The repository's original
files must stay unchanged. The observer compares the committed file bytes with
the ordinary task workspace file API, checks the configured project source and
both native workspace bindings, and reopens all output links after reload.
Missing input, recreated history, extra native runs, wrong bytes, or a replaced
workspace fails the journey.

There are exactly two native runs, one per user request. The target supplies the
unchanged model, billing policy and overall deadline. This case does not test
automatic repository preparation, automatic continuation, remote pushes or pull
requests. Those are separate journeys.

The target provider owns authentication, source identity, usage collection and
cleanup. Intent and receipts are saved for the owned project and task. Git
bundles, raw API receipts, source bytes and workspace identifiers remain in the
private Product journey evidence directory. They must not enter a public report.
The normal final screenshot is restricted to the authenticated owned task page.

Registration and local assertion calibration do not establish a deployed pass.
Daily admission requires a fresh pass against the intended QA target with the
same source and assertion set, completed collection, and successful cleanup.

Browser result access opens the task's ordinary Artifacts panel. Each exact
registered attachment is downloaded through its visible production control, and
the downloaded digest must match the independent registered artifact receipt.
A URL present only in a chat message cannot satisfy this check.

The two-turn proof has a boundary: the final saved checkout's hidden `.git`
metadata and `HEAD` are not independently read after turn two. The ordinary
workspace file API protects `.git`, and remote workspace close-readiness does
not expose Git metadata. The second verified commit must still have the first
verified commit as its parent, the original saved files must remain intact, and
both runs must retain the same workspace binding. This case does not qualify
post-completion Git metadata durability for a third turn.
