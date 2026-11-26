---
navigation: {"section":"Agents and reusable capabilities","sectionOrder":30,"order":20}
---

# Runs, harnesses, and model accounts

Operators choose an agent harness and model account, inspect execution history and transcripts, and distinguish a working configuration from a successful task result.

Implementation: [adapter manager](../../ui/src/pages/AdapterManager.tsx), [run host](../../ui/src/pages/AgentDetail.tsx), [configuration](../../ui/src/components/AgentConfigForm.tsx).

Agent access: [companion](../agent-access-map/runs-adapters.md).

## Sub-features

- `availability`: discover installed adapters and available models/accounts.
- `validation`: test an adapter in the selected execution environment and surface authentication failures.
- `runs`: inspect run status, events, output, costs, and the source task.
- `session`: preserve or reset execution context through supported lifecycle actions.

## How to get to it (user POV)

### `adapter-setup`

Open an agent’s model/adapter configuration or the instance adapter settings page when permitted.

### `run-history`

Open an agent run at `/agents/:agentId/runs/:runId` from the agent or task activity.

For latency diagnosis with an operator OTLP endpoint, search the hashed run ID
without restricting the root span name. Compare workspace preparation with its
`workspace_<step>` intervals. Measure controller readiness separately through
`controller.startup.<phase>`. A recovery pause or deployment drain is not model
execution time. See the [tracing contract](../../doc/observability.md#controller-preparation-phases).
These source-level diagnostics do not establish a live response-time budget.
Inspect `native.controller.<phase>` for backend construction, assigned-tool
discovery and post-turn cleanup. Compare those intervals with the actual model
turn; do not count a nested discovery interval twice.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Record adapter, model, account, native/legacy runtime, and environment. Capabilities vary; one harness result is not a matrix-wide qualification.

### `adapter-setup`

Automated: [adapter validation routes](../../server/src/__tests__/agent-adapter-validation-routes.test.ts) and [model refresh](../../server/src/__tests__/adapter-model-refresh-routes.test.ts) cover server behavior.

Claude native setup uses the existing Anthropic API-key or subscription connection
flow. Record the selected account separately from successful execution; unavailable
models/authentication and unsupported Legacy-only options must fail visibly.

Manual: Select the intended adapter and account, refresh model choices, and run its environment test. Save, reload, then execute a small task. Repeat with a deliberately unavailable account and verify the failure remains visible.

Choose Codex as the harness; the UI displays its name/icon for both runners.
Advanced identifies the automatic default and offers Paperclip Runner or Legacy.
New Codex agents default to the native runner on supported macOS or GNU/Linux
targets; the [shared selection contract](../../packages/shared/src/agent-runner.ts)
and [runtime prerequisites](../../packages/paperclip-runner/README.md) define the
platform/libc boundary. Windows and Alpine/musl remain Legacy. Claude follows
its qualified rollout described above. Disabled adapters, external overrides, and selected-target
qualification also affect availability.
On a fresh forced-Kubernetes instance without an environment row, inspect discovery
and create with automatic selection. Both must retain Legacy without provisioning;
an explicit Paperclip request must give target-qualification guidance. Begin the
ordinary task to exercise the existing lazy environment path. This live journey
remains separate from the resolver's source controls.

For sandbox defaults, follow the [environment probe](./execution-environments.md#environment-settings)
recipe first. Discovery/creation read company-bound immutable-image evidence
without allocating a target. A mutable image or snapshot name does not establish
native compatibility. Then test the actual selected runtime with its selected
account/model: a legacy CLI or authentication probe alone cannot establish native
readiness. For an image-provided Codex harness, verify both final executables
after concurrent artifact preparation on an eligible provider. Repeat with a
failed runner probe and confirm the harness work has settled before failure
returns. Providers without concurrent sync and explicit harness installs remain
serial. The [real-shell artifact controls](../../server/src/services/native-runtime/native-artifact-preparation.test.ts)
cover these source contracts; they do not establish live reply latency.
For remote native Codex with managed GitHub access, inspect the controller
preparation spans for overlapping GitHub setup and assigned MCP discovery.
Provider startup must wait for both. Force either preparation to fail while the
other is pending; confirm that the pending operation settles and run-owned access
is released before failure returns. Repeat a warm follow-up and retain its actual
reply time. The [executor controls](../../server/src/services/native-runtime/native-session-executor.test.ts)
cover ordering, failure drain and credential projection; they do not qualify a
live response-time target.
Missing dependencies, failed authentication, invalid models and
incompatible custom settings must remain actionable errors without silent runner
switching. Saved unchanged execution can still be tested without applying new
selection policy, but runtime/account validation must still run.

Verify an automatic Codex hire and an explicit Legacy control through a useful
file artifact, follow-up and reload. Preserve Codex reasoning effort and account
isolation; retain explicit Legacy permission choices, including false. Reopen an
existing agent, make an unrelated edit, and confirm both its persisted runner and
next run stay unchanged. Use [hiring/import preservation](./agents.md#hire-agent)
for approval and portability controls.

Test native Codex with a saved subscription whose setup auth file is a managed
link, as well as a regular file and an API-key account. Setup must seed the
isolated probe from the checked account without exposing credentials or changing
its saved runner. With subscription authentication, an unbound configured
`CODEX_HOME` with linked credentials must fail setup with managed-account or explicit Legacy guidance; it must not claim
readiness when task isolation would omit the file. Dangling or incorrectly owned
credentials must also fail clearly. A selected `CODEX_API_KEY` or
`OPENAI_API_KEY` takes precedence over an unrelated subscription file. Test valid,
dangling and invalid subscription links with that selected key; setup must test
the key without reading or refreshing the unrelated account. The private probe copy must be removed after confirmed retirement following success,
failure or cancellation. Unconfirmed shutdown remains a cleanup failure.
Exercise an unavailable local daemon and a preparation failure before probe
handoff. No owned temporary credential copy may remain, and original account
files must be unchanged. A probe whose shutdown is unconfirmed must retain its
recovery state; do not treat it as a preparation-only failure.
Existing setup controls use fake credentials; real account execution remains
a separate acceptance requirement.

### `run-history`

Automated: [live run routes](../../server/src/__tests__/agent-live-run-routes.test.ts) and [run event sequencing](../../server/src/__tests__/heartbeat-run-event-sequencing.test.ts) cover run data contracts.

Manual: Start a disposable task, open its running transcript, and follow it to a terminal outcome. Reload and compare task/run IDs, status, output, and cost. Verify a failed run remains distinguishable from a completed run with useful output.

An explicit runner change starts a configuration revision and invalidates the
eligible session. Active runs, restart recovery and historical transcript parsing
retain their recorded execution configuration; do not infer their runner from a
later edit to the agent. Account/harness branding and execution identity are
different observations, both required in the evidence.

For an onboarding child-completion callback, verify actual session/turn events
and the source-correlated reply. A `succeeded` row alone is insufficient: the
literal `ea6c8eb5e16d61111968f633a66748b397b64a3e` managed attempt was marked
successful during startup without a provider turn. The recovery correction
preserves the existing validated Done-parent handoff; process-death and ownership
checks remain active. Its PostgreSQL controls are separate from the required
revised-source live onboarding and follow-up proof.

## Gotchas

- Model accounts are managed in Apps and inline agent account controls.
  `/company/settings/connections` configures decision/fast-response models,
  not the general model-account library.

- The run log is instance database data; it is not the opt-out first-party Telemetry system or operator-configured OpenTelemetry tracing.
- Authentication/model discovery does not establish tool, image, steering, or resumption capability parity.
- Use [recovery](./recovery.md) for interrupted runs and [execution environments](./execution-environments.md) for local/SSH/sandbox differences.

Native setup retirement joins owned startup before cleanup can be confirmed.
[Transport ownership controls](../../packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts)
hold preparation or registration without launching a provider, then check bounded
close, rejected duplicate requests, no later launch and retention of unconfirmed
state. Readiness observes shutdown; resumed startup cannot reactivate ingress
after close. These are lifecycle controls, separate from installed provider proof.
The real daemon readiness and recovery controls require their existing native
fixtures in hosted CI; passing credential-free controls does not qualify them.
A primary setup timeout remains a failure even when teardown also fails.

For remote setup shutdown, verify that each durable-state read respects the
remaining suspension deadline. A late result cannot establish suspension or
queue a replacement command after that deadline. An intentional ingress close
must observe physical socket closure before retiring its connection owner and
releasing the endpoint; an unresponsive peer must not extend the setup budget.
The existing transport and ingress suites exercise these conditions without a
provider. Repeat the actual managed setup and useful task journey separately;
the literal `651a3de64fc943216cc414b64b1443809f9499da` Test attempt failed
cleanup before hire and retains its unconfirmed recovery state.
