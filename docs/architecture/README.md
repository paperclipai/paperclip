# Paperclip Architecture

## System Overview

Paperclip is a human-governed autonomous infrastructure platform. It combines agent orchestration, security scanning (QSL), marketplace operations (CrawDaddy), and institutional governance into a unified system.

## Core Subsystems

### QSL (Quality Security Layer)

Security finding scanner with persistent review state. Findings are ingested from bridge adapters, deduplicated, and presented for human review. Review decisions (approve, deny, escalate, suppress) are stored durably in the database.

- Review persistence: `server/src/` (QSL finding routes and services)
- Bridge integration: findings ingested and reconciled against existing DB state
- Active queue filtering: reviewed findings excluded from active queues

### Agent Runtime

Multi-provider agent execution with liveness monitoring. Agents run against company-scoped contexts with heartbeat tracking, staleness detection, and deadlock recovery.

- Liveness: tiered staleness (4h warning, 12h auto-recovery)
- Continuation guards: prevent recursive execution loops
- Watchdog: snooze-capped monitoring with telemetry

### Provider Routing

Abstraction layer for multi-provider LLM execution. Currently Stage 0 (foundation only — no live routing).

- Stage 0: type definitions, error codes, routing abstraction ✅
- Stage 1: logging-only observation mode ⬜
- Stage 2: live fallback with quota-aware scheduling ⛔ (blocked on backup validation)

### Board Intelligence / Governance

Structured export system for operational state. Produces governance packets, company maps, agent rosters, and issue triage views for board review.

- Export service: `server/src/services/board-export.ts`
- CLI: `server/scripts/generate-board-export.ts`
- API: `/api/board-export`
- Outputs: `board_exports/`

### Backup / Recovery

Institutional backup and disaster recovery framework. Backup structure is in place; end-to-end restore validation is pending.

## Hardening Order

The system follows a deliberate hardening sequence:

```
1. Persistence          — durable state before autonomous action
2. Liveness/Deadlock    — detect failures before adding complexity
3. Adapter Correctness  — correct interfaces before routing through them
4. Provider Routing     — staged: foundation → logging → live fallback
5. Backup/Recovery      — validated restore before relying on failover
```

## Infrastructure

Production EC2:

```
ssh -i "C:\Users\mikeb\.ssh\clawdbot-clean.pem" ubuntu@3.20.79.143
```

## Governance Documentation

- [Institutional History](../institutional-history/) — session logs and checkpoints
- [Master Governance Chronicle](../institutional-history/master-governance-chronicle.md) — milestone record
- [Board Exports](../../board_exports/README.md) — export system documentation
