# Hermes Gateway Adapter

External Paperclip adapter for Hermes Agent's authenticated HTTP/SSE API server.

Install it through Paperclip's Adapter manager as a local path or npm package. The
adapter type is `hermes_gateway`; it is intentionally not registered as a built-in
core adapter.

Required config:

- `apiBaseUrl`: Hermes API server base URL, for example `http://127.0.0.1:8642`
- `apiKey`: Hermes `API_SERVER_KEY`

The adapter creates Hermes runs with `POST /v1/runs`, streams
`/v1/runs/{run_id}/events`, polls `/v1/runs/{run_id}` as a fallback, and calls
`/v1/runs/{run_id}/stop` on timeout.
