# Agent Zero bridge for Paperclip

This example bundle connects Paperclip to an Agent Zero worker using the built-in `agent_zero_bridge` adapter.

## What it does

- exposes `POST /invoke` for Paperclip's fire-and-forget HTTP handoff
- checks out the issue in Paperclip before handing work to Agent Zero
- loads compact task context from `GET /api/issues/{id}/heartbeat-context`
- posts status updates and comments back to Paperclip with retry + verification
- exposes `GET /health` for adapter environment checks
- prevents duplicate concurrent processing with per-issue locks

## Expected topology

- Paperclip app on `http://localhost:3100`
- this bridge on `http://localhost:8090`
- Agent Zero endpoint on `http://localhost:5090/api/api_message`

## Quick start

1. Create a Python virtualenv.
2. Install the requirements from `requirements.txt`.
3. Copy `.env.example` to your preferred env file or export the variables directly.
4. Run `python a0_bridge.py`.
5. In Paperclip, create or edit an agent that uses the `Agent Zero Bridge` adapter and point it at `http://localhost:8090/invoke`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `A0_API_KEY` | empty | Optional Agent Zero API key sent as `X-API-KEY` |
| `A0_URL` | `http://localhost:5090/api/api_message` | Agent Zero message endpoint |
| `A0_TIMEOUT` | `600` | Agent Zero read timeout in seconds |
| `PAPERCLIP_API` | `http://localhost:3100/api` | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | empty | Optional Paperclip bearer token for callbacks |
| `BRIDGE_PORT` | `8090` | Flask listen port |
| `PC_RETRY_ATTEMPTS` | `3` | Retry attempts for Paperclip updates |
| `PC_RETRY_BASE_DELAY` | `2` | Exponential retry base delay in seconds |

## Paperclip adapter config

Use the built-in `agent_zero_bridge` adapter with:

- `url`: `http://localhost:8090/invoke`
- `healthUrl`: `http://localhost:8090/health`
- `timeoutMs`: `15000`

## Notes

- The bridge is intentionally asynchronous because the Paperclip HTTP handoff does not use the response body.
- Paperclip issue updates can occasionally return an error even when the mutation succeeded; this bridge verifies the post-update issue state before retrying.
- Keep the bridge on a trusted network segment unless you add your own auth in front of `/invoke`.
