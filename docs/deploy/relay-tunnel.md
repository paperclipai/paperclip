---
title: Relay Tunnel
summary: Remote access to a local Paperclip instance via relay tunnel
---

Access your Paperclip instance from anywhere without port forwarding. The relay tunnel connects your local server to a Cloudflare Workers-based relay, giving you a public subdomain URL (e.g. `https://d4lsc.relay.com`).

## Prerequisites

- `authenticated` deployment mode (relay is blocked in `local_trusted`)
- A relay server URL (self-hosted, or `wss://paperclip-relay.com` for testing)

## 1. Set deployment mode to authenticated

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

Or if already configured:

```sh
pnpm paperclipai configure --section server
```

## 2. Set the relay URL

Add the relay URL to your instance `.env`:

```sh
PAPERCLIP_RELAY_URL=wss://your-relay-server.com
```

Or pass it at startup:

```sh
PAPERCLIP_RELAY_URL=wss://your-relay-server.com pnpm dev
```

> **Test relay**: `paperclip-relay.com` is a community-run test relay, not affiliated with Paperclip AI. You can use `wss://paperclip-relay.com` to try things out, but deploy your own relay server for production. See `doc/RELAY.md` for the full source and deployment instructions.

## 3. Start the server

```sh
pnpm dev
```

On first start, the server:

1. Registers with the relay and receives a token + instance ID
2. Saves `PAPERCLIP_RELAY_TOKEN` to `.env` for future starts
3. Adds the relay hostname (e.g. `d4lsc.your-relay-server.com`) to `allowedHostnames`
4. Prints your public URL in the console

Subsequent starts reuse the saved token and reconnect automatically.

## 4. Access from any device

Open the printed URL (e.g. `https://d4lsc.your-relay-server.com`) from any browser.

## How it works

The relay client maintains a persistent WebSocket connection to the relay server. When a request arrives at your subdomain, the relay forwards it through the tunnel. The client then makes the request to `127.0.0.1:<port>` and sends the response back. WebSocket connections (for real-time features) are bridged transparently.

## Comparison with Tailscale

| | Tailscale | Relay Tunnel |
|---|---|---|
| **Network** | Private mesh VPN | Public internet |
| **Setup** | Install Tailscale on all devices | Set one env var |
| **URL** | Private hostname + port | Public subdomain |
| **Use case** | Team on same Tailscale network | Access from anywhere, mobile |
| **Requires** | `authenticated` mode | `authenticated` mode |

Both options can be used simultaneously.

## Troubleshooting

- **Server refuses to start with relay URL**: ensure deployment mode is `authenticated`, not `local_trusted`.
- **Relay connects but page doesn't load**: check that the relay hostname was added to `allowedHostnames` in `config.json`.
- **Token errors on reconnect**: delete `PAPERCLIP_RELAY_TOKEN` from `.env` and restart to re-register.
