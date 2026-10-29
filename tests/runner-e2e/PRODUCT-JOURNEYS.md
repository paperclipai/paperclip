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
| `task-properties` | Company, signed-in board user, task-write capability, prepared run-owned backlog task | Open its properties, assign it to the signed-in user, reload, check both UI and saved assignment; verify no agent run |
| `cloud-onboarding` | Signed-in admitted Cloud account; fresh workspace; qualified bounded provider route | Create workspace in the portal, connect API key and native Codex agent in the wizard, complete a task, download and independently check its artifact |

Supported acquisitions are managed self-hosted (`local`), registered existing
Cloud (`local` or `daytona` when present), and new Cloud. New Cloud must start
with onboarding. Its context can then satisfy the identical task-properties
journey without another setup. A recipe reports `startingState: recipe`;
reusing successful onboarding reports `onboarding`. Preconfigured state is never
counted as onboarding coverage.

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

Only post-journey screenshots are captured. Browser state, login codes, raw
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
