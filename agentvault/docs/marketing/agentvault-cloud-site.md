# agentvault.cloud marketing site plan (v1.0)

This document defines a launch-ready content and information architecture plan for `https://agentvault.cloud`.

## Goals

1. Explain AgentVault in under 30 seconds.
2. Convert visitors into active users with a direct install flow.
3. Publish trustworthy docs for teams evaluating long-term adoption.
4. Provide immediate paths for backup/recovery and operational confidence.

## Primary audiences

- **Indie agent builders**: want a fast start and clear commands.
- **AI engineers**: need architecture details, deployment patterns, and reliability guidance.
- **Teams and operators**: need security, backup, and recovery guarantees.

## Site map

- `/` — Landing page (product narrative + CTA)
- `/install` — Install + bootstrap instructions
- `/skills/clawdbot-claude` — Simple skill workflow for install/bootstrap/backup
- `/tutorial` — End-to-end v1.0 hands-on tutorial
- `/docs` — Full documentation index (v1.0)
- `/docs/*` — Task- and topic-based references
- `/pricing` (optional placeholder if OSS + hosted plans are expected)
- `/changelog` — Release notes and roadmap markers

## Landing page content outline (`/`)

### Hero

- **Headline**: "Run sovereign AI agents that stay online and recoverable."
- **Subheadline**: "AgentVault packages local agents, deploys to ICP canisters, and preserves reconstructible state for resilient automation."
- **Primary CTA**: "Install AgentVault"
- **Secondary CTA**: "Read v1.0 tutorial"

### Trust + proof bar

- Open source repository link
- Supported chains list (ICP, Ethereum, Solana, Polkadot)
- "Built for backup and rebuild" callout

### How it works (3-step cards)

1. Package your agent.
2. Deploy to ICP.
3. Observe, backup, and restore with confidence.

### Value blocks

- **Autonomy**: 24/7 canister runtime.
- **Reconstructibility**: fetch state + restore workflows.
- **Operational tooling**: health checks, monitoring, and rollback primitives.

### Footer links

- Docs, tutorial, CLI reference, GitHub, security policy, release notes.

## Install page outline (`/install`)

1. Prerequisites (Node.js, npm, optional dfx for deployment).
2. Install command.
3. Initialize project.
4. Package + deploy.
5. First health/status checks.

Include explicit copy/paste snippets and expected output examples.

## SEO and metadata recommendations

- Title pattern: "AgentVault — [Page Name]"
- Description: include "on-chain AI agents", "deployment", "backup", "restore"
- OpenGraph/Twitter cards:
  - Product screenshot or architecture diagram
  - concise summary
- Schema.org:
  - `SoftwareApplication`
  - `TechArticle` for docs/tutorial pages

## Analytics and conversion events

Track at minimum:

- `install_cta_clicked`
- `docs_opened`
- `tutorial_started`
- `skill_instructions_copied`
- `backup_command_copied`

## Initial launch checklist

- [ ] Domain and TLS configured for `agentvault.cloud` and `www.agentvault.cloud`
- [ ] Redirect policy decided (`www` -> apex or apex -> `www`)
- [ ] Core pages published (`/`, `/install`, `/tutorial`, `/docs`, `/skills/clawdbot-claude`)
- [ ] Broken-link and mobile responsiveness checks complete
- [ ] Search console + analytics configured
- [ ] Version badge visible as `v1.0`
