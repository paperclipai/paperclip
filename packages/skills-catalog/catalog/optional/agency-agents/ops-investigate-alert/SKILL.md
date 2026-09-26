---
name: "ops-investigate-alert"
description: "Investigate a monitoring alert end-to-end. Pulls metrics, logs, traces, and recent code changes to identify root cause. Works with any monitoring MCP."
allowed_tools:
  - Read
  - Glob
  - Grep
  - Bash
key: "paperclipai/optional/agency-agents/ops-investigate-alert"
recommendedForRoles:
  - "engineer"
  - "researcher"
  - "operations"
tags:
  - "agency-agents"
  - "engineer"
  - "researcher"
  - "operations"
  - "ops"
  - "investigate"
  - "alert"
defaultInstall: false
---
# Investigate Alert

Investigate a monitoring alert by pulling metrics, logs, traces, and related service code. Symptoms in, root cause hypothesis out.

## When to Use

- A monitoring alert fired and you need to understand why
- On-call engineer needs a structured investigation starting point
- Alert is noisy and you want to determine if it's actionable or a false positive

## Process

### 1. Verify Monitoring MCP Availability

Check which monitoring MCP servers are available. Look for any `mcp__*` tools related to monitoring platforms (Datadog, Grafana, PagerDuty, etc.).

**Recommended:** Datadog MCP — provides the richest investigation surface (monitors, metrics, logs, traces, events in one platform).

If **no monitoring MCP** is available, **stop** with:

> **Error: No monitoring MCP server found.**
> This skill requires a monitoring MCP to query alert data.
> Recommended: add the Datadog MCP to your Codex MCP settings.

Also check for optional tools:
- **GitHub CLI (`gh`)** — for reading related service code and recent deploys
- **Kubernetes MCP** — for checking pod status

Note which are available — adapt the investigation accordingly.

### 2. Parse Input

**If a monitoring platform URL:**
- Extract the monitor/alert ID from the URL
- Proceed to Step 3

**If an alert name or description:**
- Search monitors using the available monitoring MCP
- If multiple match, list them and ask the user to confirm which one
- If still not found, ask the user for more details

### 3. Fetch Monitor Details

Retrieve the monitor configuration and current state:
- Monitor name, type, and query
- Current status (OK / Alert / Warn / No Data)
- Last triggered time
- Affected service(s) and environment(s)
- Alert message and runbook link (if any)

### 4. Query Metrics

Fetch the metric(s) that triggered the alert:
- **Time window:** from 1 hour before trigger to now (or 1 hour after resolution)
- **What to look for:** anomalies, spikes, drops, flat lines, threshold crossings
- Compare against the monitor's threshold to understand severity

### 5. Analyze Logs

Search logs for the affected service and environment:
- **Time window:** same as Step 4
- **What to look for:** errors, stack traces, timeouts, connection failures, unusual patterns
- **Filter by severity:** focus on ERROR and WARN levels first, then broaden if needed

### 6. Check Traces (if available)

Search for distributed traces:
- Filter by service name and time window
- **What to look for:** slow spans, error spans, unusual latency distribution, failing downstream calls

### 7. Check Infrastructure (if available)

If Kubernetes MCP or cloud CLI is available:
- Pod status, restart counts, OOM kills
- Resource usage (CPU, memory) near the alert time
- Recent deployment events

If not available (VPN, permissions), note it and continue with available data.

### 8. Check Recent Code Changes (if `gh` available)

```bash
gh auth status
```

If authenticated:

1. Identify the repo from the service name
2. **Check recent releases/tags** to see what's currently deployed:
   ```bash
   gh api repos/<org>/<service>/tags --jq '.[0:3] | .[] | {name: .name, sha: .commit.sha}'
   ```
3. **Diff between last 2 tags** to see what changed in the latest release:
   ```bash
   gh api repos/<org>/<service>/compare/<prev-tag>...<latest-tag> --jq '.commits[] | {sha: .sha[:7], message: .commit.message, author: .commit.author.name}'
   ```
4. Look at relevant code based on the error type:
   - HTTP errors → route handlers, middleware
   - DB errors → query code, connection pooling
   - Timeout errors → external call clients, timeout configs
   - OOM → memory-heavy operations, unbounded collections

**NEVER create, push, or modify tags.**

### 9. Present Investigation Summary

```markdown
## Alert Investigation: <Alert Name>

**Status:** <OK / Alert / Warn / No Data>
**Service:** <service> | **Env:** <env>
**Triggered:** <timestamp> | **Duration:** <duration or "Ongoing">

### Metrics
<key observations — spike at X time, value Y vs threshold Z>

### Logs
<key log lines or patterns — N errors of type X, stack trace summary>

### Traces
<latency or error observations — if available>

### Infrastructure
<pod status, resource usage — if available>

### Recent Code Changes
<commits near trigger time, or "No recent changes" or "gh CLI not available">

### Root Cause Hypothesis
<best assessment based on available data — be explicit about confidence level>

### Recommended Next Steps
1. <most impactful action>
2. <secondary action>
3. <what to check if hypothesis is wrong>
```

If data is inconclusive, say so explicitly and suggest what to check manually (e.g., VPN access to k8s, direct DB query, checking with the team).

## Interaction Style

- Lead with data, not guesses — show metrics/logs/traces before forming a hypothesis
- Be explicit about confidence: "high confidence", "likely", "inconclusive"
- If a step yields no data, say so and move on — don't speculate

## Rules

- Never skip Steps 3-5 (monitor, metrics, logs) — these are the core investigation
- Steps 6-8 (traces, infra, code) are optional based on tool availability
- Never create, push, or modify tags or deployments during investigation
- Always present the structured summary at the end, even if inconclusive

## Output

Present the investigation summary inline in the conversation. No file output unless the user asks to save it.
