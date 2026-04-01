# Paperclip AI — Production Deployment

## What This Is

A Docker Compose-based production deployment of Paperclip, the open-source AI agent orchestration platform. The goal is to get Paperclip running in containers with its dashboard accessible, so a team of 5-20 AI agents (Claude Code, OpenClaw, Codex, Cursor) can connect and be managed from a single UI.

## Core Value

The Paperclip dashboard is running and accessible, with agents able to connect and receive tasks.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Docker Compose configuration builds and runs Paperclip (server + UI + database)
- [ ] Database is provisioned and migrations run successfully
- [ ] Paperclip server starts and serves the API
- [ ] Paperclip UI is accessible in a browser
- [ ] Agent adapters configured for Claude Code, OpenClaw, and Codex/Cursor
- [ ] Environment variables and secrets properly configured
- [ ] Health checks pass for all services

### Out of Scope

- SSL/TLS termination — not needed for initial deployment
- Monitoring/alerting stack — deferred until agents are running
- Backup automation — deferred to post-launch
- Custom plugins or extensions — vanilla install first
- Budget/cost tracking configuration — can be set up through the UI later

## Context

- Paperclip is a Node.js monorepo (pnpm workspaces) with a server, React UI, CLI, and plugin SDK
- Existing Docker infrastructure exists in the repo (`Dockerfile`, `docker/` directory)
- Database uses PostgreSQL via Drizzle ORM with migration tooling
- The codebase supports multiple agent adapters (OpenClaw, Claude Code, Codex, Cursor, Bash, HTTP)
- This is a fresh install — no existing data to migrate
- Target concurrency: 5-20 agents running simultaneously

## Constraints

- **Deployment**: Docker Compose — containerized services
- **Fresh install**: No migration path needed, clean database
- **Existing code**: Must work with the current Paperclip codebase as-is (brownfield)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Docker Compose deployment | User preference, good for self-hosted setups | — Pending |
| Multi-agent support (Claude Code + OpenClaw + Codex/Cursor) | User's agent stack | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-01 after initialization*
