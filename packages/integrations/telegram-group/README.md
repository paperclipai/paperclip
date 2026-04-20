# @paperclipai/integration-telegram-group

Mirrors an issue branch (root issue + its descendant tree) into a single Telegram **forum topic** in a team chat. One chat can host many topics; one topic tracks one branch.

> **Status:** v0.0.0 scaffold, RFC under platform review. Not yet wired into the platform event bus. See [`RFC.md`](./RFC.md).

## Layout

- `src/types.ts` — public type surface (`TelegramGroupBinding`, `TopicBinding`, event contracts).
- `src/bindings.ts` — binding lifecycle (create via approval, activate, disable).
- `src/state.ts` — `TopicBinding` store interface (implementation plugs into platform DB).
- `src/outbound.ts` — platform issue events → Telegram forum-topic messages.
- `src/inbound.ts` — Telegram webhook updates → issue comments.
- `src/index.ts` — integration entrypoint wiring the four pieces under a host-provided context.

## Why a new `packages/integrations/*` category?

- `packages/adapters/*` is for agent runtimes (Claude, Codex, OpenClaw). An inbound/outbound group-chat bridge is not an agent.
- `packages/plugins/*` is per-agent plugin SDK. A group-chat integration is per-project and long-lived.
- This is expected to be the first of several (Slack, Discord, Linear-sync) — the workspace category is intentional.

## Not in v0.1

- Per-child-issue topic routing (everything logs into the root topic).
- In-topic command DSL (`/status`, `/assign`).
- UI forms for binding management (CLI + board approval only).

## Development

```
pnpm --filter @paperclipai/integration-telegram-group typecheck
pnpm --filter @paperclipai/integration-telegram-group build
```
