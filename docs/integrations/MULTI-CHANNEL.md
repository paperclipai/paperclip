# Multi-Channel Architecture

## Overview

The mimo app is the primary user interface, but users can interact through multiple channels:
- **Mimo App** (primary) - Full-featured web interface
- **Telegram** - Mobile messaging
- **Discord** (future) - Community channels
- **Web UI** (future) - Direct agent invocation

All channels route through **Paperclip** for task management and **OpenClaw** for execution.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              USER LAYER                                  │
│                                                                          │
│    👤 User interacts via preferred channel                               │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐│
│  │              │  │              │  │              │  │              ││
│  │   🖥️ MIMO    │  │  📱 Telegram │  │  💬 Discord  │  │   🌐 Web     ││
│  │     APP      │  │              │  │   (future)   │  │  (future)    ││
│  │  (Primary)   │  │              │  │              │  │              ││
│  │              │  │              │  │              │  │              ││
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘│
│         │                 │                 │                 │        │
└─────────┼─────────────────┼─────────────────┼─────────────────┼────────┘
          │                 │                 │                 │
          │                 │                 │                 │
          └─────────────────┴─────────────────┴─────────────────┘
                                    │
                                    │ All channels hit OpenClaw Gateway
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        OPENCLAW GATEWAY                                  │
│                        (Message Router)                                  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                      MESSAGE ROUTER                                 │ │
│  │                                                                     │ │
│  │  1. Identify channel (telegram/mimo/discord/web)                   │ │
│  │  2. Parse message + extract context                                 │ │
│  │  3. Check Paperclip for existing task                              │ │
│  │  4. Route to appropriate agent                                     │ │
│  │  5. Execute + get response                                         │ │
│  │  6. Report cost to Paperclip                                       │ │
│  │  7. Send response via same channel                                 │ │
│  │                                                                     │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│                                    │ API Calls                           │
│                                    ▼                                     │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        PAPERCLIP (Control Plane)                         │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐│
│  │              │  │              │  │              │  │              ││
│  │    AGENTS    │  │    ISSUES    │  │  SCHEDULER   │  │  GOVERNANCE  ││
│  │              │  │              │  │              │  │              ││
│  │  • Org chart │  │  • Tasks     │  │  • Heartbeats│  │  • Approvals ││
│  │  • Budgets   │  │  • Checkout  │  │  • Events    │  │  • Audit     ││
│  │  • Status    │  │  • Comments  │  │  • Triggers  │  │  • Escalate  ││
│  │              │  │              │  │              │  │              ││
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘│
│                                                                          │
│                         PostgreSQL                                       │
│                    (Single Source of Truth)                              │
│                                                                          │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │
                                     │ Webhook / Invoke
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        OPENCLAW (Execution Plane)                        │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐│
│  │              │  │              │  │              │  │              ││
│  │   🤖 JARVIS  │  │  💻 CODER    │  │  🎨 SALLY    │  │  ✅ MIKE     ││
│  │    (CEO)     │  │  (Backend)   │  │  (Frontend)  │  │    (QA)      ││
│  │              │  │              │  │              │  │              ││
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘│
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │              │  │              │  │              │                  │
│  │  📚 RICHARD  │  │  🔧 NOLAN    │  │  📢 ELSA     │                  │
│  │  (Research)  │  │  (DevOps)    │  │ (Marketing)  │                  │
│  │              │  │              │  │              │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
│                                                                          │
│  Skills: MEMORY.md, proactive-agent, telegram, etc.                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Message Flow Examples

### Example 1: Telegram Message

```
User (Telegram)
    │
    │ "What's the status of the HK schools project?"
    │
    ▼
OpenClaw Gateway
    │
    │ 1. Parse: channel=telegram, topic=2520, sender=261069981
    │ 2. Lookup: topic 2520 → HK Schools project
    │ 3. Paperclip: GET /api/issues?metadata.topicId=2520
    │ 4. Assign: Jarvis (CEO) handles status queries
    │ 5. Execute: Jarvis queries project status
    │ 6. Report: POST /api/cost-events (usage: 500 in, 200 out)
    │
    ▼
Jarvis Agent
    │
    │ "The HK Schools project has 3 tasks in progress..."
    │
    ▼
OpenClaw Gateway
    │
    │ Reply to Telegram topic 2520
    │
    ▼
User (Telegram)
```

### Example 2: Mimo App Request

```
User (Mimo App)
    │
    │ "Spawn an agent to fix the authentication bug"
    │
    ▼
OpenClaw Gateway
    │
    │ 1. Parse: channel=mimo, session=abc123, user=montelai
    │ 2. Paperclip: POST /api/issues (create bug fix task)
    │ 3. Paperclip: POST /api/issues/{id}/checkout (assign to Coder)
    │ 4. Execute: Trigger Coder heartbeat
    │ 5. Report: POST /api/cost-events
    │
    ▼
Coder Agent (in worktree)
    │
    │ [Creates PR #123: Fix auth bug]
    │
    ▼
OpenClaw Gateway
    │
    │ Update Mimo App UI with progress
    │
    ▼
User (Mimo App)
```

### Example 3: Scheduled Heartbeat (No User)

```
Paperclip Scheduler (every 30 min)
    │
    │ POST /webhook/jarvis { agentId, wakeReason: "timer" }
    │
    ▼
Jarvis Agent (in OpenClaw)
    │
    │ 1. GET /api/agents/me
    │ 2. GET /api/issues?assigneeAgentId=me&status=in_progress
    │ 3. Find task: "Review open PRs"
    │ 4. Execute: Check GitHub PRs, post comments
    │ 5. PATCH /api/issues/{id} { status: "in_progress", comment: "..." }
    │
    ▼
Paperclip
    │
    │ Task updated, cost recorded
    │
    ▼
Dashboard shows: "Jarvis reviewed 3 PRs"
```

---

## Channel Configuration

### Telegram (Already Working)

```yaml
channel: telegram
config:
  bot_token: ${TELEGRAM_BOT_TOKEN}
  topic_mapping:
    "2520": "hk-schools-project"
    "57": "polymarket-agent"
    "302": "hk-p1-admissions"
  default_agent: jarvis
  cost_tracking: per_message
```

### Mimo App (Primary)

```yaml
channel: mimo
config:
  base_url: http://localhost:3100
  session_timeout: 30m
  stream_response: true
  cost_tracking: batch
  features:
    - task_creation
    - agent_invocation
    - real_time_updates
    - cost_display
```

### Discord (Future)

```yaml
channel: discord
config:
  bot_token: ${DISCORD_BOT_TOKEN}
  guild_id: "123456789"
  channel_mapping:
    "general": "jarvis"
    "dev": "coder"
    "design": "sally"
  cost_tracking: per_message
```

### Web UI (Future)

```yaml
channel: web
config:
  websocket: true
  auth: required
  features:
    - direct_invocation
    - session_history
    - cost_dashboard
    - task_board
```

---

## Key Design Decisions

### 1. Mimo App is Primary Interface

**Rationale:**
- Users already familiar with mimo workflow
- Full-featured (tasks, agents, history)
- Customizable for specific needs

**Implementation:**
- Mimo talks to OpenClaw Gateway
- Gateway routes through Paperclip for task management
- Responses stream back to mimo UI

### 2. All Channels Route Through Paperclip

**Rationale:**
- Single source of truth for tasks
- Unified cost tracking
- Consistent governance

**Implementation:**
- Each channel creates/updates Paperclip issues
- Metadata tracks channel source
- Cost events tagged by channel

### 3. OpenClaw Remains Execution Layer

**Rationale:**
- OpenClaw already handles Telegram
- Skills and tools already integrated
- No need to rewrite execution logic

**Implementation:**
- Add Paperclip API calls to agents
- Report costs after each interaction
- Use Paperclip for task assignment

---

## Cost Tracking by Channel

```typescript
// After agent responds, report cost
async function reportCost(channel: string, agent: Agent, usage: Usage) {
  await fetch('http://localhost:3100/api/companies/{id}/cost-events', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PAPERCLIP_API_KEY}` },
    body: JSON.stringify({
      agentId: agent.id,
      issueId: agent.currentIssueId,
      provider: 'zai',
      model: 'glm-5',
      inputTokens: usage.input,
      outputTokens: usage.output,
      costCents: calculateCost(usage),
      occurredAt: new Date().toISOString(),
      metadata: { channel }  // Track which channel triggered
    })
  });
}
```

### Cost Dashboard View

```
┌────────────────────────────────────────────┐
│         COST BY CHANNEL (This Month)       │
├────────────────────────────────────────────┤
│ Channel      │ Messages │ Cost    │ %     │
├────────────────────────────────────────────┤
│ Mimo App     │ 1,234    │ $12.34  │ 60%   │
│ Telegram     │ 567      │ $5.67   │ 28%   │
│ Web UI       │ 123      │ $1.23   │ 6%    │
│ Discord      │ 89       │ $0.89   │ 4%    │
│ Scheduled    │ 45       │ $0.45   │ 2%    │
├────────────────────────────────────────────┤
│ TOTAL        │ 2,058    │ $20.58  │ 100%  │
└────────────────────────────────────────────┘
```

---

## Next Steps

1. **Implement Message Router** (Phase 4)
   - Create channel handlers
   - Implement Paperclip API integration
   - Test with Telegram

2. **Update Mimo App** (Phase 5)
   - Add Paperclip task integration
   - Display cost per session
   - Show task status in real-time

3. **Add More Channels** (Future)
   - Discord integration
   - Web UI for direct invocation
   - Slack integration

---

## Related

- `PRD.md` - Full project requirements
- `IMPLEMENTATION.md` - Phase-by-phase plan
- `COMPARISON.md` - Before/after architecture
