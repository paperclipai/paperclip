# The Monitor Agency Design

Date: 2026-03-30
Status: Approved design
Scope: Autonomous monitoring company inside the existing Paperclip instance

## Plain-English Summary

`The Monitor Agency` is a separate company inside Paperclip whose job is to watch the outside world so you do not have to.

In simple terms:

- It watches the tools, services, and competitors that could affect your business.
- It decides what changed and whether the change matters.
- It prepares work automatically: issues, plans, draft pull requests, tests, and low-risk merges.
- It actively looks for new tools, features, and opportunities that could make your products better or your team faster.
- It actively looks for new AI capabilities you may not even know exist yet, so you do not have to rely on luck or random discovery.
- It stays quiet unless a change is important enough that a human decision is actually needed.

This is not a second Paperclip server. It is a new company living inside the same Paperclip you already use.

## Why This Exists

Right now, staying current requires a human to remember to check:

- GitHub releases
- dependency updates
- provider pricing changes
- API deprecations
- model retirements
- competitor launches
- industry news

That creates two problems:

1. Important changes get missed.
2. Even when changes are noticed, someone still has to read them, interpret them, and decide what to do next.

`The Monitor Agency` solves that by making monitoring part of operations instead of a manual chore.

It should also help you get ahead, not just avoid problems. That means it should look for useful new AI tools, feature ideas, and market openings before you ask for them.

Part of the reason this matters is that modern AI moves too fast for a normal person to track comfortably. Good tools, new agent products, useful MCPs, and valuable workflows can appear at any time. If nobody is actively scouting, you only learn about them by accident.

## What It Is

`The Monitor Agency` is a dedicated Paperclip company with its own:

- projects
- agents
- routines
- issues
- plans
- pull request workflow

It is separate from your other companies so its work does not clutter normal product work.

## What It Watches

The company has four major lanes of work.

### 1. Platform Monitoring

This lane watches technical changes that can affect your systems:

- `paperclip`
- `openclaw`
- adapter repos
- dependencies
- GitHub Actions and CI changes
- infrastructure and deployment tooling
- provider API changes
- pricing changes
- policy changes
- model launches and retirements
- security-relevant announcements

### 2. Strategic Monitoring

This lane watches business and market changes:

- competitor launches
- competitor feature changes
- major industry news
- ecosystem shifts
- partnerships
- other market signals that suggest a strategy change

### 3. Opportunity Monitoring

This lane looks for things that could make your business faster, better, or more profitable:

- new AI tools that could save time
- new products or services worth integrating
- new workflows that reduce manual work
- new feature ideas for your own products
- new market openings created by technology shifts
- new ways to package, automate, or sell what you already do

### 4. Capability Discovery

This lane is specifically about finding useful AI capabilities before they are widely known inside your business:

- new AI tools
- new skills worth installing
- new MCPs and plugins
- new agent frameworks
- new specialist AI agents
- new AI companies or services worth hiring or integrating
- new workflows that give leverage without requiring a full rebuild

## Watch Registry

The company should not operate on a vague idea of "everything."

It needs a concrete watch registry that says exactly what is being monitored.

Each registry entry should include:

- source type
- source identifier
- why it is being watched
- priority level
- polling cadence
- mute or disable status
- owning project or lane
- last checked time
- last meaningful change seen

Examples of source types:

- GitHub repository
- release feed
- changelog page
- pricing page
- documentation page
- provider status or policy page
- competitor website
- product announcement source
- skill registry
- MCP source
- plugin source
- AI company or service source

This registry turns the mission into a concrete operating list.

## How It Works In Plain English

Think of it like a small operations team.

### Step 1. Watch

The company checks the sources it has been assigned on a schedule.

Examples:

- GitHub releases
- upstream commit history
- changelogs
- provider docs
- pricing pages
- product announcements
- industry sources

### Step 2. Understand

When something changes, it does not just forward a link.

It asks:

- What changed?
- Does this affect us?
- Is this small, risky, urgent, or strategic?
- Does it need code, planning, or no action at all?
- Is this a threat, an opportunity, or both?
- Is this something we should build, buy, integrate, hire, or ignore?

### Step 3. Act

Depending on the answer, it can:

- do nothing and log the event
- create an internal issue
- draft a plan
- open a draft pull request
- run tests
- merge low-risk updates automatically
- create a major-decision escalation for you
- create a proactive proposal when it finds something worth exploiting
- recommend a build-versus-buy decision when a new capability appears

## Decision Matrix

The company needs explicit rules for what it is allowed to do.

Every detected item should be scored on at least two dimensions:

- risk
- confidence

Suggested risk levels:

- `low`
- `medium`
- `high`
- `critical`

Suggested confidence levels:

- `low`
- `medium`
- `high`

Examples of how these combine:

- low risk + high confidence: auto-handle if validation passes
- medium risk + high confidence: create issue or draft PR and validate
- high risk: never auto-merge, escalate internally
- critical: immediate escalation path
- low confidence: do not take irreversible action

This is how words like `low-risk` become usable by the system.

## Validation Matrix

Different kinds of changes need different kinds of checks.

The company should not use one generic "run tests" step for everything.

Examples:

- dependency update: relevant tests, lockfile integrity, smoke check
- provider API change: integration check, auth check, pricing impact review
- deployment change: environment validation, rollout safety checks
- documentation or policy change: source verification and impact classification
- new tool recommendation: usefulness score, integration difficulty, confidence score
- strategic recommendation: evidence threshold and source corroboration

If the required validation for a change type does not exist yet, the system should fail closed rather than silently treating the change as safe.

## Memory and Deduplication

The company needs memory of what it has already seen and decided.

Without that, it will keep rediscovering the same things.

It should record:

- source item fingerprint
- first seen time
- last seen time
- prior classification
- prior recommendation
- prior action taken
- cooldown window before re-raising the same item

Examples:

- a tool already rejected should not be suggested every week
- a previously accepted MCP should not be rediscovered as if it were new
- a release already merged should not reopen the same work

## Routing and Handoff

`The Monitor Agency` should not own every downstream task forever.

Recommended rule:

- monitoring, triage, validation, and low-risk maintenance stay inside `The Monitor Agency`
- product opportunities get routed into the relevant product company or project
- strategic opportunities get routed as plans or decision items
- technical maintenance that can be safely completed stays with the agency

This makes the company the scout and operator for discovery and upkeep, while still allowing real business work to land in the right place.

## Budget and Quotas

Because this company watches many sources, it needs limits.

It should have:

- per-lane budget targets
- polling limits
- source count limits
- backoff rules for low-value sources
- caps on how many new items can be raised in a given period

This keeps the system useful instead of noisy or expensive.

## Source Reliability

Not all sources deserve equal trust.

The company should use explicit source weighting.

Examples:

- official docs and release notes: high trust
- source code and commits: high trust
- pricing or policy pages from providers: high trust
- competitor marketing pages: medium trust
- social posts, hype threads, and commentary: low trust unless corroborated

For strategic or capability recommendations, major decisions should require multiple trustworthy signals rather than one exciting source.

### Step 4. Escalate Only When Needed

You should not be asked to judge technical details.

You should only be interrupted when the system has already translated the problem into plain English and a real decision is needed.

Examples:

- `This update is low risk and ready to merge.`
- `This upstream change is likely breaking authentication.`
- `This competitor move may require a pricing response.`
- `This provider change creates new cost exposure.`

## Company Structure

Company name:

- `The Monitor Agency`

Projects:

- `Platform Monitoring`
- `Strategic Monitoring`
- `Opportunity Pipeline`
- `Capability Discovery`
- `Escalations`

## Agent Roles

### Upstream Scout

Finds new technical changes in repos, releases, changelogs, providers, and tooling.

### Dependency Triage

Figures out whether those changes matter and how risky they are.

### PR Operator

Creates dedicated update branches, opens draft pull requests, runs validation, and merges low-risk updates when allowed.

### Provider Watch

Monitors model providers, APIs, pricing, policy shifts, and platform changes.

### Market Intel

Tracks competitor and industry changes and turns those into strategy work when useful.

### Opportunity Hunter

Looks for new AI tools, product ideas, automation opportunities, and workflow improvements that could help you move faster or make more money.

### Capability Scout

Looks for new skills, MCPs, plugins, agents, services, and AI companies that could give you leverage, and recommends whether to test them, adopt them, integrate them, or hire them.

### Executive Escalation

Produces the few messages that should reach you, in plain language, when a real decision is needed.

## Branching and Pull Requests

Automated update work should use clearly separate branch names such as:

- `monitor/paperclip/release-0-3-2`
- `monitor/openclaw/auth-changes-2026-03-30`

Why:

- easy to identify
- easy to filter
- safer to review
- separate from normal product work

## Autonomy Policy

This company is intended to be self-managing.

That means it is allowed to:

- monitor automatically
- classify changes automatically
- create issues automatically
- create plans automatically
- open draft pull requests automatically
- run tests automatically
- merge low-risk changes automatically
- create proactive proposals automatically
- recommend new capabilities automatically

It is not intended to wait for a human on routine work.

Recommended operating rule:

- the agency originates, triages, validates, and completes low-risk work
- it routes product and strategic work to the appropriate destination once the opportunity is clear
- it does not directly commit money, procurement, or hiring decisions without approval

## Safety Rules

Autonomy is bounded by guardrails.

Auto-merge is allowed only when:

- the change is classified low-risk
- tests pass
- smoke checks pass
- the change does not touch clearly sensitive areas

Sensitive areas include:

- authentication
- permissions
- deployment
- database migrations
- billing
- uncertain or breaking behavior

If a change touches one of those areas, the company should hold it for deeper internal triage and only escalate if a real decision is required.

Additional safety rule:

- low confidence should block irreversible action, even when the apparent risk is low

## Communication Policy

The communication model is intentionally quiet.

Normal work stays inside `The Monitor Agency`.

You only get interrupted for major decisions such as:

- high-risk upstream breakage
- important failing validation
- likely breaking provider changes
- strategic actions with meaningful business consequences
- major opportunities worth funding, shipping, or prioritizing
- major new capabilities worth adopting, integrating, or hiring
- changes involving money, permissions, or irreversible action

This means you are not expected to monitor drafts, logs, releases, or technical severity yourself.

This also means the messages that do reach you should already answer:

- what happened
- why it matters
- what the recommended action is
- what happens if you do nothing

## Delivery and Notifications

The company should separate execution from reading and alerts.

Recommended delivery architecture:

- Paperclip: system of record
- Notion: executive briefing surface
- Telegram via Theo/OpenClaw: notification and escalation channel

### Paperclip As The System Of Record

Paperclip should keep the real operational state:

- issues
- plans
- PRs
- validation results
- routing decisions
- logs of what the agency did

### Notion As The Reading Surface

Notion should be used for polished human-readable briefings such as:

- daily digest
- weekly digest
- opportunity memos
- capability reports
- strategy summaries
- recommended actions in plain English

Why:

- easier to read
- better for narrative summaries
- better for reviewing multiple items at once
- better than chat for longer executive briefings

### Telegram As The Delivery Layer

Telegram should be used for short messages that point you to what matters.

Recommended Telegram message types:

- urgent decision alert
- new digest available
- proactive suggestion
- high-priority capability recommendation

Each Telegram message should be short and include:

- what happened
- why it matters
- the top recommended action
- a Notion link for full reading when appropriate

### Recommended Channel Rules

- urgent items: Telegram immediately, with optional Notion detail
- routine digest: write in Notion, then send Telegram summary plus link
- proactive suggestions: short Telegram summary, with Notion page if the recommendation is substantial

This keeps Telegram lightweight while making Notion the place where you actually read the full update.

## Why Separate Company Instead of Separate Server

It should not be a separate Paperclip deployment.

Using a separate company inside the existing Paperclip instance is better because:

- it uses the same permissions and GitHub connections
- it can create work in the same operating environment
- it stays visible inside the same system
- it avoids another server to maintain
- it remains isolated enough through company boundaries

## Success Criteria

This design is successful when:

- important upstream and market changes are detected without human checking
- low-risk updates are handled automatically
- valuable new tools and feature opportunities are surfaced proactively
- important new AI capabilities are discovered before you would normally hear about them
- risky changes are translated into plain-English decisions
- you are interrupted rarely
- the company reduces maintenance burden instead of creating a new one
- it avoids repeated duplicate recommendations
- it stays within acceptable operating cost and noise levels
- it delivers readable executive briefings without requiring you to live inside Paperclip

## Rollout Recommendation

Start with a conservative first phase:

- monitor everything
- triage everything
- open draft PRs automatically
- run validation automatically
- auto-merge only clearly low-risk changes
- create opportunity proposals when confidence is high
- create capability recommendations when confidence is high
- log all actions inside `The Monitor Agency`

This provides real autonomy without giving the company unlimited power on day one.

## Non-Goals

This company should not:

- silently make risky production changes
- spam the main inbox with routine updates
- require the user to interpret technical release notes
- become a second full operational Paperclip environment

## Next Step

After design approval, the next artifact should be an implementation plan covering:

- company bootstrap
- project and agent creation
- routine setup
- GitHub and provider watch inputs
- change-classification policy
- branch and PR workflow
- test and merge policy
- escalation pipeline
