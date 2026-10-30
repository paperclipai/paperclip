# Product journeys across deployments

`product-journeys` is an explicit Product E2E selection. Deployment is separate
from the `local` / `daytona` execution environment. Existing selectors, execution
IDs, and the `--all` matrix keep their historical meaning. These are scripted
browser journeys with API setup and independent assertions; they are not strict
browser-only “use as a user” discovery.

| Concept | Owner |
| --- | --- |
| Journey | User actions, prerequisites, assertions, feature-map associations |
| Target provider | Authentication, deployed identity, configuration, acquisition, cleanup |
| Setup recipe | Resolve requested company/user/task capabilities through the fixture registry |
| Campaign | Explicit journey order, target, model profile, limits, lifetime |

Shared code is in `product-journeys/`. Cloud fleet operations, email-code login,
private state, and trusted CI live in the private `paperclip-cloud` repository.
The `TargetProvider` version-1 interface is defined in `product-journeys/types.ts`.
Journeys receive a ready browser, company-scoped API, IDs, and capabilities. They
never start a server or depend on a tenant filesystem.

## Selections

| Journey | Required starting state | Observed outcome |
| --- | --- | --- |
| `task-create` | Company and signed-in board user | Create a task through the shared production composer, assign it to yourself, reopen and reload it, verify the saved prompt and no agent work |
| `ask-question` | Company, configured agent capability, positive model allowance and exactly one permitted work run | Reuse the existing cross-model Ask question prompt; require one successful run with matching company/task/agent/model/environment, one saved exact answer, and visible readback after reload |
| `task-properties` | Company, signed-in board user, task-write capability, prepared run-owned backlog task | Open its properties, assign it to the signed-in user, reload, check both UI and saved assignment; verify no agent run |
| `plan-revise-accept` | Native agent; three work runs | Reuse the classic Plan story: canonical draft, browser revision request, new revision-bound confirmation, approval and exact saved final response |
| `build-revise` | Native agent; two work runs; qualified Docker artifact oracle | Browser-download both ZIP versions, independently exercise source/CLI behavior, verify different hashes and preserve the original download |
| `protected-actions` | Native agent; four work runs; authenticated reachable review-service fixture | Approve one action and decline another on separate owned tasks; verify zero calls before either decision, one after approval, zero after decline and a truthful saved explanation |
| `create-skill-studio` | Native agent with skill-write permission; one work run | Create a uniquely named company skill, open its activity card, edit in Studio, reload and verify task-card readback |
| `stop-redirect` | Native agent; three work runs; qualified Docker oracle | Download a verified checkpoint, Stop an active revision, require native cancellation acknowledgement, submit a new direction once and verify completion without original-run activity |
| `cloud-onboarding` | Signed-in admitted Cloud account; fresh workspace; qualified bounded provider route | Create workspace in the portal, connect API key and native Codex agent in the wizard, complete a task, download and independently check its artifact |

Supported acquisitions are managed self-hosted (`local`), registered existing
Cloud (`local` or `daytona` when present), and new Cloud. New Cloud must start
with onboarding. Its context can then satisfy the identical task-properties
journey without another setup. A recipe reports `startingState: recipe`;
reusing successful onboarding reports `onboarding`. Preconfigured state is never
counted as onboarding coverage.

The scripted onboarding request supplies a self-contained child brief. The
parent must copy the full marked brief verbatim into `create_task.description`,
including tool names, parameters, and the encoded input. It orders the child's
work: create the files, publish `connection-proof.json` with that exact filename
and workspace-relative content reference, save its Paperclip task document with
the returned file link, then report completion. A Markdown workspace note does
not replace the task document. It explains the native completion contract:
include actual verification, omit the optional schema, and use receipt-derived
deliverable references in evidence and file artifacts. Local input paths are verification
details. Correcting rejected tool arguments stays within the same attempt;
it does not retry the journey. The model still computes the result, publishes
the file, saves the document, and completes the tasks. Independent download,
math, provenance, document, and parent-link checks remain authoritative.
Historical failed attempts retain their original fixture and outcome.

Save this credential-free local target config outside the repository:

```json
{
  "version": 1,
  "id": "local-qa",
  "mode": "managed-self-hosted",
  "journeys": ["task-properties"],
  "executionEnvironment": "local",
  "baseline": { "features": {}, "connections": [] },
  "limits": { "durationMs": 600000, "modelBudgetCents": 0, "maxRuns": 0 }
}
```

```sh
pnpm test:e2e:runner -- --suite product-journeys --list
pnpm test:e2e:runner -- --target-config /private/target.json --preview
pnpm test:e2e:runner -- --target-config /private/target.json --output /private/new-campaign
```

Preview resolves selections and declared changes without loading the private
provider, reading credentials, signing in, provisioning, or making model calls.
Its output includes required state, features/connections, lifetime, and limits.
Output directories must be new; an attempt is never overwritten. Browser-only
results use null provider/model and runtime `none`, including failures before
the journey starts. No artificial model run is introduced for reporting.
New execution IDs have the form
`product-journeys.<target>.<profile-or-browser>.<environment>.<journey>`; the
report reader continues to accept historical four-part execution IDs.

Cloud config supplies `adapterModule` and the private provider's reference-only
`adapterConfig`. Use the private CLI and runbook to configure those fields.
Paid onboarding requires positive `modelBudgetCents` and `maxRuns`, a duration
of at most one hour, and a qualified operations adapter. The initial private
Cloud adapter admits at most 30 minutes and $10. Select `runner-codex-mini`
explicitly for its `gpt-5.4-mini` pilot; existing profile defaults remain unchanged. There are no automatic
story retries. One campaign may create at most one disposable workspace.

Workspace contention can defer a child before provider execution. The journey
keeps that run and follows only its unique, scoped durable replacement when the
server proves that no provider work started. A scheduled replacement remains
pending and consumes the run limit. It cannot satisfy completion; the child must
still finish through native execution and pass the independent artifact checks.

The attached `ask-question` recipe requires a prepared native general agent and
an explicit execution environment. Legacy execution is unsupported until its
saved model/provider identity can be verified. A registered
agent avoids a new setup probe; a disposable QA agent uses the existing native
fixture defaults and its setup remains separately unpriced. A restricted review
bot is not a general-work fixture.
The private provider supplies its exact execution identity through the `agent`
capability and collects normalized run usage. The existing Cloud provider still
owns authentication, conditional leases, fixture ownership, and cleanup.

The Plan, Stop and protected-action decline checks reload the owned task and bind its exact,
unique visible reply to the final successful native run. A settled native turn
can render its saved reply before the comments projection exists; that path also
requires exactly one matching final assistant message in the complete durable
event stream, with the same company, agent, run and validated PRP source. If the run
has a projected selected completion comment, only that attributed comment can
satisfy the check. A pending or suppressed comment can use the same proven native
reply path. A finish summary by itself, an earlier turn, a progress
bubble, or a cancelled run cannot satisfy it. Private receipts record the run,
thread anchor and observed text; classic protocol comment matchers stay strict.
Markdown replies compare complete text, GFM checkbox states and exact link destinations after parsing
through the UI-owned projection of its existing Markdown renderer and GFM/issue-reference plugins. The observer receives the
same visible-company prefix list used by the UI, so bare issue keys and URLs
match their rendered links. Whitespace and inline formatting can change during rendering. A
document or issue chip can replace a link label, but must retain its destination.
Ordinary links retain their source label. Destination resolution uses the existing
production company-route helper and the current task URL for fragments.
Receipts retain both source Markdown and observed content. Unsupported structures
such as images, raw HTML, tables and fenced code fail closed. Exact marker checks
remain exact, and decline checks inspect both visible explanations and source
text for unread service data.
The decline oracle accepts this explicit native receipt without inventing an
issue comment. The final run must start after the saved decline, and the usual
truthful explanation, zero service calls and no unread marker checks still apply.
A model allowance is an accounting threshold; reused direct-provider routes do
not acquire the onboarding gateway's request-level cash guarantee. The question
observer allows one run and waits at most four minutes. Cleanup stops only
run-owned question work; shared agent configuration stays outside ownership.
When the QA adapter explicitly selects terminal-history retention, it terminates
its disposable agent, makes owned tasks terminal, verifies no active runs, retains
the records for decision-history integrity, and releases both QA leases. This is
reported as retained data, rather than confirmed deletion.

## Evidence and lifecycle

Results use the existing campaign/result schemas and dashboard. Each result
retains campaign/attempt IDs, source revision, definition hash, deployed tenant
commit, Cloud release, runtime identity, configuration hash, setup provenance,
checks, and authentication/setup/journey/collection/cleanup outcomes. A failed
prerequisite remains failed at that boundary; every dependent selection receives
a blocked result. Unsupported target capabilities are distinct from failures.
Deployment/configuration drift during a journey fails its result.

New onboarding attempts retain a bounded `productJourney.artifact` receipt in
the existing private `normalized-results.json`, before disposable cleanup. It
includes the exact downloaded `connection-proof.json` bytes as base64, attachment
and originating-run IDs, byte count and SHA-256, plus the harness-generated input
and independent expected result. Reinspection can decode the original bytes,
recompute their checksum, and recompute the expected nonce, count, sum, and input
checksum after the workspace is deleted. Only this exact four-field synthetic
fixture is admitted, with a 4 KiB download limit and a closed receipt schema;
arbitrary agent output is excluded. Capture follows attribution and independent
download verification. The receipt survives later document, link, reload, or
trace failures without turning those failed journey steps into passes.
Historical attempts without it remain readable and do not gain retained-artifact
proof retroactively. Descendant stories reuse context without copying the receipt.

Collection must finish within the campaign deadline. Cleanup and evidence
publication then share a separate ten-minute grace period, with the last thirty
seconds reserved for a twenty-second stop-only fallback and ten-second browser
close. These are cleanup bounds and do not admit further story or model work.
Provider lifecycle hooks receive a deadline and cancellation signal; they must
bound in-flight requests and fence late resource mutations or lease writes when
the signal aborts. A timed-out release cannot authorize evidence finalization or
lease release. Its manifest stays available for cleanup recovery.

Every would-be successful result is checked against the retained-result success
contract before successful cleanup. Missing assertions or paid accounting proof
turn the campaign into a failure while preserving valid cost receipts, so an
invalid success cannot trigger disposable-stack deletion.

The shared Plan story additionally retains draft and revised task screenshots privately. Other screenshots capture the post-journey task. Failed task/search screens are
retained only after tenant setup; authentication pages are excluded. Browser state, login codes, raw
errors, credentials, request headers, and auth screenshots are excluded. All
Cloud evidence is private; the public history publisher rejects these bundles.
The private provider uses conditional S3 identity/stack leases and intent/receipt
ownership manifests. An expired lease permits cleanup recovery, not reuse.

Managed self-hosted instances are removed after every attempt. Existing Cloud
stacks retain the QA account and declared baseline while removing verified
run-owned fixtures. Successful disposable stacks are deleted. Failed disposable
stacks are stopped and retained for up to 24 hours. The deployment provider
declares earlier cleanup eligibility to leave time for its sweeper. Interrupted cleanup
remains visible and retains exclusive stack ownership. QA identity and inbox
never belong to disposable ownership.

## Eval operations integration and qualification

The private adapter carries the same campaign/attempt identity through bounded
request admission, setup/agent phase transitions, run observation, cost receipts,
trace IDs, and feedback collection. A normalized operations receipt belongs
only to the onboarding attempt; descendants do not repeat shared setup charges.
Unknown cost remains unknown. Raw feedback, traces, and ledgers stay private.
Invocation evidence distinguishes native event inspection from a proven
`provider_not_started` workspace deferral. Both require complete event reads.
Pending replacements and contradictory execution evidence remain partial.

The sibling **Operationalize eval runs** implementation currently admits local
cells and binds its gateway to loopback. That is not Cloud reachability or budget
qualification. A Cloud adapter must prove the selected runtime's route, effective
credential binding, budget admission, and exact campaign deadline before any
paid provider action. The normal wizard first saves a custom-gateway connection
and selects its model without inference. Qualification checks this exact saved
route from the actual runtime before the normal Connect probe. Missing qualification blocks onboarding; it must never fall
back to an unmetered direct provider request.

As of 2026-10-22, the same task-properties story has passed in real browsers on
managed self-hosted and a registered testing Cloud stack, including cleanup and
zero model calls. Normal QA email-code authentication and account admission have
also passed against testing. Cloud onboarding selectors and lifecycle contracts
have offline tests; fresh onboarding, dependent reuse, and disposable cleanup
remain unqualified. Provider and trace secret references are configured. The
separate onboarding gateway product change, trusted CI selection, and real
runtime gateway admission remain live qualification prerequisites. Testing and staging use separate
registries and credentials; only the declared testing control plane is admitted. Defining a story or passing structural checks is
not evidence that its Cloud journey passed.

## Reuse and daily QA promotion

The classic matrix and deployment-targeted stories share Plan revision actions,
artifact download/oracle code, Skill Studio editing and protected-action decisions.
Their target adapters own login, agent/connection provisioning, environment
identity, and cleanup. The managed local recipe currently provides browser-only
capabilities; paid stories fail as unsupported until a native agent fixture is
supplied. This does not turn a classic local pass into a QA Cloud pass.

Paid deployment campaigns declare the exact sum of expected work runs (Ask 1,
Plan 3, artifact revision 2, protected actions 4, Skill Studio 1, Stop/redirect 3).
Each observer reads only its owned tasks and checks native company, agent, model
and execution-environment identity. Setup is separately unpriced. Skills and
service connections are uniquely owned; customer credentials and company-wide
configuration are never copied into a journey.

The private QA adapter keeps candidate cases available for manual qualification.
A candidate's presence in this source catalog is not qualification. It enters the
saved daily TestOps plan only after an inspected real QA Cloud pass including
usage, artifact/decision evidence and cleanup. The daily driver runs that saved
plan against the registered QA tenant; it does not substitute a local instance.
