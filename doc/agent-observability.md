# Company agent observability

Company Settings → General → Agent observability configures one company-owned
OTLP destination for Paperclip-managed Codex, Claude Code and native OpenCode executions. Export
is disabled by default. Choose Braintrust (US) or a custom HTTP(S) OTLP base URL;
use your own collector when you need fan-out. Braintrust EU and self-hosted
installations can use Custom OTLP with their required routing/authentication
headers. The receiver must be reachable from every execution environment;
`localhost` refers to the execution host, including a remote sandbox.

This is separate from Paperclip's first-party Telemetry and its content-free
[infrastructure tracing](observability.md). Configuring it does not change either data path.

## Capture and supported runtimes

The qualified versions are Codex 0.160.0 and Claude Code through ACP bridge
0.73.0 with Agent SDK 0.3.286. Both logs and traces use HTTP/protobuf. Prompts,
assistant responses and tool content default on. Additional tool details are a
Claude Code and native OpenCode control; Codex has no equivalent switch. Codex requests up to 64 KiB
of tool output (or zero when disabled); native event availability, truncation
and response caps still apply. Claude Code applies its own native limits.
Metrics, raw API bodies and Codex Guardian assessments are disabled.

Native OpenCode 1.18.34 uses a runner-owned HTTP/JSON exporter. Each completed,
failed or cancelled turn produces a trace with Paperclip company, agent, run and
turn IDs. Tool outcomes and message-level token/cost receipts are child spans;
repeated usage updates replace the same message receipt. Missing prices remain
unknown. This projection excludes hidden reasoning, raw provider payloads and
system instructions. Prompt, response, tool-detail and tool-content switches
apply before export. Content is bounded to 8 KiB per field and 64 tools plus 64
usage records per turn; truncation is marked. Tool inputs and full model request
bodies are not captured. OpenCode's performance-only OTLP sink stays separate.

The exporter sends once at turn completion with a three-second deadline, at most
four requests in flight and no idle polling or persistent queue. Closing drains
pending requests and marks an unfinished turn failed. Export failures emit a
sanitized diagnostic and do not change task outcomes. Abrupt process termination
can lose an unexported turn. Recovered in-flight turns without a new submission
are not replayed just to produce an observability record.

The native runner and legacy local adapters receive transient launch material.
Native Codex writes a private managed config.toml; legacy exec uses a unique
invocation profile, preserving a selected source profile. Its profile injection
requires the qualified executable version. Codex ACPX writes its isolated home.
The legacy ACPX adapter keeps export configuration in a private home per agent
and settings compatibility key, and shares conversation files with its stable managed home;
export changes do not change its logical conversation fingerprint.
Codex receives authentication through `OTEL_EXPORTER_OTLP_LOGS_HEADERS` and
`OTEL_EXPORTER_OTLP_TRACES_HEADERS` in its process environment. Its managed
configuration and invocation profiles contain empty header maps, so exporting
does not save the ingestion credential in those files. The bundled Rust OTLP
exporter percent-decodes environment header values; launch material encodes
them once to preserve literal percent sequences. Credentials remain literal
values in the company secret; config-file environment interpolation is not used.
A caller-owned/preconfigured Codex home cannot be automatically configured in
this version: its files remain untouched and execution emits a diagnostic.
Legacy OpenCode, other harnesses, personal Codex desktop sessions and hosted claude_managed are
outside this feature.

## Changes and process lifetime

Paperclip reads settings once when an execution begins preparation. That
snapshot governs instruction reservation, compatibility and launch. Already
preparing or running work retains its configuration. A changed settings
revision or resolved credential version retires an idle incompatible warm
process using existing ownership checks. Conversation compatibility is
separate, so a safe replacement can resume the saved conversation. Recovery
never replays an uncertain turn merely to apply new export settings.

Missing, disabled, invalid or unavailable configuration runs without company
export and reports a sanitized availability diagnostic where relevant. Native
export rejection/timeouts do not determine task success; exporter deadlines
are three seconds. OpenCode starts its bounded asynchronous request when the terminal event is
observed; event delivery and task settlement do not wait for the receiver.

## Credentials and access

Only board users with Manage connections permission can read or change this
configuration. Agents cannot retrieve it through the settings API. The destination stores no credential
values. Authentication headers live in one encrypted Paperclip-managed company
secret, bound to the system consumer company-observability. Updates rotate that
secret; removal uses the secret service to retire it. Braintrust project
routing is derived from the current project ID, independently of the API key.

Reads return configured status and header names. Blank existing custom header
values retain the saved secret at the same HTTP origin; a change of scheme, host,
or port requires every retained header value to be entered again. New/renamed headers require values. Removing a
row removes that header. API-key replacement is explicit, and Cancel clears
entered secrets. Revisions prevent another administrator's edit being silently
overwritten. Credential values are excluded from task environment manifests,
run/config snapshots, argv, activity records, recovery configuration and query
cache data. OpenCode keeps exporter credentials in the runner wrapper and excludes them
from its child environment and config. Codex and Claude Code receive headers through their
process environment, which their tools can inherit or inspect.
This feature does not isolate export credentials from agent code. Use a credential
limited to telemetry ingestion for the selected destination; do not supply a broad
organization administration key. A user-operated collector can hold upstream
credentials when a deployment requires a separate trust boundary.

## Connection tests

Saving never contacts the destination. Test saved settings sends one synthetic
root span and a correlated log with a unique marker from the control plane,
even when agent export is disabled. The receiver receives no production task
content. Both requests share a ten-second deadline, cannot redirect, and use
the deployment's guarded HTTP policy with DNS pinning and response-size limits.
Receipts contain sanitized HTTP/signal results and no receiver body text.
A receipt is retained only for the revision that was tested.

“Test payload accepted” means the server's synthetic payload was accepted. It
does not prove agent export, remote network reachability, downstream indexing,
or that a provider UI rendered the records. Harness exporters use their own
network clients under the execution environment's policy; the server's DNS
pinning applies only to the explicit control-plane test. Verify real tasks and
the destination's records before relying on a deployment.

## Verification

The focused suites cover schema bounds, concurrent saves, secret/header
lifecycle, authorization, protobuf transport and rejection, private-network
policy, timeout, revision fencing, environment projections, private native
configuration, warm compatibility, and UI conflict/company-switch behavior.
Storybook IDs agent-observability-01-settings, agent-observability-02-states and
agent-observability-03-journey use fake credentials and production components.
Real local/remote native export evidence must be reported separately from
these automated and synthetic checks.
