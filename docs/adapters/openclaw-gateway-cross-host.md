---
title: OpenClaw Gateway — Cross-Host Setup
summary: Wire a remote OpenClaw worker into Paperclip with bidirectional writeback (Paperclip → OpenClaw via tunnel; OpenClaw → Paperclip via API key)
---

This guide walks through hiring a remote OpenClaw gateway (running on a separate host — VM, EC2, home lab, etc.) into a Paperclip company so that the two ends can talk **both ways**:

- **Paperclip → OpenClaw**: Paperclip wakes the agent and streams agent requests over WebSocket.
- **OpenClaw → Paperclip**: the OpenClaw-side runtime posts comments, updates issue status, and creates child issues by hitting Paperclip's REST API directly.

Without the second leg, the agent can run a heartbeat but it cannot leave any durable trace in Paperclip. It will look stuck.

## Architecture

```text
┌─────────────────────┐  wss://gateway/ws    ┌──────────────────────┐
│  Paperclip server   │  ──────────────────▶ │  OpenClaw gateway    │
│  (your laptop, EC2, │  agent + wake reqs   │  (remote host)       │
│  CloudFront, ...)   │                      │  port 18789 by default│
│                     │  ◀────────────────── │                      │
│                     │   stream events       │                      │
└──────────────────────┘                       └──────────┬───────────┘
        ▲                                                 │
        │  POST /comments  PATCH /issues  POST /issues    │  spawns
        │  (Authorization: Bearer pcp_…                   │
        │   X-Paperclip-Run-Id: <runId>)                  ▼
        │                                          Local Claude / agent
        └──── HTTPS, reverse SSH, or named tunnel ── runtime
                                                   reads
                                              `~/.openclaw/workspace/
                                              paperclip-claimed-api-key.json`
```

Two pieces of plumbing make this work:

1. **A path from Paperclip to OpenClaw's WebSocket** (the existing `openclaw_gateway` adapter handles this).
2. **A path from OpenClaw's host back to Paperclip's REST API**, plus a small JSON file telling the agent its credentials.

This guide covers the second piece, plus the realistic networking patterns for both directions.

## Prerequisites

- A running OpenClaw gateway (`openclaw gateway --port 18789 --auth token`). Capture its `OPENCLAW_GATEWAY_TOKEN`.
- A running Paperclip instance with the `openclaw_gateway` adapter registered.
- Network connectivity in **both** directions (the next section covers your options).

## Step 1 — Expose OpenClaw to Paperclip

OpenClaw bind defaults to `loopback`. Pick one of the following based on where Paperclip lives.

### Option A — Same machine
Nothing to do. Paperclip uses `ws://127.0.0.1:18789/ws`.

### Option B — Paperclip and OpenClaw on different hosts you control
Use SSH local port forwarding from the Paperclip host to the OpenClaw host:

```sh
ssh -o ExitOnForwardFailure=yes \
    -L 18789:127.0.0.1:18789 \
    -N -f your-openclaw-host
```

Now Paperclip uses `ws://127.0.0.1:18789/ws` and SSH carries the bytes.

For multiple OpenClaw workers on different hosts, forward each to a distinct local port:

```sh
ssh -L 18789:127.0.0.1:18789 -N -f host-a    # worker-1
ssh -L 18790:127.0.0.1:18789 -N -f host-b    # worker-2
ssh -L 18791:127.0.0.1:18789 -N -f host-c    # worker-3
```

### Option C — Paperclip is hosted (e.g. behind CloudFront) and cannot SSH-tunnel into your OpenClaw host
Use a tunneling service to publish OpenClaw's port over TLS:

```sh
# Cloudflare Tunnel (quick, ephemeral URL — no account needed)
cloudflared tunnel --url http://localhost:18789

# or Cloudflare named tunnel for a stable URL (account + DNS required)
cloudflared tunnel run my-openclaw-tunnel
```

Paperclip then connects with `wss://<tunnel-host>/ws`. The token-based auth on OpenClaw means the tunnel does not need additional zero-trust policy for a quick start, but Cloudflare Access in front of a named tunnel is recommended for production.

Avoid binding OpenClaw to `0.0.0.0` directly without a fronting proxy — its token auth is fine for trusted networks but the gateway has not been hardened for the open internet.

## Step 2 — Hire the agent in Paperclip

Once Paperclip can reach the gateway URL, hire the agent normally:

```jsonc
{
  "name": "remote-worker-1",
  "role": "general",
  "title": "Remote OpenClaw worker",
  "adapterType": "openclaw_gateway",
  "adapterConfig": {
    "url": "wss://your-tunnel-or-tunneled-localhost/ws",
    "authToken": "<your OPENCLAW_GATEWAY_TOKEN>",
    "sessionKeyStrategy": "issue",
    "autoPairOnFirstConnect": true,
    "timeoutSec": 0,
    "waitTimeoutMs": 600000
  },
  "instructionsBundle": {
    "entryFile": "AGENTS.md",
    "files": { "AGENTS.md": "You are a remote worker. ..." }
  },
  "budgetMonthlyCents": 0
}
```

Run `Test Environment` from the UI (or `POST /api/companies/:id/adapters/openclaw_gateway/test-environment`) before assigning real work. A healthy result is `status: "pass"` with `Gateway connect probe succeeded.`

## Step 3 — Issue an agent API key for writeback

Paperclip has two distinct credentials at play:

- The **gateway token** (`OPENCLAW_GATEWAY_TOKEN`) authenticates Paperclip → OpenClaw WebSocket. Already used in Step 2.
- An **agent API key** authenticates OpenClaw → Paperclip REST. This is what we set up next.

From a board session, create a key:

```sh
curl -X POST "$PAPERCLIP_URL/api/agents/$AGENT_ID/keys" \
  -H "Cookie: <board session cookie>" \
  -H "Content-Type: application/json" \
  -d '{"name":"remote-worker-1-on-host-A"}'
```

The response contains the plaintext `token` field **once** — store it immediately:

```json
{
  "id": "9851522e-...",
  "name": "remote-worker-1-on-host-A",
  "token": "pcp_14f5cee849ac7765473fcb006807d1bd947d548ffe595c26",
  "createdAt": "2026-05-19T03:09:12.599Z"
}
```

Subsequent `GET /api/agents/:id/keys` calls only return metadata; the plaintext is gone after creation.

## Step 4 — Stage the key file on the OpenClaw host

OpenClaw's local runtime looks for Paperclip credentials at:

```text
~/.openclaw/workspace/paperclip-claimed-api-key.json
```

Create that file on the OpenClaw host with the response from Step 3:

```sh
mkdir -p ~/.openclaw/workspace
cat > ~/.openclaw/workspace/paperclip-claimed-api-key.json <<EOF
{
  "apiKey": "pcp_14f5cee849ac7765473fcb006807d1bd947d548ffe595c26",
  "agentId": "165f462b-7fe7-4b56-abb5-f30b5164cfde",
  "companyId": "743e6dcd-a0aa-4062-a56d-40b35b8947cd",
  "baseUrl": "http://localhost:3100"
}
EOF
chmod 600 ~/.openclaw/workspace/paperclip-claimed-api-key.json
```

`baseUrl` is what the agent runtime will hit. If Paperclip is reachable from the OpenClaw host directly (same machine, same VPC, public URL), use that. If it is reachable only via a reverse SSH tunnel from the OpenClaw host back to the Paperclip machine, see Step 5.

## Step 5 — (If needed) Reverse path from OpenClaw to Paperclip

The simplest cross-host pattern when Paperclip is on a developer laptop and OpenClaw is on a remote VM:

```sh
# From your laptop (which has SSH access to the VM)
ssh -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=60 \
    -R 3100:127.0.0.1:3100 \
    -N -f your-openclaw-host
```

This makes `http://localhost:3100` on the OpenClaw host reach Paperclip on the laptop. With the key file's `baseUrl` set to `http://localhost:3100`, the agent can now POST writeback calls.

Verify from the OpenClaw host:

```sh
KEY=$(jq -r .apiKey ~/.openclaw/workspace/paperclip-claimed-api-key.json)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $KEY" \
  http://localhost:3100/api/agents/me
# expect: 200
```

For long-lived setups, run the reverse tunnel under autossh or as a systemd service so it survives network blips and reboots.

## Step 6 — The two headers that matter on every writeback

Paperclip's mutating endpoints require **both**:

- `Authorization: Bearer <agent api key>`
- `X-Paperclip-Run-Id: <run id of the current heartbeat>`

The `X-Paperclip-Run-Id` is essential. Without it, mutating calls return `401 Agent run id required`. The current run id is delivered to the agent runtime in the wake payload Paperclip sends over the WebSocket — the agent should pick it up from there and pass it through on every API call.

A correctly framed comment post:

```sh
curl -X POST "$BASE/api/issues/$ISSUE_ID/comments" \
  -H "Authorization: Bearer $KEY" \
  -H "X-Paperclip-Run-Id: $RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{"body":"Hello from a remote OpenClaw runtime."}'
```

A successful response includes `authorAgentId` (your agent), `authorType: "agent"`, and `createdByRunId` matching the header.

## Smoke test

Once Steps 1–6 are wired, assign a trivial issue to the remote agent and observe both legs:

1. `POST /api/agents/$AGENT_ID/wakeup` from the board side. The agent transitions to `running`.
2. The OpenClaw runtime receives the wake, executes its skills, and posts a comment back over the writeback path.
3. Paperclip's UI shows a comment authored by the remote agent, with `createdByRunId` correlating to the heartbeat run.

If the agent runs but no comment appears, the WebSocket leg works and the writeback leg does not. Inspect:

- `paperclip-claimed-api-key.json` exists on the OpenClaw host with the correct `baseUrl`.
- The reverse path resolves (`curl http://$baseUrl/api/agents/me` from the OpenClaw host returns 200).
- The agent runtime is including `X-Paperclip-Run-Id` on every mutating call.
- The agent's keys list (`GET /api/agents/:id/keys`) shows the key as not revoked.

## Limitations and caveats

- **Quick Cloudflare tunnels are ephemeral.** If `cloudflared` restarts, the URL changes and existing agents pointing at the old URL stop working until you update `adapterConfig.url`. Use named tunnels for production.
- **The reverse SSH tunnel is fragile** if you do not run it under autossh/systemd. Plan for the laptop sleeping or the VPN dropping.
- **The agent API key is plaintext on disk.** Keep `paperclip-claimed-api-key.json` mode 600 and avoid putting it on shared hosts. Rotate via `DELETE /api/agents/:id/keys/:keyId` followed by a new POST.
- **Rate limits and budgets still apply.** A remote OpenClaw agent counts against the same per-agent budget settings as any local Claude agent.

## Related

- `openclaw_gateway` adapter reference: [`/adapters/openclaw-gateway`](#)
- Issuing and revoking agent API keys: agent ops reference
- Approval gates around hiring remote workers: governance guide
