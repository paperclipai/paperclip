# VTHQ agent orchestration

## Purpose

This is the operating model for autonomous coding work in VTHQ. Paperclip is the task and run record; Hermes coordinates work; FirstMate performs coding; OpenClaw reviews and monitors.

## Responsibilities

| Component | Responsibility | Reports to |
| --- | --- | --- |
| Hermes | Intake, planning, dispatch, status updates, and operator communication | You |
| FirstMate | Primary coding executor in the existing coding workspace | Hermes |
| OpenClaw | Technical review, monitoring, and corrective follow-up | Hermes |
| Paperclip | Durable task, ownership, run, and audit control plane | You |

FirstMate does not replace Hermes or OpenClaw. It is the worker selected when a Paperclip task requires implementation. OpenClaw reviews the resulting work and Hermes gives the operator the consolidated outcome.

## Runtime topology

```text
You
  │
  ▼
Hermes ────────► Paperclip ◄──────── OpenClaw
                    │
                    │ authenticated WSS
                    ▼
       mcp.vthq.net/firstmate/realtime
                    │
                    ▼
       FirstMate realtime relay (MCP host)
                    │
                    ▼
       FirstMate coding session (coding host)
```

Paperclip is served at `https://paperclip.vthq.net`. The FirstMate relay is served only through `wss://mcp.vthq.net/firstmate/realtime`; the relay itself remains on the MCP host.

## Paperclip configuration

The active FirstMate agent is:

- Name: `FirstMate`
- Adapter: `firstmate_gateway`
- Role: `general`
- Title: `Primary Coding Executor`
- Reports to: active `Hermes` Chief of Staff
- Default state: `idle`; Paperclip dispatches it on demand.

Adapter configuration uses the relay URL above, the dedicated Paperclip relay credential, and a 30-minute run timeout. Do not put the relay token in task text, issue comments, source control, or browser URLs.

## Dispatch and lifecycle contract

Paperclip sends a dispatch containing a run ID, FirstMate agent ID, task ID, brief, and idempotency key. The relay forwards it only to the connected FirstMate coding agent.

FirstMate emits structured `PAPERCLIP_EVENT` markers. Valid terminal events are `completed`, `failed`, and `cancelled`; Paperclip never treats a quiet terminal or an idle tmux pane as successful completion. Events are bound to the original run and agent ID, and mismatched events are rejected.

This makes retry and review decisions based on explicit run state, rather than terminal appearance.

## Credentials and security boundaries

- Hermes and FirstMate use separate relay credentials.
- The Paperclip relay credential is root-owned on the MCP host at `/etc/firstmate-realtime/paperclip-token` with mode `0600`.
- The relay service reads the normal token and the Paperclip token through systemd. The Paperclip token is not copied to the coding host.
- TLS terminates at the existing MCP Nginx virtual host. The Paperclip host is explicitly allowed by that application proxy.
- No firewall, UFW, iptables, MikroTik, VPN tunnel, or SSH policy change is required by this integration.

## Deployment locations

| Item | Host | Location |
| --- | --- | --- |
| Paperclip deployment | Plane (`192.168.88.15`) | `/opt/paperclip` |
| Paperclip source | Plane | `/opt/paperclip/source` |
| Paperclip systemd unit | Plane | `paperclip.service` |
| FirstMate relay | MCP (`192.168.88.12`) | `/opt/firstmate-realtime-bridge` |
| Relay systemd unit | MCP | `firstmate-realtime-server.service` |
| FirstMate coding agent | Coding (`192.168.88.10`) | `firstmate-realtime-agent.service` |
| TLS route | MCP | `/etc/nginx/sites-enabled/vthq-mcp-tls` |

The Paperclip build currently identifies as `810db762f` and the adapter implementation is maintained in the Paperclip worktree branch `feat/firstmate-paperclip-worker`.

## Safe verification

Use non-writing checks before a live task:

1. Confirm `paperclip.vthq.net` health returns HTTP 200.
2. Confirm `firstmate-realtime-server.service` is active and its health reports `agent_connected: true`.
3. From the Paperclip container, perform an authenticated WebSocket handshake to the FirstMate relay and expect a `hello` consumer frame.
4. Confirm the FirstMate agent appears in Paperclip as `firstmate_gateway`, idle, reporting to Hermes.

Do not use a fake completion or terminal-idle check as an end-to-end test. A live dispatch injects a command into FirstMate's coding session; only run one when that session is known to be free or when the task is explicitly intended for it.

## Normal operating flow

1. Create or route a task in Paperclip.
2. Hermes clarifies the objective and dispatches FirstMate.
3. FirstMate implements the task and reports lifecycle progress.
4. OpenClaw reviews output, tests, logs, and repository state; it can create a corrective task when needed.
5. Hermes reports the final status to you and Paperclip retains the task/run history.

## Recovery

- If Paperclip is unhealthy, use `systemctl restart paperclip.service` on the Plane host. Do not invoke Docker Compose manually: the systemd unit loads `/etc/paperclip/paperclip.env`.
- If the relay is unhealthy, inspect then restart `firstmate-realtime-server.service` on the MCP host.
- If the coding agent is disconnected, inspect then restart `firstmate-realtime-agent.service` on the Coding host.
- Keep backup files outside active Nginx configuration directories. Test Nginx with `nginx -t` before reload.
