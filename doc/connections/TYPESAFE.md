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
surfaces as 422 on the first question.

| Provider result | Health code | HTTP |
| --- | --- | --- |
| 401 or 403 | `typesafe_api_key_rejected` | 422 |
| Any other failure | `typesafe_request_failed` | 502 |

A failed first health check rolls the draft connection and its secret back.

## Who can use it

An agent can ask TypeSafe when all of these are true. Every call checks them
again, so removing access stops a run that is already in progress.

- The connection belongs to the agent's company.
- The connection is `active` and enabled.
- A `tool_connection_installs` row targets the company or that agent.

The setup finish step writes those installs from the access choice ("all
agents" or selected agents). The generic API-key path creates none by itself.
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
| 422 | 422 | `typesafe_invalid_request` |
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

Pending. Deterministic fixtures cover every path above; the provider contract
still needs one run against the real API with an operator-supplied key.
