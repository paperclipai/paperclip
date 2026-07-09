# Ciclo 1B — Descoberta ClickUp Hybrid (Humanos + IA)

> **Data:** 2026-07-09  
> **Foco:** Painel tipo ClickUp para gerir equipe humana **e** equipe de IA proativa; humanos pedem trabalho à IA com facilidade; performance clara para ambos.  
> **Subagents:** ~10 em paralelo

## Achados-chave

1. **ClickUp = referência PRIMARY** — Super Agents como users (`@mention` / assign / DM); Autopilot = proativo por trigger; AI Hub = roster do time AI (jobs, avg cost, schedules); Workload = humanos. **Gap ClickUp:** não unifica capacity humano+AI num só Workload.
2. **Oportunidade Paperclip:** ser o híbrido que ClickUp não unificou — roster + workload lanes + cost rail + dual performance.
3. **Fork hoje:** forte em agentes (org, runs, costs, routines); fraco em humanos (só Members + UserProfile); **sem** painel workforce unificado; BoardChat ≠ gestão.
4. **Pedido fácil:** stack `@mention` + assign-as-delegate + botão “Pedir ao agente” + templates (Linear/Claude Tag/ClickUp).
5. **Proatividade:** schedule / event / threshold / ambient — ambient **fora** da Room (silent-until-@); routines/webhooks/Autopilot fora do chat.
6. **Métricas dual:** Outcome + Collaboration + Reliance + Agent health + Cost + Human orchestration + Risk (Magentic/Co-Gym/McKinsey/Deloitte/Google Cloud + enterprise command centers).
7. **Prior research gap:** Cycles 1–5 cobriam Slack+A2A; faltava Team panel, work intake, dual performance, ClickUp matrix.

## Decisões a registrar (D-09+)

| ID | Decisão |
|----|---------|
| D-09 | Path **B+**: Conference Room + **Hybrid Team & Performance** (não só chat) |
| D-10 | Proatividade **governada** (triggers whitelist); default Room = silent-until-@ |
| D-11 | Painéis de performance **fora do stream** (aba Team / Insights), dual Humano \| Agente |
| D-12 | Assign-as-delegate (Linear): humano = owner; agente = delegate |
| D-13 | AI Hub-like roster + Workload-like lanes no mesmo produto |

## Próximo

- **Feito (produto):** Ciclo 4B — [`../cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md`](../cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md) (Path B+, D-09…D-13).
- **Feito (docs):** Ciclo 5B tech specs — [`../cycle-5b-clickup-tech-specs/00-INDEX.md`](../cycle-5b-clickup-tech-specs/00-INDEX.md) (P1.5 / P2.5 / P4.5 / P5.5).
- Opcional: Ciclo 2B — confirmar claims ClickUp/AI Hub/Workload e métricas enterprise antes da implementação H0.