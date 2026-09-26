---
name: "ops-oncall-log"
description: "Create a structured on-call log by pulling alerts from monitoring and writing a summary to your team's wiki. Requires a monitoring MCP (recommended: Datadog) and a wiki MCP (Confluence or Notion)."
allowed_tools:
  - Read
  - Glob
  - Grep
  - Bash
key: "paperclipai/optional/agency-agents/ops-oncall-log"
recommendedForRoles:
  - "designer"
  - "operations"
tags:
  - "agency-agents"
  - "designer"
  - "operations"
  - "ops"
  - "oncall"
  - "log"
defaultInstall: false
---
# On-Call Log

Pull alerts from your monitoring platform and create a structured on-call log on your team's wiki.

## When to Use

- End of your on-call shift — log what happened for the next engineer
- Daily or weekly on-call review meetings
- Building a history of alert patterns over time

## Process

### 1. Verify MCP Server Availability

Two MCP servers are required:

1. **Monitoring MCP** — to fetch alert events and monitor status. Recommended: Datadog MCP.
2. **Wiki MCP** — to create the log page. Supported: Confluence (`mcp__claude_ai_Atlassian__*`) or Notion (`mcp__claude_ai_Notion__*`).

If **either** is missing, **stop** with:

> **Error: Missing required MCP server(s): `<list>`.**
> This skill needs both a monitoring MCP and a wiki MCP.
> Recommended: Datadog MCP + Confluence or Notion MCP.

### 2. Gather Configuration

Ask the user:

1. **Log frequency** — daily or weekly? (default: weekly)
2. **On-call rotation schedule** — what day does the rotation start? (default: Friday, only relevant for weekly)
3. **Environment filter** — which environments to include? (default: prod only)
4. **Wiki space/parent** — where to create the log page:
   - **Confluence:** space key and parent page ID
   - **Notion:** parent page ID or database ID
5. **Template page** (optional) — an existing page to use as format reference

If the user has run this before and configuration is available (e.g., in `.spartan/config.yaml`), reuse those settings and confirm:
> "Using previous settings: **<frequency>**, **<env>** alerts, wiki at **<location>**. Correct?"

### 3. Determine Date Range

Based on the log frequency from Step 2:

- **Daily:** today (or a specific date if the user provides one)
- **Weekly:** calculate the on-call window based on the rotation day (e.g., Friday to Friday)

If the user provides a custom date range, use that instead.

Confirm with the user:
> "Logging on-call for **<start date> – <end date>**. Is this correct?"

Wait for confirmation before continuing.

### 4. Fetch Alerts from Monitoring

#### 4a. Check for existing page (incremental update)

Search the wiki for an existing page for this period (using the naming convention from Step 7). If found, read it to find the **last updated timestamp**. Ask the user: "A page for this period already exists. **Update** it or **create new**?"

- If **update**: use the last updated timestamp as the `from` date instead of the full window start — this avoids re-fetching alerts already logged and reduces token usage.
- If **create new**: use the full window start and create a separate page in Step 8.

Add a `**Last updated:** <timestamp>` line at the top of the page on each update.

#### 4b. Query triggered alert events

Use the available monitoring MCP to fetch alert events:
- Filter by environment + triggered/warn status
- Time range: from last update (or window start if new page) to now
- Sort by timestamp

**Pagination:** If results are truncated, paginate until all events are fetched.

#### 4c. Filter and normalize

From all fetched events:
- **Exclude** events from non-target environments
- **Exclude** recovery events — only count triggered and warn events
- **Normalize** monitor titles: strip status prefixes to get the base monitor name

#### 4d. Build the alert summary

Group events by **base monitor name**. For each group collect:

1. **Appear Count** — total trigger events for that monitor during the window
2. **Appear Times** — each trigger timestamp, with a link to the event in the monitoring platform
3. **Current Status** — is the monitor still in Alert status right now?

Sort alerts by Appear Count descending.

#### 4e. Check currently active monitors

Query monitors currently in Alert status. Flag these as needing follow-up by the next on-call.

If no alerts during the window, note "No alerts this period" and continue.

### 5. Ask for Additional Notes

> "Any additional notes, incidents, or action items to include in the log?"

Record their input. If "none", continue without notes.

### 6. Fetch Template (if configured)

If the user provided a template page in Step 2, fetch it and use its structure as the format guide. Otherwise use the default structure from Step 8.

### 7. Find or Create the Target Location

Organize on-call logs in a consistent hierarchy:

```
On-call Logs/
  On-call <YYYY>/
    On-call <MM>/<YYYY>/
      [On-call] <Start Date> - <End Date>
```

1. Check if the year folder exists — create if missing
2. Check if the month folder exists — create if missing
3. Check if a page for this period already exists:
   - If found and user chose **update** in Step 4a: update this page in Step 8
   - If found and user chose **create new** in Step 4a: create a new page in Step 8
   - If not found: proceed to Step 8

### 8. Create the Log Page

Create the page on the wiki platform:

```markdown
# On-call Log: <Start Date> – <End Date>

## Alert Summary

| Alert | Count | Times | Cause | Resolution |
|-------|-------|-------|-------|------------|
| <monitor name> | <N> | <timestamp 1>, <timestamp 2>, ... | | Still active |

**Total alerts:** <N> across <M> unique monitors

## Currently Active Alerts
<list monitors still in Alert status, or "None — all clear">

## Notes
<additional notes from Step 5, or "None">

## Action Items for Next On-call
- <follow up on active alert X>
- <investigate recurring alert Y — triggered N times>
```

**Formatting:**
- Link alert names to their monitoring page
- Link timestamps to the specific event
- Leave "Cause" column empty for the engineer to fill post-hoc
- Set "Resolution" to "Still active" for monitors currently in Alert status; leave empty for resolved monitors (engineer fills post-hoc)

### 9. Present Result

```markdown
## On-call Log Created

**Page:** <page title>
**URL:** <wiki page URL>
**Alerts logged:** <N> alerts across <M> unique monitors
**Active alerts:** <count or "None">
**Notes:** <summary or "None">
```

If there are unresolved alerts:
> **Action items for next on-call:** The following alerts are still active — follow up with the relevant team: `<list>`

## Interaction Style

- Confirm configuration and date range before fetching — don't assume
- Ask one round of questions, not multiple back-and-forth
- Present the final page URL prominently so the user can share it immediately

## Rules

- Always confirm the date range before fetching alerts
- Only include production alerts unless the user explicitly asks for other environments
- Never create duplicate wiki pages — check for existing ones first
- Leave "Cause" column empty — the engineer fills it post-hoc. Set "Resolution" to "Still active" for active monitors, leave empty for resolved ones
- Paginate fully — do not present partial alert data

## Output

Create the log page directly on the wiki platform (Confluence or Notion). Present the URL and stats inline in the conversation.
