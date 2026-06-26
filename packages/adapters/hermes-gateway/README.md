# Hermes Gateway Adapter

Built-in Paperclip adapter for Hermes Agent's authenticated HTTP/SSE API server.

The adapter type is `hermes_gateway` and ships with Paperclip core. Operators can
still install an external adapter package with the same type through Adapter
manager when they intentionally want to override the built-in.

Required config:

- `apiBaseUrl`: Hermes API server base URL, for example `http://127.0.0.1:8642`
- `apiKey`: Hermes `API_SERVER_KEY`

The adapter creates Hermes runs with `POST /v1/runs`, streams
`/v1/runs/{run_id}/events`, polls `/v1/runs/{run_id}` as a fallback, and calls
`/v1/runs/{run_id}/stop` on timeout.
