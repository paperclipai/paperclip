# JEV issue-lane shadow decision service

JEV is an optional observer for TYR-X issue-lane suggestions. It has no
authority over Paperclip. Paperclip continues to own status, dependencies,
capacity, assignment, and wakes; XO continues to own ambiguous or strategic
decisions.

## Current and proposed route

The pre-change route is:

```text
issue/wake input
  -> Paperclip wake admission and dependency/pause/budget gates
  -> queued-run staleness and ownership checks
  -> Paperclip selects and claims the assigned agent run
  -> adapter execution
```

The shadow route adds one fire-and-forget observation after Paperclip has
selected and claimed the run:

```text
Paperclip-selected run -> adapter execution (unchanged)
                       -> JEV shadow suggestion -> run-log receipt
```

The JEV promise is deliberately not awaited by dispatch. A timeout, retry,
invalid response, missing credential, or receipt-write failure leaves the
existing route intact. No auto-assignment flag or mutation path is present.

The observation point is in `server/src/services/heartbeat.ts`, after current
issue and dependency facts are loaded and before provider adapter execution.
The existing gates remain the only dispatch authority.

## Data boundary

Raw titles, descriptions, comments, attachments, logs, credentials, customer or
vendor identifiers, shipment data, contract text, exposure data, and restricted
TYR-X data are never sent. The adapter accepts only an exact summary from
`server/src/services/jev-issue-lane-policy.ts`. Adding an entry is a code-reviewed
change. The initial registry contains synthetic trial cases only, so enabling
the feature does not send any existing company issue.

The adapter applies a second validation layer: summaries are length-bounded and
rejected if they contain credential markers, identifier-like strings, URLs,
email addresses, or restricted-data terms.

The run log records only:

- suggested lane and lane probabilities;
- actual model version;
- elapsed milliseconds;
- input, output, and total token counts;
- a bounded error category.

Request/response bodies, error bodies, issue identifiers, and key values are not
logged. This is the local run-log path (`heartbeat_run_events`), not Paperclip
telemetry and not OpenTelemetry.

## Runtime policy

- Feature flag: `PAPERCLIP_JEV_SHADOW_ENABLED=true` (default `false`).
- Credential: `TYPESAFE_API_KEY`.
- Official SDK: `@typesafe-ai/sdk@0.6.0`.
- Pinned model: `jev-1.13.0`.
- Per-attempt timeout: 1.5 seconds.
- Retries: at most one retry, using the SDK's bounded retry policy.
- Low confidence: suggestions below 0.60 become `needs_review`.
- Eligible input: exact reviewed registry entry only.
- Blocked/dependency-blocked/duplicate run: no call.
- Repeated observation of the same running run: no second call.

Compatibility was checked against the official
[`typesafe-ai/typesafe-sdk-js`](https://github.com/typesafe-ai/typesafe-sdk-js)
package and its `v0.6.0` release. The integration uses its public
`TypeSafeClient`, `choice`, typed `systemOne` result, timeout, and retry APIs.
TypeSafe's [model documentation](https://docs.typesafe.ai/models.md) lists the
pinned `jev-1.13.0` model. The adapter rejects a response that claims a
different model or has malformed probabilities, confidence, or usage; it never
copies an invalid provider model field into the run log.

## Secret installation for Marc

The approved target is the **Paperclip server process environment**, specifically
`process.env.TYPESAFE_API_KEY`. It is not an agent, project, or company-secret
binding: those bindings inject into agent workloads, while this integration runs
inside the control-plane server. The repository's concrete container paths are:

- `docker/docker-compose.yml` -> `services.server.environment.TYPESAFE_API_KEY`
- `docker/docker-compose.quickstart.yml` ->
  `services.paperclip.environment.TYPESAFE_API_KEY`

The live TYR-X deployment's host-side secret store is not defined in this
checkout, so this document does not invent one. Use the deployment's existing
operator-only secret mechanism to populate that exact container environment
key.

1. On the deployment host, open Proton Pass interactively and locate **TYR-X JEV
   Development**. Do not copy the value into chat, an issue, a shell command,
   shell history, source control, or Paperclip's agent environment UI.
2. Add the value to the existing operator-only container secret mechanism under
   the exact key `TYPESAFE_API_KEY`, targeting the Paperclip server container.
3. Keep `PAPERCLIP_JEV_SHADOW_ENABLED=false`; restart/recreate only the server
   container through the normal deployment procedure, then verify from inside
   the container that the variable is present without printing its value (for
   example, test only whether its length is nonzero).
4. Review and add the intended sanitized trial summaries in
   `jev-issue-lane-policy.ts`. Never add raw issue content.
5. After Marc explicitly confirms the secret and corpus, set
   `PAPERCLIP_JEV_SHADOW_ENABLED=true` and recreate only the Paperclip server
   container. This flag change is the explicit live-call gate.
6. Verify new `jev.shadow.issue_lane` run-log events contain only the allowlisted
   receipt fields above. Leave automatic assignment off.

No live TypeSafe request is part of repository tests or this implementation
task. Tests use an injected SDK-compatible mock.
