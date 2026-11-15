---
title: Self-hosted Deployment Notes
summary: Workarounds and diagnostics for common self-hosted deployment pitfalls
---

This page collects deployment findings reported from a self-hosted installation.
Some are workarounds for version-specific behavior, not universal requirements.
Check the linked issue and the behavior of your Paperclip image before relying
on a workaround.

## Pass model credentials to the server process

### Symptom

An agent configured with an API key or base URL through the UI fails its
environment check: required variables appear unset, the adapter falls back to
its default base URL, and the agent remains in `verifying`. In the reported
case, the adapter's verification path read the adapter config's `env` block
and the Paperclip server process environment, but did not receive UI-bound
values. See [#19887](https://github.com/paperclipai/paperclip/issues/19887).

### Workaround: use a server-side `env_file`

Add an environment file to the Paperclip server service in Compose:

```yaml
services:
  server:
    env_file:
      - /opt/paperclip/server.env
```

Put the provider variables in `/opt/paperclip/server.env`:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.example.com/v1
```

Restrict the file to the deployment identity that runs Compose (for example,
mode `600`), exclude it from backups, and recreate the server container after
changing it:

```sh
chmod 600 /opt/paperclip/server.env
docker compose up -d --force-recreate server
docker exec paperclip-server-1 sh -lc 'test -n "$OPENAI_API_KEY" && echo KEY_PRESENT; echo "BASE=$OPENAI_BASE_URL"'
```

The check prints only whether the key is present and the base URL. Container
environment values can be visible through `docker inspect`, so protect access
to the Docker host and the environment file. Prefer Paperclip's secret
references where the adapter path supports them. This workaround addresses
verification; runtime credential propagation is a separate path described in
[the Hermes gateway section](#run-agents-on-custom-endpoints-with-hermes-gateway).

The reporter noted in November 2026 that a fix for #19887 had landed on master
but was not yet in a released image. Treat that release status as a dated
report, not a guarantee about the image you are running.

## Public MCP needs a canonical public URL

The Assistant Connection (MCP) card may remain on “Couldn't load your connection
status” if `PAPERCLIP_PUBLIC_URL` is set to an intranet HTTP address. Public MCP
configuration requires a bare HTTPS origin (no path, query, or fragment); HTTP
is accepted for loopback development only. A rejected value can leave the management endpoint
unavailable, making the card's status error persistent. See
[#19924](https://github.com/paperclipai/paperclip/issues/19924) and
[#14933](https://github.com/paperclipai/paperclip/issues/14933).

Set `PAPERCLIP_PUBLIC_URL` to the HTTPS origin users and integrations use, for
example:

```dotenv
PAPERCLIP_PUBLIC_URL=https://paperclip.example.com
```

If you do not have an HTTPS origin, leave public MCP unavailable. Do not use an
intranet HTTP hostname as a substitute. Until the status surface distinguishes
this configuration failure, a stuck connection card on an HTTP deployment can
be a configuration symptom rather than a transient loading problem.

## Check why an idle agent's heartbeat is skipped

An agent with no assigned work may produce no timer-triggered runs when
`runtime_config.heartbeat.skipTimerWhenNoActionableWork` is `true`. The
new-agent UI has used this value as its default, while the backend's fallback
for missing values is `false`; saving Run Policy settings may preserve the
stored value rather than replace it. See [#19905](https://github.com/paperclipai/paperclip/issues/19905)
and [discussion #3401](https://github.com/paperclipai/paperclip/discussions/3401).

To diagnose the reported pattern, inspect `agent_wakeup_requests` for the
agent. Repeated `heartbeat.timer.no_actionable_work` requests alongside zero
heartbeat runs indicate that timer wakes are being skipped because no
actionable work was found. This setting is distinct from whether heartbeats are
enabled and from the timer interval.

## Diagnose container DNS failures after host reboot

On a systemd-resolved host, containers can inherit the host's stub resolver
address (`127.0.0.53`). That loopback address belongs to the host's network
namespace and may be unreachable from a container. After a hard reboot, this
can prevent containers from resolving Compose service names such as `db` and
cause the Paperclip server to restart repeatedly. The general failure pattern
is documented in [docker/for-linux #979](https://github.com/docker/for-linux/issues/979).

If containers cannot resolve names but the host can, check the resolver
configuration inside the affected container. Once the host resolver is healthy,
you can recreate the containers with Compose. Other options are to configure
DNS for the affected Compose services or set a Docker daemon default DNS
server.

The original report observed this once after a hard reboot and did not capture
the container's resolver file before recovery. The systemd-resolved stub is a
plausible cause, but was not forensically confirmed in that incident.

## Run agents on custom endpoints with the Hermes gateway

When an adapter verifies but its model credentials do not reach runtime calls,
Hermes can own provider authentication. Run Hermes Agent as an API server and
configure its provider key and custom endpoint in Hermes. In the Paperclip
agent, select `hermes_gateway` and set:

```json
{
  "apiBaseUrl": "http://127.0.0.1:8642",
  "apiKey": "<HERMES_API_SERVER_KEY>"
}
```

Use the Hermes `API_SERVER_KEY` here, stored through Paperclip's secret
reference field. It is the gateway's key, not the model provider key. The model
key stays in Hermes configuration, so Paperclip does not need the provider
credential. Use a base URL without `/v1`: the adapter adds `/v1/runs` and the
related run paths. For a gateway on another host, use a URL reachable from the
Paperclip server and protect it with HTTPS or a private network; loopback HTTP
is appropriate only when the gateway is reachable on that same host/network
namespace.

The following version and configuration details come from the reporter's
installation, validated on 2026-11-10; verify them against your Hermes release:

- Hermes Agent `0.19.0` advertised run submission support but returned 404 for
  `POST /v1/runs`. The reporter verified create, poll, events, and stop against
  `0.22.x`. Use Hermes `0.22.x` or later, or the current `stable` image, and
  confirm its API supports the run endpoints Paperclip calls.
- Enter the gateway key accurately. A wrong value can cause 401 responses on
  adapter calls without clearly identifying which side rejected the request.
- Set the Hermes run-mode name in its `config.yaml`. In the reported setup,
  setting only the environment variable did not select a run mode.

The gateway adapter creates runs with `POST /v1/runs`, reads run status with
`GET /v1/runs/{id}`, streams events from `GET /v1/runs/{id}/events`, and stops
runs with `POST /v1/runs/{id}/stop`. See the [Hermes adapter overview](/adapters/overview),
[#8924](https://github.com/paperclipai/paperclip/issues/8924), and
[`HERMES_GATEWAY_ONBOARDING.md`](../../doc/HERMES_GATEWAY_ONBOARDING.md) for
related setup and version-pairing context.
