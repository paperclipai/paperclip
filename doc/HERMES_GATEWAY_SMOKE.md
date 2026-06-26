# Hermes Gateway Smoke

This smoke validates the built-in `hermes_gateway` adapter against a fresh
Hermes gateway. Keep real Hermes execution manual/local: the CI-safe checks only
lint shell syntax and focused helper behavior.

## CI-safe validation

Run these from the repo root:

```sh
bash -n scripts/smoke/hermes-gateway-join.sh scripts/smoke/hermes-gateway-e2e.sh
pnpm test:hermes-gateway-smoke
```

`pnpm test:hermes-gateway-smoke` does not start Docker, Hermes, or Paperclip. It
checks script help output, shell syntax, redaction helpers, URL slash handling,
and the non-loopback HTTP guard.

## Secrets and cleanup

- Set the Hermes gateway key with `HERMES_GATEWAY_API_KEY` or `API_SERVER_KEY`.
  The scripts print only `sha256=<prefix>` and length for secret identifiers.
- Set at least one Hermes inference provider key on the host before running the
  Docker E2E smoke. The script passes through set values for
  `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
  `GOOGLE_API_KEY`, and `MISTRAL_API_KEY`, and logs only the provider env var
  names.
- To pin the fresh Hermes container to a known non-secret model config, set
  `HERMES_SMOKE_MODEL_PROVIDER`, `HERMES_SMOKE_MODEL_DEFAULT`, and optionally
  `HERMES_SMOKE_MODEL_BASE_URL`. For example, OpenRouter GLM:

  ```sh
  HERMES_SMOKE_MODEL_PROVIDER=openrouter \
  HERMES_SMOKE_MODEL_DEFAULT=z-ai/glm-5.2 \
  HERMES_SMOKE_MODEL_BASE_URL=https://openrouter.ai/api/v1 \
  pnpm smoke:hermes-gateway-e2e
  ```

  This writes only `model`, `providers: {}`, and
  `command_allowlist: [execute_code]` into the temporary Hermes home. Provider
  keys still come from environment variables and are redacted from diagnostics.
- The E2E helper always seeds `command_allowlist: [execute_code]` in the fresh
  Hermes config so non-interactive gateway/API runs do not wait for a manual
  execute-code approval prompt. Do not copy a host `~/.hermes` directory into
  the container to solve approval or provider setup.
- Board/operator auth is required through `PAPERCLIP_AUTH_HEADER`,
  `PAPERCLIP_COOKIE`, or a board-capable `PAPERCLIP_API_KEY`.
- Diagnostic files are redacted before they are written, except the join output
  file intentionally contains the claimed Paperclip agent key and is written
  `chmod 600`.
- Successful runs remove the smoke issue, smoke agent, join request, Docker
  container, and per-run local state.
- Set `HERMES_SMOKE_KEEP=1` to preserve diagnostics, state, and the container.
  Failed runs automatically preserve them and print the retained paths.

## URL model

The smoke has three URLs because different processes need different routes:

- `PAPERCLIP_API_URL`: Paperclip URL used by the operator shell.
- `PAPERCLIP_API_URL_FOR_HERMES`: Paperclip URL used from inside the Hermes
  container or remote Hermes host.
- `HERMES_GATEWAY_API_BASE_URL`: Hermes gateway URL stored on the Paperclip
  adapter, reachable by the Paperclip server.
- `HERMES_GATEWAY_PROBE_URL`: Hermes gateway URL used by the operator shell for
  direct `/health`, `/v1/capabilities`, `/v1/runs`, and SSE checks.

Loopback HTTP gateway URLs are allowed. Non-loopback HTTP gateway URLs require
`HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1` and should only be used on local/private
development networks. Use HTTPS for real remote gateways.

## Docker Desktop or Linux host Paperclip

Use this when Paperclip runs on the host at `127.0.0.1:3100` and Docker can
reach the host through `host.docker.internal`.

```sh
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
pnpm smoke:hermes-gateway-e2e
```

Linux uses `--add-host=host.docker.internal:host-gateway` by default through
`HERMES_DOCKER_ADD_HOST=1`. If your Docker setup already provides
`host.docker.internal`, the same command works.

## Same Docker network as Paperclip

Use this when Paperclip is a container on a Docker network and the Hermes smoke
container should be reachable by container DNS. The operator shell still probes
the host-published loopback port.

```sh
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
HERMES_CONTAINER_NAME=paperclip-hermes-gateway-smoke \
HERMES_SMOKE_NETWORK=paperclip_default \
HERMES_DOCKER_ADD_HOST=0 \
HERMES_GATEWAY_API_BASE_URL=http://paperclip-hermes-gateway-smoke:8642 \
HERMES_GATEWAY_PROBE_URL=http://127.0.0.1:8642 \
PAPERCLIP_API_URL_FOR_HERMES=http://paperclip:3100 \
HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1 \
pnpm smoke:hermes-gateway-e2e
```

Change `paperclip_default` and `paperclip` to your Compose network and service
name. The unsafe HTTP flag is required because Paperclip stores a non-loopback
`http://` gateway URL for private Docker DNS.

## LAN or private-network Paperclip

Use this when Paperclip is exposed on a private IP or tailnet address and the
Hermes container can reach that address.

```sh
PAPERCLIP_API_URL=http://192.168.1.20:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
PAPERCLIP_API_URL_FOR_HERMES=http://192.168.1.20:3100 \
HERMES_GATEWAY_API_BASE_URL=http://192.168.1.20:8642 \
HERMES_GATEWAY_PROBE_URL=http://127.0.0.1:8642 \
HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1 \
pnpm smoke:hermes-gateway-e2e
```

Only use this on a trusted private network. For anything beyond local/private
development, put the Hermes gateway behind TLS and use the reverse-proxy mode.

## Reverse proxy / TLS

Use this when Paperclip should talk to Hermes through a TLS hostname. The smoke
container still publishes a local port, and your reverse proxy forwards the TLS
hostname to that port.

```sh
PAPERCLIP_API_URL=https://paperclip.example.com \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
PAPERCLIP_API_URL_FOR_HERMES=https://paperclip.example.com \
HERMES_GATEWAY_API_BASE_URL=https://hermes-gateway.example.com \
HERMES_GATEWAY_PROBE_URL=http://127.0.0.1:8642 \
pnpm smoke:hermes-gateway-e2e
```

No unsafe HTTP escape hatch is needed because the adapter URL is HTTPS.

## Join-only validation

If a Hermes gateway is already running, use the join helper without building or
starting a Docker container:

```sh
API_SERVER_ENABLED=true API_SERVER_KEY='<gateway-key>' hermes gateway run --replace --accept-hooks

PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
HERMES_GATEWAY_API_BASE_URL=http://127.0.0.1:8642 \
HERMES_GATEWAY_API_KEY='<gateway-key>' \
pnpm smoke:hermes-gateway-join
```

For non-loopback private HTTP join-only runs, set
`HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1`. For Docker DNS or reverse-proxy setups,
set `HERMES_GATEWAY_PROBE_URL` to the URL reachable from the operator shell and
`HERMES_GATEWAY_API_BASE_URL` to the URL Paperclip should store on the adapter.
