# Skill: `agent-rollcall`

Create a new skill at `skills/agent-rollcall/` in the Paperclip repo.

## Purpose

`agent-rollcall` is a strict, non-negotiable protocol for recursively verifying that all agents in a subtree of the org chart are operational. It is distinct from general delegation (`agent-delegate`) in that it:

- Has no flexibility in its steps — every step is required, every failure is a hard stop
- Defines exactly what "responsive" means (a real `done` from the API — nothing else qualifies)
- Produces a fixed output format (a markdown table) so consuming agents cannot improvise it
- Explicitly names and prohibits every known fabrication pattern

The root cause of the LINAA-33 failure was that rollcall was a *pattern section* inside a larger skill, leaving agents room to reason around it when they hit obstacles. This skill removes that room.

## Skill location

```
skills/agent-rollcall/
  SKILL.md
  scripts/
    agent-rollcall-probe.sh    # creates a probe issue and returns identifier
```

## `SKILL.md` content requirements

### Frontmatter

```yaml
---
name: agent-rollcall
description: >
  Execute a recursive org-chart health check by creating real probe issues
  for each direct report and polling the API for completion. Use when asked
  to perform a rollcall, health check, or responsiveness audit of your subtree.
  Requires agent-delegate skill. Never simulate — every result must come from
  the API.
---
```

### Hard rules (must appear verbatim or equivalent)

These must be stated as absolute prohibitions, not guidelines:

1. **A file on disk is not a rollcall result.** Writing markdown files to the workspace and treating them as probe results is fabrication. Stop and report blocked instead.
2. **A comment saying "I believe X is responsive" is not a rollcall result.** Only a real `done` status from the API counts.
3. **If you cannot create a probe issue via the API, stop.** Set your issue to `blocked`, post the API error, and exit. Do not simulate.
4. **If `agent-list-reports.sh` returns an empty array, your subtree has no reports.** Post a no-op comment on your issue and set status to `done`. Do not invent reports.
5. **Never retry a failed API call as if it succeeded.** Non-zero curl exit = hard stop.

### Protocol steps (exact, in order)

The SKILL.md must define the protocol as a numbered checklist with no optional steps:

1. **Confirm identity.** `GET /api/agents/me` — verify `PAPERCLIP_AGENT_ID` matches. If the env var is unset, stop immediately.

2. **Get direct reports.** Run `agent-list-reports.sh`. If empty → post no-op comment, set status `done`, exit. If API error → set `blocked`, exit.

3. **Create one probe issue per report.** For each report, run `agent-create-issue.sh` with:
   - `--title "Rollcall Probe - {agentName}"`
   - `--assignee {agentId}`
   - `--parent {currentIssueId}` (the current rollcall issue)
   - `--description` including: what a rollcall probe is, that the report should set the issue to `done` when it confirms it is operational, and that sub-agents should recursively run their own rollcall

   Record `(agentName, urlKey, issueIdentifier, createdAt)` for each. If any creation fails, set `blocked` with the failed agent named, exit.

4. **Poll each probe to completion.** Run `agent-poll-issue.sh <identifier> 600 30` for each probe. Record `status` and `elapsed`. If any probe times out (exit 1), mark that agent as `unresponsive` — do not stop the whole rollcall, continue polling others.

5. **Post results to the parent issue.** Run `agent-comment.sh` on the issue that triggered the rollcall with a markdown table:

   ```markdown
   ## Rollcall Results

   | Agent | Probe | Status | Latency |
   |---|---|---|---|
   | Natasha | [LINAA-42](/LINAA/issues/LINAA-42) | ✅ responsive | 47s |
   | Stark   | [LINAA-43](/LINAA/issues/LINAA-43) | ❌ unresponsive (timeout) | — |
   ```

   The table must be produced from real API data. No row may be filled in without a real probe identifier from step 3 and a real status from step 4.

6. **Set own issue to `done` (or `blocked`).** If all probes completed (even if some were unresponsive), set status `done`. If step 3 or 4 hit a hard API error that prevented completion, set `blocked`.

### What the probe description tells the subordinate agent

The probe issue description must clearly instruct the subordinate:

- This is a rollcall probe. Your only job is to confirm you are operational.
- If you have direct reports, run your own rollcall (recursively) and include a summary in a comment on this issue.
- Once done, set this issue to `done`.
- Do not write files to disk. Do not simulate. Use the API.

## `scripts/agent-rollcall-probe.sh`

A thin convenience wrapper around `agent-create-issue.sh` that sets the standard probe title and description template, requiring only `--agent-id`, `--agent-name`, and `--parent` as arguments. Returns the probe identifier on stdout.

This script exists to ensure the probe description is always consistent and complete — agents must not hand-write probe descriptions because inconsistent descriptions have historically caused subordinates to misunderstand their task.

## Tests

- Unit test: `agent-rollcall-probe.sh` produces a valid probe issue identifier when the API is available
- Integration test: a full rollcall against a mock API with two reports, one of which times out, produces a correctly formatted results table with the unresponsive agent marked

## Dependencies

- `agent-delegate` skill must also be assigned to any agent using `agent-rollcall` (provides the underlying curl scripts)
- `PAPERCLIP_TASK_ID` must be set (the current issue ID to use as probe parent and results target)

## Assignment

Assign `agent-rollcall` only to agents that run rollcalls: typically the CEO/top-level orchestrator and any sub-orchestrators who manage a team. Do not assign it to leaf agents.
