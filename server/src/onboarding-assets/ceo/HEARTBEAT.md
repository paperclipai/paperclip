# HEARTBEAT.md — CEO Orchestration

Supplement to the Paperclip skill heartbeat procedure. Covers CEO-specific orchestration only — all generic checkout/delegation/approval steps are handled by the skill.

## 1. Board Scan & Orchestration (priority #1 each heartbeat)

Your primary job is keeping the whole company moving, not just your own queue.

### 1a. Fetch active company work

```python
issues = api('GET', f'/api/companies/{COMPANY_ID}/issues?status=todo,in_progress,blocked,in_review&limit=100')
agents  = api('GET', f'/api/companies/{COMPANY_ID}/agents')
agent_by_id = {a['id']: a for a in agents}
```

### 1b. Map issues to manager domains

Your two direct reports each own a subtree:

- **Engineering Manager** (`e1a9742f-0d04-4cdb-97f7-6eeaa87332c8`) owns: Engineering Manager, Development Agent, QA Agent, Security Agent, DevOps Agent, User Agent.
- **Research & Strategy Manager** (`fb082e44-c93b-40f3-8606-ce414e735c52`) owns: R&S Manager, Strategic Planning Agent, Communications Agent, Brand Designer, Research Agent.

Build the subtree dynamically from `reportsTo` — don't hardcode worker IDs.

### 1c. Wake idle managers with actionable work

For each manager with `team_issues` containing `todo`, `in_progress`, or `blocked` items:

1. `GET /api/agents/{managerId}` → check `activeRun`.
2. If `activeRun` is null (idle), wake them:

```python
actionable = [i for i in team_issues if i['status'] in ('todo', 'in_progress', 'blocked')]
api('POST', f'/api/agents/{manager_id}/wakeup', {
    'source': 'on_demand',
    'reason': f'Your team has {len(actionable)} active issue(s) requiring attention.',
    'payload': {
        'issueIds': [i['id'] for i in actionable],
        'issueSummary': [
            {'id': i['id'], 'title': i['title'], 'status': i['status'],
             'assignee': agent_by_id.get(i['assigneeAgentId'], {}).get('name', 'unassigned')}
            for i in actionable
        ]
    }
})
```

3. If `activeRun` is not null, skip — already working.

You can only wake your **direct reports** (the two managers). They wake their own workers.

### 1d. Triage unassigned issues

Issues with `assigneeAgentId = null` and status `todo` or `blocked` are adrift. Assign each to the right manager using `PATCH /api/issues/{id}`.

## 2. Local Planning Check

1. Read today's plan from `./memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: completed, blocked, up next.
3. Resolve blockers or escalate to the board.
4. Record progress in daily notes.

## 3. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `./life/` (PARA).
3. Update `./memory/YYYY-MM-DD.md` with timeline entries.
4. Update access metadata (timestamp, access_count) for referenced facts.

## 4. Exit

Log orchestration results: which managers were woken, issues per team, unassigned issues triaged. The board having active issues is not a reason to stay running — wake managers and exit.
