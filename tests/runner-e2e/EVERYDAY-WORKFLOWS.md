# Everyday Paperclip workflow evals

This manual suite tests useful work through the production browser, public API,
native runner, and normal agent instructions. It complements the tightly
scripted runner contract fixtures. It does not add a scheduled or default paid
run: `--all` and generic profile selectors exclude it. Select the suite or an
exact execution ID explicitly.

## Stories and assertions

| Story | Cases | Required evidence |
|---|---|---|
| Build a small project and revise it | `build-revise` | Download both ZIPs through the UI; independently execute the delivered CLI and import its function; test the revision; retrieve the original bytes again. |
| Delegate and incorporate late feedback | `delegate-feedback` | One child assigned to Riley; send feedback while the child runs; find it in the child history and independently test `--max-length` in the delivered ZIP. The worker must not execute on the parent. |
| Hire a teammate and use them again | `hire-reuse` | One Morgan QA reporting to the lead, native runner and the same encrypted connection bindings, real child execution, then a second usable delivery from that same agent. |
| Decide on an installed service action | `service-approve`, `service-decline` | Assign an authenticated local MCP fixture with Ask first; match its tool action and connection ID; no provider call before approval; exactly one after approval and a verified document; none after decline. |
| Decline a new connection | `connection-decline` | Start without service connections; match a Notion connection intent; click Not now; verify the saved rejection, no new connection or repeated request, and an explanation followed by Done. |
| Continue work after a controller restart | `recover-controller` | Observe saved source, persist a user message, restart the isolated controller, and independently test the delivered result. |
| Stop work and change direction | `stop-redirect` | Click Stop, send one new request, reload, observe exactly one stored user message and the new answer, and reach Done. |
| Create and edit a company skill | `create-skill-studio` | Create one skill through the runner, verify its persisted library entry and activity-feed card, open Skill Studio, save an edit, and verify the edit after returning. Local Codex, local ACPX Claude, and warm Daytona cells are explicit. |

For normal completion, all story tasks must reach Done, with no active run,
pending completion confirmation, or scheduled recovery. Runs must prove native
identity and native terminal contracts. A workspace-contention cancellation is
not provider execution only when the persisted pre-dispatch record explicitly
says `providerWorkStarted: false` and no process/session/runner identity exists.
Other unexplained cancellations remain failures. Twelve total run records bound
each story, including contention and recovery.

Arbitrary runner-process termination is not part of the model scorecard. The
historical `recover-runner`, `recover-runner-safe`, and `recover-runner-uncertain`
attempts remain available as diagnostics, with their original grades and costs.
The first two did not establish a safe restart boundary, and the uncertainty
case measures a deterministic safety rule. None supports ranking models.
See [controlled recovery tests](../runner-recovery/README.md).

## Matrix and running

The local matrix has nine cases on native Codex `gpt-5.6-sol`, native ACPX Claude
`claude-sonnet-5`, and native Codex `gpt-5.4-mini`: 27 cells. The two core profiles
also declare build/revise, delegation, controller-restart, and skill-creation cases
on Daytona: eight cells. Remote runner-process killing is not supported. For remote controller
restart, a verified first download supplies the persistence checkpoint; the
controller is interrupted during a subsequent revision with another queued
requirement.

```sh
pnpm test:e2e:runner -- --list --suite everyday-workflows
pnpm test:e2e:runner -- --suite everyday-workflows --environment local --max-parallel 2
pnpm test:e2e:runner -- --id everyday-workflows.runner-codex-mini.local.build-revise
pnpm test:e2e:runner -- --suite everyday-workflows --environment daytona --max-parallel 2
```

Before project stories or the Python calibration tests, start Docker on the
harness host and fetch the pinned oracle image. CI prepares and verifies this
same pinned image before the paid project-story cells; artifact checks run on
the harness host. The workflow verifies the exact repository digest after the
pull. This is required for local and Daytona stories.

```sh
docker pull python@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285
python3 tests/runner-e2e/everyday-artifact.py --preflight
```

The harness checks this prerequisite before it creates the task. It does not
pull an image during a model attempt or fall back to host execution.

Use the credential and immutable Daytona image setup in [README.md](README.md).
Provider calls cost money. Each cell owns an isolated instance and project.
There are no real third-party mutations in the service fixture; it exercises
production connection, transport, tool approval, and document delivery paths.

## Deterministic checks and calibration

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
python3 -m unittest discover -s tests/runner-e2e -p test_everyday_artifact.py
```

The independent oracle rejects wrong output, ignored late feedback, trailing
separator bugs, invalid argument acceptance, duplicate source modules, archive
path traversal, and symlinks. Passing agent-authored tests cannot override it.
Lifecycle calibration rejects legacy execution, missing runner identity,
unexpected crashes, workers on the parent, and answers left in review.

ZIP evaluation runs delivered Python in a Docker container with a read-only
project mount and root filesystem, no network, a non-root user, no Linux
capabilities, and bounded CPU, memory, process count, output, and duration. Only
the extracted delivery enters the container. The container is removed after
grading. Calibration includes attempts to read a host file and reach a host
loopback service.

## Evalbook evidence and qualification

Each packaged attempt retains `snapshots/everyday-workflow.json`, downloaded
ZIPs, assertions, actual task comments and run records, timing, accounting,
source provenance, and screenshots. The story records a digest of its harness
sources. Infrastructure failures and failed attempts must remain inspectable.

Import packaged results with `paperclip-evals/evals/everyday-workflows/import_results.py`.
It uses the canonical Runner Evalbook generator and the built Runner Lab viewer.
It does not invent provider transcripts, tool counts, model observations, or
cost estimates. The selected model is checked against persisted native execution
inputs; that is distinct from provider-side model identity verification.

Initial live results are diagnostic. They are not a reliability estimate or a
model ranking. Before promotion, freeze both source revisions and harness
digest, run at least three independent local repetitions, qualify the eight
remote cells against a verified image, and review every failure. Keep model
quality, lifecycle correctness, infrastructure availability, and latency separate.

## Revised evaluation contract (14 September, second campaign)

That campaign used 32 cells: the original local stories plus two local Codex
text-only safe-replacement probes, and the unchanged six remote cells. The old
`recover-runner` results remain historical; `recover-runner-uncertain` is a new
case that expects a visible Blocked safety stop, preserved source and queued
input, and no unverified provider replay. Its Retry control is inspected, not
claimed to restore work. Successful manual recovery remains unqualified.

`recover-runner-safe` interrupts a text-only Codex turn and queues new direction.
A pass requires the server's durable `verified_safe_replacement` evidence and the
new answer. No safety proof is injected or fabricated. If that premise cannot be
verified in a live probe, report it as an unqualified recovery boundary, not an
established product defect. Claude has no catalog cell for this Codex-specific
replacement proof. Deterministic native-safe-replacement tests cover its proof
and admission gates independently of model behavior.

Delegation now submits feedback through the existing child task composer and
records the delivered comment ID. The child must consume the message and deliver
the revised program. This does not require a lead to relay a parent comment.
The separate issue-update-comment-wakeup route tests exercise exact supported
mention routing, including access, dependency, identity, and duplicate-wake gates.

The approval case provisions an authenticated local service through the public
API, with a random server-held credential that never enters the agent environment
or browser trace. Approval/decline interactions still use the browser. Provider
captures distinguish rejected unauthenticated requests from accepted calls. The
old public-endpoint attempts remain boundary evidence, not an isolation promise.

Stop now waits for the owned runner to exit, records project file hashes, and
checks them again after the new response. This proves stability over that interval,
not indefinite monitoring. Hiring and declined-access policy changes are deferred
by user decision; their old results must not be presented as new campaign runs.

## Decline correction (14 September, third campaign)

That campaign used 35 cells (29 local, six remote). `service-decline` tests
rejection of a protected action on an already installed service; its former
"connection request" title was misleading. `connection-decline` separately tests
Not now on new Notion setup. Both permit a brief explanation as the complete
fallback, so Done is expected after that explanation. Neither test requires
completion after refusing work that is still required.

The installed-service decline fixture now uses the same server-held credential
as approval. The harness requires one pending interaction, validates its kind
and connection/provider identity before clicking, and waits for the exact
interaction's saved decision. Wrong interactions fail `decision-request-matches-story`
with a screenshot; they are not evidence of an ignored decline. Both decline
stories check a new explanation after the decision and reject repeated requests.

Historical attempts remain unchanged. This campaign resumes the previously
deferred decline cases; hiring remains deferred. Notion setup is declined in
the UI, so this test neither authenticates to nor reads real Notion data.

Decision screenshots are included in the evidence package. Before capturing the
final screen, the harness waits for the thread and latest persisted agent comment
to render, then scrolls that comment into view. A Done header alone is not proof
that the final response was visible.


## Recovery scope correction (14 September)

This correction reduced the catalog to **30 cells: 24 local and six remote**. Forced runner
crash probes are retired from paid selection. Their original attempt IDs remain
in Evalbook's Diagnostics history and Latest pages; they are excluded from the
main matrix without changing grades or deleting evidence. Reported spend still
includes all attempts.

`recover-controller` and `stop-redirect` retain concrete supported journeys:
restart the controller while preserving the runner, or use Stop and submit a new
direction. Their assertions verify pending input, saved work, and the next
usable result. Neither claims recovery from an arbitrary provider-process crash.

A future user-facing crash-recovery case needs a reproducible recoverable fault,
an identified supported recovery action, and evidence through the final usable
result. A missing test premise must be reported as unexercised, not a model
failure. Do not introduce a new paid case just to replace a retired row.

## Skill creation (16 September)

`create-skill-studio` adds five cells: three local profiles and the two core
profiles on Daytona. The current catalog has **35 cells: 27 local and eight
remote**. The test opens the created skill from its task-feed card, checks the
canonical skill identity in Studio, saves an edit, and returns to the same skill
in the task sidebar. A model's authored document heading is not used as the
identity check.
