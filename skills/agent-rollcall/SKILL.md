---
name: agent-rollcall
description: >
  Execute a recursive org-chart health check by creating real probe issues
  for each direct report and polling the API for completion. Use when asked
  to perform a rollcall, health check, or responsiveness audit of your subtree.
  Requires agent-delegate skill. Never simulate — every result must come from
  the API.
---

# Agent Rollcall Protocol

This protocol is a strict, non-negotiable health check of your direct reports and their subtrees.

## Hard Rules

These are absolute prohibitions, not guidelines:

1. **A file on disk is not a rollcall result.** Writing markdown files to the workspace and treating them as probe results is fabrication. Stop and report blocked instead.
2. **A comment saying "I believe X is responsive" is not a rollcall result.** Only a real `done` status from the API counts.
3. **If you cannot create a probe issue via the API, stop.** Set your issue to `blocked`, post the API error, and exit. Do not simulate.
4. **If `agent-list-reports.sh` returns an empty array, your subtree has no reports.** Post a no-op comment on your issue and set status to `done`. Do not invent reports.
5. **Never retry a failed API call as if it succeeded.** Non-zero curl exit = hard stop.

## Protocol Steps

1. **Confirm identity.**
   Call `GET $PAPERCLIP_API_URL/api/agents/me` and verify the returned `id` matches `PAPERCLIP_AGENT_ID`.
   If the env var is unset, stop immediately with status `blocked`.

2. **Get direct reports.**
   Run `${SKILL_SOURCE}/../agent-delegate/scripts/agent-list-reports.sh`.
   - If the array is empty → post a no-op comment, set status `done`, exit.
   - If the API call fails → set status `blocked`, post the error, exit.

3. **Create one probe issue per report.**
   For each report, run:
   ```
   ${SKILL_SOURCE}/scripts/agent-rollcall-probe.sh \
     --agent-id <agentId> \
     --agent-name "<agentName>" \
     --parent "$PAPERCLIP_TASK_ID"
   ```
   Record `(agentName, issueIdentifier)` for each. The script prints the identifier on the first line of stdout.
   If any creation fails, set status `blocked` naming the failed agent, and exit.

4. **Poll each probe to completion.**
   For each probe identifier, run:
   ```
   ${SKILL_SOURCE}/../agent-delegate/scripts/agent-poll-issue.sh <identifier> 600 30
   ```
   If a probe times out (exit 1) → mark that agent `unresponsive`. Continue polling all others — do not abort.

5. **Post results to the triggering issue.**
   Run `${SKILL_SOURCE}/../agent-delegate/scripts/agent-comment.sh "$PAPERCLIP_TASK_ID" "<table>"` with a markdown table exactly like:

   ```markdown
   ## Rollcall Results

   | Agent | Probe | Status | Latency |
   |---|---|---|---|
   | Natasha | [LINAA-42](/LINAA/issues/LINAA-42) | ✅ responsive | 47s |
   | Stark   | [LINAA-43](/LINAA/issues/LINAA-43) | ❌ unresponsive (timeout) | — |
   ```

   Every row must have a real probe identifier from step 3 and a real status from step 4. No row may be fabricated.

6. **Set own issue status.**
   - All probes resolved (even some unresponsive) → `done`
   - Hard API error in step 3 or 4 that blocked completion → `blocked`

## Probe Description (what you tell the subordinate)

The probe issue description must say exactly this (fill in agent name):

> This is a rollcall probe. Your only job is to confirm you are operational.
>
> If you have direct reports, run your own rollcall recursively and include a summary comment on this issue.
>
> Once done, set this issue to `done`.
>
> Do not write files to disk. Do not simulate. Use the API.

## Environment

| Variable | Value |
|---|---|
| `PAPERCLIP_API_URL` | API base URL |
| `PAPERCLIP_API_KEY` | Bearer token |
| `PAPERCLIP_AGENT_ID` | Your agent UUID |
| `PAPERCLIP_COMPANY_ID` | Your company UUID |
| `PAPERCLIP_TASK_ID` | Current issue ID (use as probe parent and results target) |
| `SKILL_SOURCE` | Absolute path to this skill directory (injected by adapter) |
