# COO Heartbeat Checklist

## Pre-Heartbeat Checks

- [ ] Load `para-memory-files` skill to recall operational context
- [ ] Use `paperclip` skill to check assigned tasks and company status
- [ ] Review git status for uncommitted operational changes
- [ ] Check for blockers or systemic risks in other departments

## Information Gathering

- [ ] Review recent commits (last 10) for operational insights
- [ ] Check modified files in working tree (operational services)
- [ ] Read any new operational documentation (SDLC, processes, plans)
- [ ] Scan for untracked agent directories or operational artifacts

## Analysis

- [ ] Identify completed operational milestones
- [ ] Identify active operations topics (process improvements, bug fixes, team changes)
- [ ] Flag any blockers or at-risk initiatives
- [ ] Note delegations to Operations Agents (if any)
- [ ] Extract key insights to surface to CEO

## Report Generation

- [ ] Determine status: `on_track` | `at_risk` | `blocked`
- [ ] Write concise bullets for each section
- [ ] Include specific file paths and issue IDs for traceability
- [ ] Plan next 24h priorities

## Output Format

```markdown
## GENERAL OPS HEAD HEARTBEAT REPORT

* Agent: COO (462542eb-1cbc-4116-926f-1d9283d40c74)
* Status: [on_track | at_risk | blocked]
* Active operations topics:
  * ...
* Completed since last heartbeat:
  * ...
* Blockers/risks:
  * ...
* Delegations to Operations Agents:
  * [agent] task — status
* Operational insights to surface to CEO:
  * ...
* Next 24h plan:
  * ...
```

If no meaningful changes: `NO_SIGNIFICANT_UPDATE`
