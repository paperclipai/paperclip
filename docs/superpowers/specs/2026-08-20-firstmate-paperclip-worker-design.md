# FirstMate Paperclip Worker Design

## Purpose

Make FirstMate a first-class Paperclip executor. Paperclip must track one durable
FirstMate run for each assigned task while FirstMate remains responsible for its
own coding subprocesses.

## Architecture

Add a `firstmate-gateway` adapter following the existing gateway-adapter
contract. The adapter talks only to the FirstMate service API/MCP bridge and
Paperclip's normal adapter runtime; it does not access the Paperclip database,
browser UI, or coding-agent subprocesses directly.

Paperclip assigns the task to FirstMate. The adapter obtains a run lease, starts
or resumes a FirstMate execution using a stable run-derived session key, streams
safe progress into the Paperclip run, and returns a structured terminal result.

Hermes remains the coordinator that creates and delegates tasks. OpenClaw
remains a separate reviewer assigned after FirstMate completes. FirstMate is
the only executor recorded for its coding task.

## Lifecycle

1. Paperclip leases an assigned task and invokes the adapter with run and issue
   context.
2. The adapter submits the rendered Paperclip task brief to FirstMate with the
   Paperclip API URL, scoped API key, run ID, issue ID, and idempotency key.
3. FirstMate emits normalized events: `started`, `progress`, `artifact`,
   `completed`, `failed`, or `cancelled`.
4. The adapter forwards redacted events to Paperclip and maps the terminal event
   to the existing adapter execution result.
5. A retry resumes the same FirstMate session when possible. A cancelled
   Paperclip run sends one cancellation request and never starts replacement
   work.

## Security and boundaries

- Store the FirstMate endpoint and an adapter-specific credential in Paperclip
  encrypted/secret-backed configuration, never in task bodies or logs.
- Accept HTTPS internal endpoints only, with the VTHQ CA trusted by the adapter
  runtime.
- Redact authorization, API-key, token, and secret fields from all emitted
  events.
- Enforce task/run identity binding: incoming FirstMate events must match the
  active Paperclip run and agent.
- FirstMate may operate only within its assigned task workspace; individual
  subagent activity is summarized, not registered as Paperclip agents.

## Failure handling

- Connection or stream loss is retried using the existing run lease and stable
  idempotency key.
- Unknown terminal state is reported as a recoverable run failure, never
  silently marked complete.
- Invalid event payloads or mismatched run IDs are rejected and logged with
  safe diagnostics.
- The adapter exposes a non-writing connection test that validates endpoint,
  authentication, and capability discovery.

## Verification

- Unit tests cover configuration validation, prompt rendering, stable session
  identity, redaction, event mapping, cancellation, and retry behavior.
- Adapter integration tests use a fake FirstMate gateway and verify that no
  external network or live coding work is required.
- Deployment smoke test creates no task: it validates authentication and
  capability discovery only.
