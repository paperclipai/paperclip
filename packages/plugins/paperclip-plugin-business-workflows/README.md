# @paperclipai/plugin-business-workflows

First-party Paperclip workflow plugin for operator-heavy execution loops across meetings, email, CRM, content, planning, and mission-control routines.

## What it covers

- **Meeting transcript → tasks + proposal draft**
- **Email thread triage + reply drafting**
- **Calendar event intake + follow-up task extraction**
- **Lead intake + CRM pipeline tracking**
- **Content repurposing task fan-out**
- **Multi-platform content campaign packs**
- **Daily brief generation**
- **Focus block planning**
- **Mission control launch plans**
- **Pipeline/watchdog reporting**

## Why this plugin exists

Paperclip already provides the orchestration primitives: companies, projects, issues, goals, agents, activity logs, jobs, and plugins. This plugin turns those primitives into a workflow operating layer that an operator, founder, chief of staff, or growth lead can use immediately.

Instead of building new control-plane concepts, it composes what Paperclip already knows how to do:

- create and update issues
- attach documents
- create goals
- invoke agents
- schedule recurring jobs
- persist company-scoped workflow state

## Included workflows

### Meeting transcript intake

- Creates a parent meeting issue
- Extracts action items from notes/transcripts
- Creates child task issues for extracted actions
- Stores the original transcript as a document
- Generates and optionally attaches a proposal draft

### Proposal generation

- Generates structured markdown proposals from meeting or operator notes
- Stores the latest proposal draft in plugin state
- Can attach the draft to an issue document

### Email triage + reply drafting

- Creates an issue from an email thread
- Stores the full thread as a document
- Extracts action items from the thread
- Generates a reply draft tuned for operator follow-up
- Stores the latest email reply in plugin state

### Calendar event intake

- Creates an issue from a calendar event or meeting recap
- Stores notes/attendee context as a document
- Extracts follow-up tasks from event notes
- Supports automatic child issue creation for follow-ups

### Lead intake + pipeline tracking

- Creates lead issues from structured lead data
- Persists lead notes and pipeline state as documents
- Tracks lead stage, score, next step, and follow-up date
- Auto-creates follow-up tasks when pipeline movement requires one
- Stores company-scoped lead pipeline entries in plugin state

### Content repurposing

- Creates a parent repurposing issue from a source asset
- Fans out child issues per requested platform
- Useful for transcript clips, calls, memos, webinars, and internal notes

### Content campaign packs

- Generates a markdown campaign pack from source material
- Produces platform-specific guidance for X, LinkedIn, newsletter, and related channels
- Creates a parent campaign issue and child execution issues per platform
- Stores the latest campaign pack in plugin state

### Daily brief

- Scheduled daily job that produces a company-level markdown brief
- Summarizes open issues, active goals, and recent workflow records
- Stores the latest daily brief in plugin state

### Focus planning

- Builds focus blocks from open issues and active goals
- Produces a markdown plan for the day
- Stores the latest focus plan in plugin state

### Mission control

- Creates a coordinating goal and parent issue around a business objective
- Breaks the objective into execution lanes such as Revenue, Content, Operations, and Product
- Can invoke available agents with lane-specific prompts
- Stores the latest mission-control plan in plugin state

### Pipeline watchdog

- Scheduled watchdog job that scans for:
	- blocked issues
	- stale issues
	- lead follow-ups that are due
- Produces a markdown watchdog report
- Stores the latest watchdog report in plugin state

## Data the plugin exposes

The overview data surface includes:

- project list
- agent list
- recent workflow records
- latest daily brief
- latest proposal draft
- latest email reply
- latest focus plan
- latest mission-control plan
- latest content campaign
- latest watchdog report
- lead pipeline snapshot
- counts for issues, goals, agents, pipeline entries, and due follow-ups

## Actions and jobs

### Actions

- `ingest-meeting-transcript`
- `generate-proposal-draft`
- `ingest-email-thread`
- `generate-email-reply`
- `ingest-calendar-event`
- `plan-focus-blocks`
- `ingest-lead`
- `update-lead-pipeline`
- `queue-content-repurpose`
- `generate-content-campaign`
- `launch-mission-control`
- `run-pipeline-watchdog`
- `generate-daily-brief`

### Jobs

- `daily-brief` — daily company brief
- `pipeline-watchdog` — recurring watchdog scan every 4 hours

## Tool surface

- `proposal-draft-from-notes`
- `daily-brief-summary`
- `email-reply-from-thread`
- `content-campaign-pack`
- `mission-control-snapshot`

## Development

```bash
pnpm install
pnpm --filter @paperclipai/plugin-business-workflows typecheck
pnpm --filter @paperclipai/plugin-business-workflows test
pnpm --filter @paperclipai/plugin-business-workflows build
```

## Install into Paperclip

```bash
pnpm paperclipai plugin install ./packages/plugins/paperclip-plugin-business-workflows
```