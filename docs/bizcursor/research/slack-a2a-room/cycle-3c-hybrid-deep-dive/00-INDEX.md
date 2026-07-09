# Cycle 3C — Deep Dive INDEX (Path B+ Hybrid)

> **Data:** 2026-07-09  
> **Método:** 5 subagents · design docs grounded em Cycle 2C CONFIRMED only  
> **Pré-requisito:** [`../cycle-2c-hybrid-confirmation/00-INDEX.md`](../cycle-2c-hybrid-confirmation/00-INDEX.md)

## Documentos

| # | Arquivo | Escopo | ~Linhas |
|---|---------|--------|---------|
| 1 | [`01-hybrid-team-panel-ux.md`](./01-hybrid-team-panel-ux.md) | Team tab roster + lanes (D-13, R-03) | ~490 |
| 2 | [`02-human-work-request-flows.md`](./02-human-work-request-flows.md) | `@` / Ask / assign-delegate / bridge (P1.5) | ~600 |
| 3 | [`03-dual-performance-panels.md`](./03-dual-performance-panels.md) | Dual metrics P0 fora do stream (P4.5) | ~430 |
| 4 | [`04-proactivity-governance.md`](./04-proactivity-governance.md) | silent-until-@ + routines whitelist (P5.5) | ~500 |
| 5 | [`05-implementation-gap-matrix.md`](./05-implementation-gap-matrix.md) | REUSE/ADAPT/BUILD + DAG fases | ~550 |

## Síntese para Cycle 4

**Ordem canônica de entrega:**
```
P0 → P1 → P1.5 → P2 → P2.5 → P3 → P4 → P4.5 → P5 → P5.5 → P6
```

**BUILD críticos:** room-orchestrator, human-delegate bridge, Hybrid Team Panel, Dual Performance UI, proactivity-policy, DelegationTrace UI.

**REUSE:** run-delegation A2A, cost-events, routines/cron/webhook, memberships, MarkdownEditor mentions, Agents/OrgChart pieces.

**Beachhead:** Software Houses · **Secondary:** Support · **Non-goals:** Marketing ROAS, 80% autonomia, Plane-style agent-as-assignee.

## Exit gate

- [x] 5 deep-dive docs  
- [x] Gap matrix + DAG  
- [ ] Plano faseado → **Cycle 4C**
