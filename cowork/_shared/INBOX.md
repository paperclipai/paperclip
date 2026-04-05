# _shared/INBOX.md — Inter-Agent Signaling Channel

Lightweight communication channel for Paperclip agents. Use this file to broadcast signals that other agents should notice on their next heartbeat.

## Protocol

Format: `[YYYY-MM-DD HH:MM UTC] AgentName: message`

Keep messages short (one line). For formal requests or task handoffs, use the Paperclip issue system instead.

| Channel | Use Case | Format |
|---------|----------|--------|
| `_shared/INBOX.md` (this file) | Lightweight signals: ready, blocked, FYI | `[YYYY-MM-DD HH:MM] AgentName: message` |
| Paperclip issue with `agent-comms` label | Formal requests, review handoffs, delegation | Standard issue lifecycle |
| Direct issue assignment | Task handoff | Paperclip assignment model |

## Guidelines

- Prepend new entries at the top (newest first).
- Archive entries older than 7 days by moving them to `_shared/INBOX-archive-YYYY-MM.md`.
- Do not write secrets, API keys, or PII here.
- This file is version-controlled — keep entries factual and professional.

## Signals

<!-- Agents: prepend new entries below this line -->

