# Telegram as Agent Coordinator — Design

**Status:** Draft / Proposal
**Owner:** Ade Chrysler
**Date:** 2026-04-19

## Problem

The previous fork had a two-way Telegram bot with slash commands (`/ask`, `/issue`,
`/register`, `/status`, forum topics, etc.) that predated upstream's issue-chat
UI. That bot is dropped in this merge because it conflicted with upstream's new
`IssueChatThread` / `RunChatSurface` infrastructure.

What's missing now: a mobile-friendly way to chat with agents and delegate work
without having to open the web UI and manually create/track issues one by one.

## Vision

Telegram becomes a **thin chat front-end over the issue-chat system**, so the
same conversational surface users get in the web UI is reachable from a phone.

- User DMs the bot → bot routes the message into the issue-chat pipeline.
- Each Telegram thread maps to a long-lived "coordinator issue" (or a newly
  spun-up issue if the user's intent looks like a concrete task).
- Agent responses flow back to Telegram in the same way they render in the UI.
- The bot acts as a **coordinator**: it can ask any agent in the workspace,
  route follow-ups, and open sub-issues as the agent spawns subtasks.

## Non-goals

- Not reimplementing the old command-driven bot (`/list`, `/my`, inline
  keyboards, etc.). The bot listens in natural language and coordinates.
- Not replacing the web UI — Telegram is for quick access, not primary workflow.

## Architecture sketch

```
Telegram webhook
      │
      ▼
POST /api/telegram/webhook
      │
      ▼
TelegramCoordinator.route(message)
      │   resolves (user, company, agent, issue)
      ▼
issueChat.postUserMessage(issueId, message)          ← same path as web UI
      │
      ▼  (heartbeat + run loop as normal)
      │
agent response → liveEvents → TelegramRelay.send(chatId, runOutput)
```

### Key components

1. **TelegramCoordinator** (new service): authenticates incoming Telegram users
   against Paperclip accounts, resolves which company/project/agent to route to,
   and creates/reuses a "coordinator issue" per Telegram chat.
2. **IssueChat integration**: reuse upstream's issue-chat message flow rather
   than reinventing. Posting a comment on the coordinator issue triggers the
   heartbeat → agent run → agent comments back.
3. **TelegramRelay** (new): subscribes to `activity.logged` events for the
   coordinator issue and forwards agent comments back to Telegram.
4. **Schema additions** (small):
   - `telegram_user_bindings (telegram_user_id, paperclip_user_id, companyId, defaultAgentId, coordinatorIssueId)`
   - Reuse existing `issues`, `issueComments` tables for everything else.

### Routing rules (MVP)

- DM to bot → post to user's default coordinator issue. Response streams back.
- First-time user → bot walks them through binding: "Send me your Paperclip
  invite code" → creates `telegram_user_binding`.
- Named agent (`@qa-bot please run the e2e suite`) → routes to that agent
  within the same coordinator issue thread.
- Concrete task signal (`please fix login bug, high priority`) → coordinator
  opens a new issue, assigns to chosen agent, pastes link back to Telegram.

## Auth model

- Bind Telegram `chat_id` ↔ Paperclip `user_id` via one-time invite code
  generated from the web UI (similar to bootstrap invites).
- All actions taken via Telegram run as that user's principal — reuses
  upstream's RBAC/authz, no new permission surface.

## Rollout plan

- Phase 0 (this merge): ship `notifyOps` alert channel only. Two-way bot dropped.
- Phase 1: binding flow + DM → coordinator issue (single default agent).
- Phase 2: named-agent routing (`@agent` in message body).
- Phase 3: auto-spawn sub-issues when the agent plans work.

## Open questions

- Should Telegram users map 1:1 to Paperclip users, or can we allow anonymous
  "guest" chat with a restricted agent?
- Forum-topic vs DM-only at MVP? Forum topics give per-issue threads but add
  complexity; DM-only is simpler and matches the "coordinator" framing.
- Rate-limiting policy — agent runs cost money, Telegram is high-volume surface.
