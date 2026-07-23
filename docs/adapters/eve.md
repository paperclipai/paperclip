---
title: Eve
summary: Eve gateway and local adapter setup and configuration
---

The `eve_gateway` and `eve_local` adapters connect Paperclip agents to agents built with [Eve](https://eve.dev) ([github.com/vercel/eve](https://github.com/vercel/eve)), Vercel's filesystem-first framework for durable backend AI agents. Eve is currently in **public beta**, and its HTTP contract may still evolve.

Every Eve agent — whether running locally via `eve dev` or deployed on Vercel — exposes the same HTTP contract: `POST /eve/v1/session` starts a conversation, an NDJSON event stream reports progress, a `continuationToken` enables follow-up messages, and `GET /eve/v1/info` returns an inspection snapshot. Both adapters speak this contract directly over HTTP; the `eve` npm package is not required on the Paperclip host for the gateway adapter.

## Gateway vs local

- **`eve_gateway`** — the Eve agent is already running somewhere reachable over HTTP (deployed on Vercel, or `eve dev` on another host/port). Paperclip calls it per heartbeat and never manages the process.
- **`eve_local`** — Paperclip owns the lifecycle. You point the adapter at a local Eve project directory (created with `npx eve init`); for each run the adapter boots `eve dev --no-ui` on a free local port, drives one conversational turn over localhost HTTP, and shuts the server down before the run returns. The Eve CLI must be installed (`npm i -g eve`) or the `command` field must point at a runnable binary.

Use `eve_gateway` whenever the agent is durable and always-on; use `eve_local` for development and self-contained setups where nothing should stay running between heartbeats. For CLI coding agents, use `claude_local`/`codex_local` instead — Eve adapters are for agents built on the Eve framework.

## Prerequisites

- **Gateway**: a running Eve agent reachable at a base URL. Deployed Vercel targets require auth headers (for example a Vercel OIDC bearer) — supply them via the `headers` field. A local `eve dev` accepts unauthenticated local requests.
- **Local**: Node 20+, the Eve CLI available as `eve` (or a custom `command`), and an Eve project directory. The Eve agent's own model credential (for example `AI_GATEWAY_API_KEY` via `eve link`, or a provider key) lives in the project's `.env`/`.env.local` or can be injected through the `env` field.

## Configuration Fields — `eve_gateway`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseUrl` | string | Yes | Root URL of the running Eve agent, e.g. `https://my-agent.vercel.app` or `http://127.0.0.1:3000` |
| `headers` | object | No | Static request headers, e.g. `{"Authorization": "Bearer <token>"}`. Values support the same plain/secret-ref shapes as env maps. Header values are never written to logs — only header names appear in run metadata. |
| `model` | string | No | Informational only; Eve agents pin their own model. Reported on run results. |
| `timeoutMs` | number | No | Per-HTTP-request timeout in milliseconds (default 30000) |
| `runTimeoutMs` | number | No | Whole-run cap in milliseconds (default 30 minutes); on expiry the stream is aborted and the run returns `timedOut` |
| `promptTemplate` | string | No | Heartbeat prompt template |
| `bootstrapPromptTemplate` | string | No | Rendered only on the first (fresh-session) wake |
| `instructionsFilePath` | string | No | Markdown instructions file prepended to the prompt |

## Configuration Fields — `eve_local`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectDir` | string | Yes | Absolute path to the Eve project directory (created with `npx eve init`) |
| `command` | string | No | Command used to launch the Eve dev server (default `eve`) |
| `commandArgs` | string[] | No | Full argument override. Default: `dev --no-ui --port <port> --host 127.0.0.1`. The chosen port is always injected as `PORT` in the child environment. |
| `port` | number | No | Fixed local port. Leave unset to pick a free ephemeral port per run. |
| `env` | object | No | Environment variables injected into the Eve server process (supports plain values and secret refs) |
| `readyTimeoutMs` | number | No | How long to wait for `/eve/v1/info` to answer after spawn (default 90000 — the first boot compiles the project) |
| `timeoutMs` / `runTimeoutMs` / `promptTemplate` / `bootstrapPromptTemplate` / `instructionsFilePath` | — | No | Same semantics as the gateway fields above |

## Session Semantics

Paperclip persists the Eve session identity (`eveSessionId`, `continuationToken`, and a stream `eventIndex`) between heartbeats:

- **First wake** starts a fresh Eve session (`POST /eve/v1/session`) and records the session id and continuation token.
- **Subsequent wakes** send a follow-up (`POST /eve/v1/session/<id>` with the stored `continuationToken`), so the Eve agent keeps its conversation context. Any new continuation token returned in the response replaces the stored one.
- **Stream resume**: the event stream is replayable; resumed runs request `?startIndex=<eventIndex>` so already-processed events are not double-counted.
- **Stale continuation fallback**: Eve rejects stale continuation tokens (a session has one active continuation at a time). When a follow-up is rejected as stale — or the session is unknown — the adapter logs the condition and transparently starts a fresh session in the same run. The run still succeeds; only the conversation context is reset.
- **Human input parking**: when the stream reports `input.requested`, the Eve agent is waiting for a human (HITL approval or a question). The adapter treats this as a successful-but-parked run — exit code 0 with a summary noting the pending question — and the next heartbeat's follow-up message answers it.
- **Failures**: `turn.failed` / `session.failed` events end the run with an error message taken from the event payload; the session identity is preserved for the next wake.

For `eve_local`, the dev server is stopped after every run. Whether Eve session durability spans a local dev-server restart is not guaranteed; if it does not, the stale-continuation fallback simply starts a fresh session on the next wake.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config.

`eve_gateway` checks:

- `baseUrl` is present and is an http(s) URL
- The agent answers `GET /eve/v1/info` (reports the agent's name/model on success, the fetch error on failure)

`eve_local` checks:

- `projectDir` is set and exists (warns when the directory has neither `agent/instructions.md` nor `agent.ts`)
- The `command` is runnable (`<command> --version` with a 10s timeout; a missing binary produces an install hint)
- Note: the environment test does **not** boot the agent — the first real run compiles the project and may take a minute

## Troubleshooting

- **"Eve agent reachable" fails / connection refused (gateway)** — confirm the agent is running and the `baseUrl` is correct, including scheme and port. For deployed Vercel targets, missing auth headers commonly surface as 401/403 in the check detail; add an `Authorization` header via the `headers` field.
- **Stale continuation messages in run logs** — expected after the Eve session ends or another client consumed the continuation. The adapter already fell back to a fresh session; if it happens every wake, something is resetting the Eve session between heartbeats (for `eve_local`, see the restart note above).
- **`eve_local` run fails with a readiness timeout** — the first boot compiles the project and can exceed a strict `readyTimeoutMs`; raise it (default 90000ms). Also check the `[eve]`-prefixed server log lines captured on the run's stderr for compile errors or a missing model credential.
- **`Eve command "eve" was not found`** — install the CLI (`npm i -g eve`) or set the `command` field to a runnable binary.

## Verified against

This adapter is validated by unit and fixture-based integration tests against Eve's documented HTTP contract (Eve docs as of 2026-07-03): the gateway flow is tested against a mocked `fetch`, and the local lifecycle (spawn, readiness, teardown) against a fake Eve NDJSON server run as a real child process. It has **not yet** been verified against a live Eve deployment; Eve is in public beta and all HTTP specifics are isolated in the package's shared client so contract adjustments stay small.
