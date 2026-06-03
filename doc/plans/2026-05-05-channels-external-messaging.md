# Channels: External Messaging Integrations

## Context

LAC-545. Paperclip needs a way to send and receive messages through external platforms — Slack, Discord, Telegram, and others. Today all agent-to-human and agent-to-agent communication lives inside issue comments. That works for structured work, but there are cases where agents need to reach people (or be reached) through the tools those people already use.

OpenClaw solves this with a multi-channel system supporting WhatsApp, Telegram, Discord, Slack, Google Chat, Signal, iMessage, and Nostr. Paperclip should take the same idea but scope it to the control-plane role: routing messages between the Paperclip world (issues, agents, events) and external messaging surfaces.

## What This Is Not

- **Not a replacement for issue comments.** Structured work still flows through issues. Channels are for notifications, alerts, and lightweight human-in-the-loop messaging.
- **Not internal chat between agents.** Agent-to-agent coordination stays issue-based.
- **Not the chat UI from the 2026-03-11 plan.** That plan covers how the board interacts with agents inside Paperclip. Channels cover how Paperclip talks to the outside world.

## Use Cases

1. **Notifications** — Agent completes a deploy, approval needed, budget alert, goal hit. Push to the team's Slack channel or DM the board member.
2. **Inbound commands** — Board member types `/paperclip status` in Discord. Paperclip responds with a summary. Or: board member sends a message in a Slack thread and it becomes an issue comment.
3. **Agent-to-human escalation** — Agent is blocked, needs human input. Sends a message to the configured escalation channel with context and a link back to the issue.
4. **Scheduled digests** — Daily/weekly summaries of company activity pushed to a channel.
5. **Client communication** — Client Shepherd routes status updates to a client-facing Slack channel.

## Core Concepts

### Channel

A configured connection to an external messaging platform, scoped to a company.

```
Channel {
  id: uuid
  companyId: uuid
  platform: 'slack' | 'discord' | 'telegram' | 'email' | 'webhook'
  name: string               // human label, e.g. "#ops-alerts"
  config: json               // platform-specific auth + routing
  status: 'active' | 'disconnected' | 'error'
  direction: 'outbound' | 'inbound' | 'bidirectional'
  createdAt: timestamp
  updatedAt: timestamp
}
```

### Message

A single message sent or received through a channel.

```
Message {
  id: uuid
  companyId: uuid
  channelId: uuid
  direction: 'outbound' | 'inbound'
  content: text              // markdown
  metadata: json             // platform-specific fields (thread_ts, message_id, etc.)
  issueId?: uuid             // linked issue if applicable
  agentId?: uuid             // agent that sent/triggered
  status: 'pending' | 'delivered' | 'failed' | 'received'
  createdAt: timestamp
}
```

### Route

Rules that determine where messages go. A route binds an event type to a channel with optional filtering.

```
Route {
  id: uuid
  companyId: uuid
  channelId: uuid
  trigger: string            // event pattern, e.g. 'issue.status.done', 'agent.blocked', 'approval.needed'
  filter?: json              // optional conditions (projectId, agentId, priority, etc.)
  template?: string          // message template with variable interpolation
  enabled: boolean
  createdAt: timestamp
}
```

## Platform Support (Priority Order)

### Phase 1

| Platform | Direction | Auth | Notes |
|----------|-----------|------|-------|
| Slack | Bidirectional | OAuth app or bot token | Richest integration. Threads, reactions, slash commands. |
| Discord | Bidirectional | Bot token | Webhook for outbound, bot for inbound. |
| Webhook | Outbound | URL + optional secret | Generic fallback. POST JSON to any endpoint. |

### Phase 2

| Platform | Direction | Auth | Notes |
|----------|-----------|------|-------|
| Telegram | Bidirectional | Bot token | Good for personal/small-team use. |
| Email | Outbound (inbound later) | SMTP + optional IMAP | Digest-oriented. Inbound via mailhook. |

### Phase 3 (demand-driven)

| Platform | Direction | Notes |
|----------|-----------|-------|
| Google Chat | Bidirectional | Workspace orgs |
| MS Teams | Bidirectional | Enterprise |
| Signal | Outbound | Privacy-focused teams |

## Architecture

### Where it lives

```
packages/channels/           # Core channel logic, platform adapters
  src/
    platforms/
      slack.ts
      discord.ts
      webhook.ts
      telegram.ts
    router.ts                # Route evaluation engine
    sender.ts                # Outbound message dispatch
    receiver.ts              # Inbound message handling
    types.ts
packages/db/
  src/schema/
    channels.ts              # channels, messages, routes tables
server/
  src/routes/
    channels.ts              # CRUD + test endpoints
  src/services/
    channel-router.ts        # Listens to live events, evaluates routes, dispatches
```

### Outbound flow

```
Live Event (e.g. issue.status changed)
  → channel-router evaluates routes for this company
  → matching routes produce messages
  → sender dispatches to platform adapter
  → adapter calls Slack/Discord/webhook API
  → message record created with delivery status
```

### Inbound flow

```
Platform webhook hits /api/channels/{channelId}/inbound
  → receiver validates signature + extracts content
  → if mapped to an issue: create comment on that issue (triggers normal agent wake)
  → if slash command: route to handler, respond inline
  → message record created
```

### Integration with existing systems

- **Live events**: Channel router subscribes to company live events. No new event system needed.
- **Issues**: Inbound messages can create issue comments. Outbound messages can reference issues.
- **Agents**: Agents can send messages via a `channel.send` capability (added to agent tools). Routes can also fire automatically without agent involvement.
- **Billing**: Message sends are cost events, metered per message. Keeps the existing billing model.

## API Surface

```
POST   /api/companies/{companyId}/channels          # Create channel
GET    /api/companies/{companyId}/channels          # List channels
GET    /api/companies/{companyId}/channels/{id}     # Get channel
PATCH  /api/companies/{companyId}/channels/{id}     # Update channel
DELETE /api/companies/{companyId}/channels/{id}     # Delete channel
POST   /api/companies/{companyId}/channels/{id}/test  # Send test message

POST   /api/companies/{companyId}/routes            # Create route
GET    /api/companies/{companyId}/routes            # List routes
PATCH  /api/companies/{companyId}/routes/{id}       # Update route
DELETE /api/companies/{companyId}/routes/{id}       # Delete route

GET    /api/companies/{companyId}/messages          # List messages (filterable)
POST   /api/channels/{channelId}/inbound            # Platform webhook endpoint

# Agent-facing
POST   /api/companies/{companyId}/channels/send     # Agent sends a message
```

## Agent Capability

Agents get a new tool/capability:

```
channel.send {
  channelId?: string         // specific channel, or...
  channelName?: string       // resolve by name
  content: string            // markdown message
  issueId?: string           // link to current issue
  thread?: string            // platform thread reference for replies
}
```

This is exposed through the existing agent tools mechanism. Agents only see channels they have permission to use.

## UI

### Channel Management (Settings)

- List configured channels with status indicators
- Add/edit channel with platform-specific config form
- OAuth flow for Slack (redirect + callback)
- Test button to send a verification message
- Activity log showing recent messages

### Route Management

- Visual route builder: "When [event] happens, send to [channel] with [template]"
- Enable/disable toggle per route
- Preview what a route would produce for a sample event

### Message Log

- Filterable list of sent/received messages
- Status badges (delivered, failed, pending)
- Click-through to linked issue
- Retry button for failed messages

## Schema Changes

New tables in `packages/db`:

```sql
CREATE TABLE channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  direction TEXT NOT NULL DEFAULT 'outbound',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  channel_id UUID NOT NULL REFERENCES channels(id),
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  issue_id UUID REFERENCES issues(id),
  agent_id UUID REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  channel_id UUID NOT NULL REFERENCES channels(id),
  trigger TEXT NOT NULL,
  filter JSONB,
  template TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Security Considerations

- Channel configs contain secrets (tokens, webhook URLs). Encrypt at rest, never expose in GET responses beyond masked hints.
- Inbound webhooks must validate platform signatures (Slack signing secret, Discord Ed25519).
- Rate-limit outbound sends per channel to avoid platform bans.
- Agent channel access should be permission-scoped (not every agent can message every channel).
- Audit all message sends in activity log.

## Delivery Guarantees

- **At-least-once for outbound**: Queue with retry (3 attempts, exponential backoff). Mark `failed` after exhaustion.
- **Idempotent inbound**: Deduplicate by platform message ID to prevent double-processing.
- **No ordering guarantee across channels**: A message to Slack and Discord may arrive in any order.

## Open Questions

1. **Should channels be company-scoped or instance-scoped?** Recommendation: company-scoped. A Slack workspace maps to one company. Instance-level channels could be a later admin feature.
2. **Thread management**: Should Paperclip maintain thread state per issue (one Slack thread per issue)? Recommendation: yes for bidirectional channels, as it keeps context grouped.
3. **Rich formatting**: Should we support Slack blocks / Discord embeds, or just markdown-to-platform conversion? Recommendation: start with markdown conversion, add rich templates in Phase 2.
4. **Rate limiting model**: Per-channel? Per-company? Both? Recommendation: per-channel with company-level aggregate cap.

## Implementation Phases

### Phase 1: Foundation + Slack + Webhook (4-6 eng days)

- Schema + migrations
- Channel CRUD API
- Webhook outbound adapter (simplest, good for testing)
- Slack outbound adapter (bot token, post to channel)
- Route engine: listen to live events, evaluate triggers, dispatch
- Basic UI: channel list + add form + test button
- Agent `channel.send` capability

### Phase 2: Bidirectional Slack + Discord (3-5 eng days)

- Slack inbound: slash commands + message events via Events API
- Slack OAuth app install flow
- Discord bot adapter (outbound + inbound)
- Thread management (Slack threads mapped to issues)
- Route builder UI
- Message log UI

### Phase 3: Telegram + Email + Polish (3-4 eng days)

- Telegram bot adapter
- Email outbound (SMTP)
- Digest/scheduled sends (integrates with cron system)
- Delivery retry improvements
- Channel health monitoring + auto-disable on repeated failures

## Success Metrics

- Board can receive real-time notifications in their existing tools without checking the Paperclip UI.
- Agents can escalate to humans without the human needing to be watching the dashboard.
- Inbound messages in Slack create issue comments within 5 seconds.
- Message delivery rate >99% for active channels.
- Zero secret leakage in API responses or logs.
