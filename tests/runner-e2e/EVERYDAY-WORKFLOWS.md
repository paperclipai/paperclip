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
| Connect to a service with a human decision | `service-approve`, `service-decline` | Configure a real local MCP fixture through the connection UI; no provider call before approval; exactly one call after approval and a document containing the actual returned verification code; no call after decline. |
| Preserve work and queued input across interruption | `recover-runner`, `recover-controller` | Observe source before interruption, persist the user message, kill only a daemon whose command line proves ownership or restart the isolated controller; inspect continuation and the delivered result. |
| Stop work and change direction | `stop-redirect` | Click Stop, send one new request, reload, observe exactly one stored user message and the new answer, and reach Done. |

For normal completion, all story tasks must reach Done, with no active run,
pending completion confirmation, or scheduled recovery. Runs must prove native
identity and native terminal contracts. A workspace-contention cancellation is
not provider execution only when the persisted pre-dispatch record explicitly
says `providerWorkStarted: false` and no process/session/runner identity exists.
Other unexplained cancellations remain failures. Twelve total run records bound
each story, including contention and recovery.

Crash results need two separate interpretations: failure to finish automatically
is a **continuity failure**, while stopping at Blocked because an outcome cannot
be verified can satisfy the **safety rule**. A failed continuity cell alone is
not proof that the product should replay uncertain work. Inspect its retained
error, screenshot, queued message, and ownership evidence before proposing a fix.
The fault injector never clicks Retry or rewrites task state to obtain a pass.

## Matrix and running

The local matrix has eight cases on native Codex `gpt-5.6-sol`, native ACPX Claude
`claude-sonnet-5`, and native Codex `gpt-5.4-mini`: 24 cells. The two core profiles
also declare build/revise, delegation, and controller-restart cases on Daytona:
six cells. Remote runner-process killing is not supported. For remote controller
restart, a verified first download supplies the persistence checkpoint; the
controller is interrupted during a subsequent revision with another queued
requirement.

```sh
pnpm test:e2e:runner -- --list --suite everyday-workflows
pnpm test:e2e:runner -- --suite everyday-workflows --environment local --max-parallel 2
pnpm test:e2e:runner -- --id everyday-workflows.runner-codex-mini.local.build-revise
pnpm test:e2e:runner -- --suite everyday-workflows --environment daytona --max-parallel 2
```

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

ZIP evaluation executes agent-authored Python with a minimal credential-free
environment and bounded subprocess time. Run paid evals on a disposable test
host; this is not an operating-system sandbox for arbitrary hostile programs.

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
digest, run at least three independent local repetitions, qualify the six
remote cells against a verified image, and review every failure. Keep model
quality, lifecycle correctness, infrastructure availability, and latency separate.
