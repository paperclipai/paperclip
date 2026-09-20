# TypeSafe connection

TypeSafe's Jev model answers typed questions about a `state`: yes/no (`noul`),
multiple choice (`choice`) and rubric scoring (`score`). Each answer carries a
probability or a confidence. Jev does not write text, call tools or edit files,
so it is a tool that agents call, not an agent adapter.

Provider facts come from `https://docs.typesafe.ai` (`api.md`, `models.md`),
read on 2026-09-20.

## Connection shape

| Axis | Value |
| --- | --- |
| Transport | `rest_api` |
| Authentication | `api_key`, sent as `Authorization: Bearer <key>` |
| OAuth client ownership | Not applicable |
| Credential source | `paperclip_vault` |
| Grant identity | `organization` |
| Risk tier | S2 |

Setup asks for one secret, the API key. The model is an advanced field that
defaults to `jev-latest`. A pinned version such as `jev-1.13.0` is valid.

TypeSafe publishes no hosted MCP server, so the connected MCP gateway cannot
reach it. The connection is a connector contribution instead (see
"Connector-provided skills and tools" in
[CONNECTOR-PLAYBOOK.md](./CONNECTOR-PLAYBOOK.md)): a bundled skill and one
native tool, `typesafe_ask`. The catalog for this connection is always empty.
The connection is identified by `config.sourceTemplateKey === "typesafe"`.

## Health

Health and catalog refresh resolve the vaulted key and call `GET /v1/models`.
This proves the key. It does not prove the model: the list holds aliases only,
and TypeSafe accepts versioned IDs that the list omits. A wrong model name
surfaces as 422 `typesafe_invalid_request` on the first question. The provider
answers 400 for an unknown model, which its error table does not list.

| Provider result | Health code | HTTP |
| --- | --- | --- |
| 401 or 403 | `typesafe_api_key_rejected` | 422 |
| Any other failure | `typesafe_request_failed` | 502 |

A failed first health check rolls the draft connection and its secret back.

## Who can use it

An agent can ask TypeSafe when all of these are true. Every call checks them
again, so removing access stops a run that is already in progress.

- The connection belongs to the agent's company.
- The connection is `active` and enabled, and its health is "ok". This is the
  same health gate the tool gateway applies to its catalog.
- A `tool_connection_installs` row targets the company or that agent.
- Tool governance allows the call. `typesafe_ask` asks
  `toolAccessPolicyService` for a decision as tool `typesafe.ask`, risk level
  `read`, before it resolves the key. Block policies, ask-first policies,
  approval rules and rate limits all apply, and each decision is audited. The
  audit row holds the model and the question count, never the state or the
  questions.
- On the HTTP route, the `X-Paperclip-Run-Id` header names a run that is
  `running` and belongs to the calling agent. An agent key alone is refused.
  The native runner supplies its own bound run.

The setup finish step writes those installs from the access choice ("all
agents" or selected agents). The generic API-key path creates none by itself.
The same step adds one `connection` entry to the connection's access profile,
because this connection has no catalog actions to include. Without that entry
governance denies every call by default.
`PUT /api/tool-connections/{connectionId}/installs` changes them later.

## Asking

| Surface | Form |
| --- | --- |
| Native runner | tool `typesafe_ask` |
| CLI | `paperclipai typesafe ask --file <request.json>` |
| HTTP | `POST /api/companies/{companyId}/typesafe/ask` (agent key, `X-Paperclip-Run-Id`) |

The request is `state`, `questions`, optional `model` and optional
`connectionId`. `connectionId` is required only when more than one TypeSafe
connection is assigned. Paperclip validates the request before it leaves the
instance: question types, 1 to 255 choice options, 2 to 10 score levels. The
full contract is in `skills/typesafe/SKILL.md`.

| Provider status | Response | Code |
| --- | --- | --- |
| 400 or 422 | 422 | `typesafe_invalid_request` |
| 429 | 429 | `typesafe_rate_limited`, `retryable: true` |
| 529 | 503 | `typesafe_overloaded`, `retryable: true` |
| 401 or 403 | 502 | `typesafe_api_key_rejected` |
| A body Paperclip cannot read | 502 | `typesafe_invalid_response` |
| Timeout or network failure | 503 | `typesafe_unreachable`, `retryable: true` |
| Any other failure | 502 | `typesafe_request_failed` |

One table in `server/src/services/typesafe-api.ts` holds these mappings. A
rejected key is 502 here, not 422, because the agent's request was valid; the
connection needs attention. Paperclip does not retry and does not substitute another model. The caller
decides whether to retry.

## Data handling

- The `state` and the questions are sent to TypeSafe. The setup screen warns
  the operator about this.
- The API key stays in the vault. It is never placed in connection config, the
  skill, tool results, errors or logs. Provider error bodies are discarded
  because they can echo the submitted state.
- Each successful call writes one `typesafe.ask` activity row with the requested
  model, the question count and token usage. It never holds the state, the
  instructions, the criteria or the answers.
- The activity redactor treats dotted strings as possible tokens, so a pinned
  model such as `jev-1.13.0` shows as redacted in that row. Aliases show as
  written.

## Smoke checklist

1. Connect TypeSafe with a valid key. Health is "ok". The catalog is empty.
2. Finish setup with all agents. One company install exists.
3. Ask one `noul` question with an agent key. The answer returns with usage.
4. Confirm the `typesafe.ask` activity row and that it holds no task content.
5. Remove the install. The same call returns 403.
6. Connect with an invalid key. Setup fails with 422 and leaves no connection.

## Live proof

Run on 2026-09-20 against `https://api.typesafe.ai/v1` with an operator key,
through the real service code and an embedded database. Only the key was
external. No key, state or answer text is recorded here.

| Step | Result |
| --- | --- |
| `GET /v1/models` | 200. Body is `{ models: [{ name, description, release_date }] }`. It lists `jev-latest` and `jev-preview` only. |
| Connect with an invalid key | 422 `typesafe_api_key_rejected`. No connection and no secret remain. |
| Connect with a valid key | Health "ok", "TypeSafe API key is connected.", empty catalog. |
| Finish with all agents, then ask 3 questions (`noul`, `choice`, `score`) | 200. Provider model `jev-1.13.0`. Usage 390 input and 73 output tokens. All three answer shapes parse. |
| Ask with the pinned model `jev-1.13.0` | 200. The list omits this ID and the provider accepts it. |
| Ask with an unknown model | Provider 400 `api_usage_error`. Paperclip returns 422 `typesafe_invalid_request`. |
| Activity rows | Model, question count and token usage only. The pinned model shows as redacted, as described above. |
| Remove the install, then ask | 403. |

Not covered by this run: the setup screens in the browser, and the 429 and 529
paths, which the provider did not produce.

One difference from the provider documentation: the API accepts a `score` with
one level. Paperclip keeps the documented minimum of two.
