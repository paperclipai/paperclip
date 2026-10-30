# Prompt Injection Prevention

Settings → Connections is always available. It contains Decision model, Prompt
Injection Prevention, and (when its experiment is enabled) Fast response.
Decision model settings are no longer duplicated in General settings.

A connection manager can choose a **shared OpenRouter API-key connection**,
optionally edit the model, enable model checks, and save. The default is
`openai/gpt-oss-safeguard-20b`. Use an OpenRouter API model ID without an extra
`openrouter/` prefix. Model suggestions are optional; a catalog outage does not
prevent manual entry. New companies and existing installations stay unconfigured
until explicitly saved. Clearing the selection does not delete the connection.
A missing/deleted selection can still be disabled or replaced.

The selected provider receives the complete secret-redacted tool result and a
fixed, versioned classification policy. API usage is paid and appears in Costs,
including company/project/agent/user attribution when applicable. Redaction
reduces credential exposure; operators should select a provider suitable for
their tool data. Scanned content, prompts, and model reasoning are not stored in
classifier accounting records.

At existing tool-result guards, a valid model verdict replaces the built-in
regex verdict. This allows benign source code or security-test examples that
resemble attacks. Unsafe verdicts retain `prompt_injection_blocked`. Turning off
model checks leaves built-in detection active. Missing authorization, budgets,
provider failures, invalid verdicts, or timeouts also use the original regex over
the complete original result. Local tool events/audit details record the selected
detector and bounded fallback reason. Successful model classification does not
provide a guarantee that all attacks will be detected.

If outbound redaction hides content that the existing tool return contract
would still deliver, model classification is unavailable for that result.
The guard records `input_redaction_mismatch` and scans the complete original
result with regex without dispatching or charging a model request. This prevents
instructions in secret-named fields of root strings or arrays from being
hidden behind a safe verdict, while preserving existing return values.

Each classification makes at most one provider request, with a 10-second deadline
that cancels the request. Client disconnects and existing active-run cancellation
signals also cancel classification; a stopped caller does not receive a regex
fallback result. Approved actions retain their own lifetime after the originating
run ends. The complete serialized request body, including policy, input, model,
and API options, must fit in 256 KiB; larger inputs use built-in detection without
truncating a prefix for the model. Output is capped at 4,096 tokens, including model reasoning. Caller
cancellation propagates after accounting settlement. Existing argument checks,
result return values, summary hashes, signatures, and ignored paths are unchanged.
A blocked tool result cannot undo a write already performed by the tool.

**Test model checks** uses two fixed samples (benign code and malicious
instructions) from saved settings. Both must receive correct model verdicts to
pass; fallback is a failed model test. Save edits before testing. The test is
charged and does not accept arbitrary content.

## Management API

All paths start with `/api/companies/:companyId/prompt-injection-prevention`.
Company access and board identity are required. Configuration, model listing,
and tests require connection-management permission. Agents cannot manage this
service. GET returns null settings and empty choices to a board user without that
permission. No API returns credentials.

| Method | Suffix | Operation |
| --- | --- | --- |
| GET | (none) | Settings/defaults and eligible shared connections |
| PUT | (none) | Strict `{ enabled, connectionId, grantId, model }` settings |
| GET | `/models?connectionId=...` | Authorized cached OpenRouter suggestions |
| POST | `/test` | Empty object; two fixed sample classifications |

Identified users retain membership and credential audience restrictions. Agents
retain installation restrictions. Company sponsorship applies only to an
already-admitted gateway operation without a responsible user; a denied person
is never retried as a system caller. Runtime credentials always come from the
connection vault, never process environment fallback.

## Accounting and recovery

`company_prompt_injection_prevention` retains selections after connection
removal. `prompt_injection_invocations` keeps archival attribution, policy/model,
verdict categories, bounded errors, token usage, provider request ID, and a link
to the cost event. It stores no scanned content. A provider request reserves
applicable budgets under the company accounting lock before dispatch. The lock
is released before network I/O.

Charges use `usageKind: prompt_injection`, biller `openrouter`, and idempotency
key `prompt-injection:<invocation-id>`. Run correlation stays on the invocation;
these service costs have no heartbeat run receipt. Known provider rejection
releases the hold. Uncertain billing stays unpriced and retains its reservation
until billing reconciliation. Agent deletion cannot discard unresolved classifier
holds. Recovery marks invocations running for more than 120 seconds interrupted
without rerunning the request. This change adds no first-party Telemetry.
