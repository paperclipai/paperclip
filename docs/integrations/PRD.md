# PRD: Paperclip + OpenClaw Integration

**Project ID:** `paperclip-openclaw-integration`
**Status:** Planning
**Created:** 2026-03-08
**Feature Branch:** `feat/openclaw-integration`
**Repository:** `~/repos/paperclip/`
**GitHub:** https://github.com/montelai/paperclip/tree/feat/openclaw-integration

---

## Overview

Consolidate Jarvis Workspace's custom agent orchestration (OpenCode Swarm + ClawDeck) with Paperclip's battle-tested platform, eliminating redundancy while preserving OpenClaw as the execution layer.

---

## Goals

### Primary Goals
1. **Eliminate redundancy** - Remove 5 duplicate systems (AGENTS.md, ClawDeck, active-tasks.json, monitoring scripts)
2. **Single source of truth** - PostgreSQL replaces JSON files + SQLite
3. **Add governance** - Built-in approvals, budgets, audit trail
4. **Mobile access** - React UI works from anywhere

### Non-Goals
- Changing OpenClaw execution behavior
- Modifying agent skills or capabilities
- Replacing OpenClaw with another runtime

---

## Branching Strategy

### Long-Running Feature Branch

```
main (upstream paperclip)
  │
  └──► feat/openclaw-integration (OUR BASE)
         │
         ├──► feat/pc-1-setup-paperclip          (Phase 1)
         ├──► feat/pc-2-create-agents            (Phase 2)
         ├──► feat/pc-3-webhook-integration      (Phase 3)
         ├──► feat/pc-4-agent-skills             (Phase 4)
         ├──► feat/pc-5-migrate-tasks            (Phase 5)
         ├──► feat/pc-6-scheduling               (Phase 6)
         ├──► feat/pc-7-governance               (Phase 7)
         ├──► feat/pc-8-monitoring               (Phase 8)
         └──► feat/pc-9-cleanup                  (Phase 9)
```

### Rules

1. **Feature branch is base** - All PRs target `feat/openclaw-integration`, NOT `main`
2. **Worktrees for isolation** - Each phase gets its own worktree
3. **Squash merge** - Keep history clean on feature branch
4. **Final merge to main** - After all phases complete and tested

### Creating Worktrees

```bash
# Create worktree for a phase
cd ~/repos/paperclip
git worktree add ~/worktrees/pc-1-setup-paperclip -b feat/pc-1-setup-paperclip feat/openclaw-integration

# Work in the worktree
cd ~/worktrees/pc-1-setup-paperclip
# ... make changes ...

# Create PR targeting feature branch
gh pr create --base feat/openclaw-integration --head feat/pc-1-setup-paperclip
```

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Redundant systems | 5 | 0 |
| Services running | 3 (OpenClaw, ClawDeck, monitoring) | 2 (OpenClaw, Paperclip) |
| Task sync method | File-based (JSON) | Database (PostgreSQL) |
| Governance | None | Full approvals + budgets |
| Mobile access | No | Yes |
| Maintenance scripts | 7 bash scripts | 0 |

---

## Phases

### Phase 1: Setup Paperclip (Day 1)

**Branch:** `feat/pc-1-setup-paperclip`

**Tasks:**
- [ ] Install Paperclip locally
- [ ] Run dev server
- [ ] Complete onboarding
- [ ] Create company structure
- [ ] Verify dashboard works

**Deliverable:** Paperclip running at `http://localhost:3100`

---

### Phase 2: Create Agent Org Chart (Day 1-2)

**Branch:** `feat/pc-2-create-agents`

**Tasks:**
- [ ] Create CEO (Jarvis) with OpenClaw adapter
- [ ] Create CTO
- [ ] Create engineering team (6 agents)
- [ ] Configure reporting relationships
- [ ] Set budgets

**Deliverable:** Full org chart in Paperclip

**Agent Mapping:**
| Current | Paperclip Agent | Adapter |
|---------|-----------------|---------|
| Jarvis | CEO | `openclaw` |
| Coder | BackendEngineer | `opencode_local` |
| Sally | FrontendEngineer | `opencode_local` |
| Mike | QAEngineer | `opencode_local` |
| Richard | ResearchEngineer | `opencode_local` |
| Nolan | DevOpsEngineer | `opencode_local` |
| Elsa | MarketingEngineer | `opencode_local` |

---

### Phase 3: Webhook Integration (Day 2-3)

**Branch:** `feat/pc-3-webhook-integration`

**Tasks:**
- [ ] Create OpenClaw webhook receiver
- [ ] Test Paperclip → OpenClaw connection
- [ ] Verify heartbeat delivery
- [ ] Test cost reporting

**Deliverable:** Bidirectional communication working

---

### Phase 4: Agent Skills Update (Day 3-4)

**Branch:** `feat/pc-4-agent-skills`

**Tasks:**
- [ ] Add paperclip skill to agents
- [ ] Update heartbeat protocol in agents
- [ ] Test checkout/update cycle
- [ ] Document new workflow

**Deliverable:** Agents can interact with Paperclip API

---

### Phase 5: Task Migration (Day 4-5)

**Branch:** `feat/pc-5-migrate-tasks`

**Tasks:**
- [ ] Export tasks from ClawDeck
- [ ] Transform to Paperclip issues format
- [ ] Import to Paperclip
- [ ] Verify task assignments
- [ ] Test task creation flow

**Deliverable:** All tasks migrated to Paperclip

---

### Phase 6: Scheduling (Day 5-6)

**Branch:** `feat/pc-6-scheduling`

**Tasks:**
- [ ] Configure heartbeat intervals per agent
- [ ] Test scheduled heartbeats
- [ ] Test event-driven heartbeats
- [ ] Verify auto-assignment

**Deliverable:** Heartbeats running on schedule

---

### Phase 7: Governance (Day 6-7)

**Branch:** `feat/pc-7-governance`

**Tasks:**
- [ ] Configure approval rules
- [ ] Set up Telegram notifications
- [ ] Test approval workflow
- [ ] Document governance process

**Deliverable:** Approvals working end-to-end

---

### Phase 8: Monitoring (Day 7-8)

**Branch:** `feat/pc-8-monitoring`

**Tasks:**
- [ ] Review Paperclip dashboard
- [ ] Add custom metrics
- [ ] Set up alerts
- [ ] Test cost tracking

**Deliverable:** Full visibility in Paperclip UI

---

### Phase 9: Cleanup (Day 8-10)

**Branch:** `feat/pc-9-cleanup`

**Tasks:**
- [ ] Disable old crontabs
- [ ] Archive bash scripts
- [ ] Stop ClawDeck service
- [ ] Remove AGENTS.md
- [ ] Update all documentation
- [ ] Merge feature branch to main

**Deliverable:** Old system fully retired

---

## Technical Architecture

### Before (Current)

```
Jarvis Workspace
├── AGENTS.md (static agent definitions)
├── ClawDeck (SQLite task management)
├── active-tasks.json (task registry)
├── check-agents.sh (monitoring cron)
├── auto-spawn-tasks.sh (auto-assign cron)
├── spawn-agent.sh (agent spawning)
└── Linux crontab (scheduling)
```

### After (Target)

```
Paperclip (Control Plane)
├── PostgreSQL (agents, issues, runs, costs)
├── React UI (dashboard, org chart, approvals)
├── Scheduler (heartbeats, event triggers)
└── API (REST endpoints)

OpenClaw (Execution Plane)
├── MEMORY.md (long-term memory)
├── skills/ (agent capabilities)
└── Agent sessions (execution)
```

---

## OpenClaw Adapter Configuration

```json
{
  "adapterType": "openclaw",
  "adapterConfig": {
    "url": "http://localhost:18789/api/webhook/{agentName}",
    "method": "POST",
    "webhookAuthHeader": "Bearer {OPENCLAW_TOKEN}",
    "timeoutSec": 300,
    "payloadTemplate": {
      "source": "paperclip",
      "version": "1.0"
    }
  }
}
```

---

## Cost Tracking

### Automatic (Heartbeats)
- Paperclip adapter extracts usage from webhook response
- Cost recorded to `cost_events` table
- Budget auto-updated

### Manual (Telegram Triggers)
- Agent calls `POST /api/companies/{id}/cost-events` after response
- Includes token counts and cost in cents
- Paperclip updates budget

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Data loss during migration | Low | High | Full backup before migrate |
| Webhook failures | Medium | Medium | Retry logic + polling fallback |
| Agent confusion | Low | Medium | Clear documentation + training |
| Paperclip bugs | Low | Medium | Keep scripts archived for rollback |
| Performance issues | Low | Medium | Test with full load before switch |

---

## Rollback Plan

If migration fails:

1. **Re-enable crontabs**
   ```bash
   crontab -e
   # Uncomment monitoring lines
   ```

2. **Restart ClawDeck**
   ```bash
   pm2 start clawdeck
   ```

3. **Restore AGENTS.md**
   ```bash
   git checkout AGENTS.md
   ```

4. **Archive Paperclip**
   ```bash
   pm2 stop paperclip
   ```

---

## Dependencies

### Required
- [x] Paperclip repo cloned (`~/repos/paperclip`)
- [x] OpenClaw running (`localhost:18789`)
- [x] Node.js 20+
- [x] pnpm 9+
- [x] PostgreSQL (embedded in Paperclip)

### Optional
- [ ] Telegram bot token (for notifications)
- [ ] Tailscale (for remote access)

---

## Timeline

| Day | Phase | Status |
|-----|-------|--------|
| 1 | Setup + Org Chart | 🔲 Not started |
| 2 | Webhook Integration | 🔲 Not started |
| 3 | Agent Skills | 🔲 Not started |
| 4 | Task Migration | 🔲 Not started |
| 5 | Scheduling | 🔲 Not started |
| 6 | Governance | 🔲 Not started |
| 7 | Monitoring | 🔲 Not started |
| 8-10 | Cleanup + Merge | 🔲 Not started |

---

## Acceptance Criteria

- [ ] All 7 agents created in Paperclip
- [ ] Heartbeats working (scheduled + event-driven)
- [ ] Tasks migrated from ClawDeck
- [ ] Governance/approvals functional
- [ ] Cost tracking working
- [ ] Dashboard accessible from mobile
- [ ] Old system fully retired
- [ ] Documentation updated

---

## Related Documents

- `IMPLEMENTATION.md` - Detailed 7-day plan
- `OVERLAP-ANALYSIS.md` - Redundancy analysis
- `COMPARISON.md` - Architecture diagrams
- `QUICKSTART.md` - 5-minute test guide
- `CONSOLIDATION-SUMMARY.md` - Visual summary

---

## Changelog

| Date | Change |
|------|--------|
| 2026-03-08 | Initial PRD created |
| 2026-03-08 | Added branching strategy |
