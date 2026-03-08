# Paperclip + Plane Integration

## Why Plane?

Instead of building task management features into Paperclip (dependencies, blockers, cycles), use **Plane** (plane.so) as the task management backend.

**Plane already has:**
- ✅ Task dependencies (blocking/blocked by)
- ✅ Timeline view with dependency connectors
- ✅ Cycles/sprints
- ✅ Multiple views (Kanban, List, Calendar, Timeline)
- ✅ Projects and workspaces
- ✅ Full REST API
- ✅ Self-hosted option

**Paperclip focuses on:**
- Agent orchestration (heartbeats, scheduling)
- Governance (approvals, budgets)
- Cost tracking
- Org chart

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              USER LAYER                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │  Mimo App   │  │  Telegram   │  │   Discord   │  │   Web UI    │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘   │
└─────────┼────────────────┼────────────────┼────────────────┼───────────┘
          │                │                │                │
          └────────────────┴────────────────┴────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        OPENCLAW GATEWAY                                  │
│                        (Message Router)                                  │
│                                    │                                     │
│                                    ▼                                     │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          │                                                   │
          ▼                                                   ▼
┌─────────────────────────────┐         ┌─────────────────────────────┐
│      PAPERCLIP              │         │         PLANE               │
│  (Agent Orchestration)      │         │   (Task Management)         │
│                             │         │                             │
│  ┌───────────────────────┐  │         │  ┌───────────────────────┐  │
│  │ agents                │  │         │  │ workspaces            │  │
│  │  • org chart          │  │         │  │  • projects           │  │
│  │  • budgets            │  │◄───────►│  │  • issues (tasks)     │  │
│  │  • status             │  │  sync   │  │  • dependencies       │  │
│  │  • heartbeats         │  │         │  │  • cycles             │  │
│  └───────────────────────┘  │         │  │  • views              │  │
│  ┌───────────────────────┐  │         │  └───────────────────────┘  │
│  │ cost_events           │  │         │                             │
│  │ activity_log          │  │         │  API: api.plane.so          │
│  │ approvals             │  │         │  Self-hosted option         │
│  └───────────────────────┘  │         │                             │
│                             │         └─────────────────────────────┘
│  Focus: Agent governance   │
│                             │
└─────────────────────────────┘
```

---

## Integration Design

### 1. Mapping: Paperclip Agents ↔ Plane Issues

```typescript
// Paperclip Agent maps to Plane Issue
interface AgentToIssueMapping {
  paperclipAgentId: string;  // Agent UUID
  planeWorkspaceSlug: string; // e.g., "jarvis-workspace"
  planeProjectId: string;    // Project UUID
  planeIssueId: string;      // Issue UUID (assigned task)
}
```

### 2. Synchronization

| Event | Paperclip Action | Plane Action |
|-------|------------------|--------------|
| Agent assigned | Update `assigneeAgentId` | Update issue `assignees` |
| Task started | Set status `in_progress` | Set issue state to "In Progress" |
| Task blocked | Set status `blocked` | Set issue dependency (blocked_by) |
| Task done | Set status `done` | Set issue state to "Completed" |
| Cost incurred | Create `cost_event` | (No sync needed) |
| Comment added | Add to activity_log | Add issue comment |

### 3. API Integration

```typescript
// Paperclip service: plane-sync.ts

class PlaneSync {
  private planeApi = 'https://api.plane.so/api/v1';
  private apiKey: string;

  async syncIssueToPaperclip(planeIssue: PlaneIssue): Promise<PaperclipIssue> {
    // Create or update Paperclip issue from Plane issue
    const issue = await this.upsertIssue({
      planeId: planeIssue.id,
      title: planeIssue.name,
      description: planeIssue.description,
      status: this.mapPlaneStateToStatus(planeIssue.state),
      assigneeAgentId: await this.mapPlaneAssigneeToAgent(planeIssue.assignees),
      dependencies: await this.fetchPlaneDependencies(planeIssue.id),
    });
    return issue;
  }

  async syncPaperclipToPlane(issue: PaperclipIssue): Promise<void> {
    // Update Plane issue from Paperclip changes
    await fetch(`${this.planeApi}/workspaces/${this.workspaceSlug}/projects/${issue.planeProjectId}/issues/${issue.planeId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: issue.title,
        description: issue.description,
        state: this.mapStatusToPlaneState(issue.status),
        assignees: [issue.assigneeAgentId?.planeUserId],
      }),
    });
  }

  async checkDependencies(issueId: string): Promise<{ canProceed: boolean; blockers: PlaneIssue[] }> {
    // Fetch dependencies from Plane
    const deps = await fetch(`${this.planeApi}/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${issueId}/relations/`)
      .then(r => r.json());

    const blockers = deps.results.filter(d =>
      d.relation_type === 'blocked_by' &&
      d.related_issue.state.category !== 'completed'
    );

    return {
      canProceed: blockers.length === 0,
      blockers,
    };
  }
}
```

---

## Plane API Reference

### Authentication

```http
Authorization: Bearer <plane-api-key>
X-Workspace-Slug: jarvis-workspace
```

### Create Issue

```http
POST /api/v1/workspaces/{workspace_slug}/projects/{project_id}/issues/
{
  "name": "Implement authentication",
  "description": "Add JWT auth to API",
  "priority": "high",
  "state": "backlog",
  "assignees": ["user-uuid"]
}
```

### Add Dependency (Blocker)

```http
POST /api/v1/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/relations/
{
  "related_issue": "blocker-issue-uuid",
  "relation_type": "blocked_by"
}
```

### Update Issue State

```http
PATCH /api/v1/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/
{
  "state": "in-progress-state-uuid"
}
```

### Get Issue Dependencies

```http
GET /api/v1/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/relations/
```

---

## Implementation Plan

### Phase 1: Plane Setup (Day 1)

- [ ] Create Plane workspace: "Jarvis Workspace"
- [ ] Create projects: "Agent Tasks", "Infrastructure", "Research"
- [ ] Generate API key
- [ ] Configure states (backlog, todo, in_progress, blocked, done, cancelled)

### Phase 2: Paperclip Adapter (Day 2)

- [ ] Create `plane-sync` service in Paperclip
- [ ] Add `planeWorkspaceSlug`, `planeProjectId`, `planeIssueId` to issues table
- [ ] Implement sync functions (Paperclip ↔ Plane)
- [ ] Add dependency checking via Plane API

### Phase 3: Heartbeat Integration (Day 3)

- [ ] Check Plane dependencies before agent checkout
- [ ] Sync status changes to Plane
- [ ] Auto-unblock when dependencies complete (via Plane webhook)

### Phase 4: UI Integration (Day 4)

- [ ] Embed Plane views in Paperclip dashboard
- [ ] Or link to Plane for task management
- [ ] Show dependency status in agent cards

### Phase 5: Migration (Day 5)

- [ ] Export tasks from ClawDeck
- [ ] Import to Plane via API
- [ ] Link Paperclip agents to Plane issues

---

## Plane Configuration

### Workspace Structure

```
Jarvis Workspace
├── Projects
│   ├── Agent Tasks (default)
│   ├── Infrastructure
│   ├── Research
│   └── Marketing
├── States
│   ├── Backlog
│   ├── Todo
│   ├── In Progress
│   ├── Blocked
│   ├── In Review
│   └── Done
└── Cycles
    ├── Sprint 1
    ├── Sprint 2
    └── ...
```

### Issue Properties

```yaml
# Custom properties for agent tasks
properties:
  agent_name:
    type: text
    description: "Assigned Paperclip agent"
  cost_cents:
    type: number
    description: "Cost in cents"
  pr_url:
    type: url
    description: "GitHub PR link"
```

---

## Benefits

| Feature | Paperclip (before) | Paperclip + Plane |
|---------|-------------------|-------------------|
| Dependencies | ❌ Missing | ✅ Built-in |
| Timeline view | ❌ Missing | ✅ Built-in |
| Cycles/Sprints | ❌ Missing | ✅ Built-in |
| Multiple views | ❌ Only Kanban | ✅ Kanban, List, Timeline, Calendar |
| Self-hosted | ✅ | ✅ (both) |
| API | ✅ | ✅ (both) |
| Maintenance | Build everything | Reuse Plane |

---

## Cost

**Plane Cloud:**
- Free: Up to 10 users
- Pro: $7/user/month

**Plane Self-Hosted:**
- Free (MIT license)
- Requires: Docker, PostgreSQL

---

## Alternative: Linear vs Plane

| Feature | Linear | Plane |
|---------|--------|-------|
| Dependencies | ✅ | ✅ |
| Self-hosted | ❌ | ✅ |
| Open source | ❌ | ✅ (MIT) |
| API | ✅ | ✅ |
| Price | $8/user | $7/user or free |

**Recommendation:** Use **Plane** because it's open-source and self-hostable.

---

## Self-Hosted Plane Setup

```yaml
# docker-compose.yml
version: '3.8'

services:
  plane-web:
    image: makeplane/plane:latest
    command: web
    depends_on:
      - plane-api
      - plane-worker
    ports:
      - "3000:3000"
    environment:
      - WEB_URL=http://localhost:3000
      - CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3100

  plane-api:
    image: makeplane/plane:latest
    command: api
    depends_on:
      - plane-db
      - redis
    environment:
      - DATABASE_URL=postgresql://plane:plane@plane-db:5432/plane
      - REDIS_URL=redis://redis:6379/

  plane-worker:
    image: makeplane/plane:latest
    command: worker
    depends_on:
      - plane-api

  plane-db:
    image: postgres:15
    environment:
      - POSTGRES_USER=plane
      - POSTGRES_PASSWORD=plane
      - POSTGRES_DB=plane
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:alpine

volumes:
  pgdata:
```

Run:
```bash
docker-compose up -d
# Plane available at http://localhost:3000
```

---

## Integration Points

### Paperclip → Plane

```typescript
// When agent checks out task
async function checkoutTask(agentId: string, issueId: string) {
  // 1. Check dependencies in Plane
  const { canProceed, blockers } = await planeSync.checkDependencies(issueId);
  if (!canProceed) {
    throw new Error(`Blocked by: ${blockers.map(b => b.name).join(', ')}`);
  }

  // 2. Update Paperclip
  await paperclipDb.updateIssue(issueId, {
    status: 'in_progress',
    assigneeAgentId: agentId,
  });

  // 3. Sync to Plane
  await planeSync.syncPaperclipToPlane(issue);

  // 4. Trigger agent heartbeat
  await triggerHeartbeat(agentId, { issueId });
}
```

### Plane → Paperclip (Webhook)

```typescript
// Plane webhook handler
app.post('/webhooks/plane', async (req, res) => {
  const { event, issue } = req.body;

  if (event === 'issue.updated') {
    // Sync to Paperclip
    await paperclipSync.syncIssueToPaperclip(issue);
  }

  if (event === 'issue.completed') {
    // Check if this unblocks other tasks
    await checkUnblockedTasks(issue.id);
  }

  res.json({ received: true });
});
```

---

## Open Questions

1. **Bi-directional sync or one-way?**
   - Bi-directional: Changes in Plane sync to Paperclip, and vice versa
   - One-way: Paperclip is source of truth, Plane is read-only view

2. **Which is primary UI?**
   - Paperclip dashboard with embedded Plane views
   - Plane as primary, Paperclip for agent orchestration only

3. **Self-hosted or Cloud?**
   - Self-hosted for full control
   - Cloud for simplicity

---

## Recommendation

**Use Plane for task management, Paperclip for agent orchestration:**

| Layer | Tool | Responsibility |
|-------|------|----------------|
| Task Management | Plane | Issues, dependencies, cycles, views |
| Agent Orchestration | Paperclip | Heartbeats, scheduling, governance |
| Execution | OpenClaw | Agent runtime, skills |

**This eliminates the need to build dependencies into Paperclip.**
