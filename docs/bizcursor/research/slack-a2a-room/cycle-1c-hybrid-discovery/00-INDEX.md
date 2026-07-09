# Cycle 1C — Discovery INDEX (Path B+ Hybrid)

> **Data:** 2026-07-09  
> **Método:** `five-cycle-research` · 5 subagents paralelos  
> **NotebookLM:** skip (non-Villa) — pesquisa produto Paperclip/ClickUp hybrid  
> **Foco:** Painel híbrido humanos + IA (ClickUp-like) + Room Slack + performance dual

## Catálogos

| # | Arquivo | Escopo | Fontes / itens |
|---|---------|--------|----------------|
| 1 | [`01-clickup-ai-human-sources.md`](./01-clickup-ai-human-sources.md) | ClickUp Super/Autopilot/AI Hub/Workload/Cursor | 32 |
| 2 | [`02-competitor-hitl-sources.md`](./02-competitor-hitl-sources.md) | Linear, Claude Tag, Cursor, Asana, GitHub… | 32 |
| 3 | [`03-paperclip-fork-capability-catalog.md`](./03-paperclip-fork-capability-catalog.md) | Fork REUSE/ADAPT/BUILD | ~68 capacidades |
| 4 | [`04-dual-performance-sources.md`](./04-dual-performance-sources.md) | Métricas Human\|Agent\|Room | 30 |
| 5 | [`05-verticals-hybrid-panel-sources.md`](./05-verticals-hybrid-panel-sources.md) | Beachhead verticals | 24 |

**Total fontes externas ≈ 118** (+ catálogo de código).

## Achados-chave (ainda NÃO confirmados)

1. ClickUp prova **AI as teammate** (@ / assign / DM) + AI Hub, mas **não unifica** Workload humano + AI no mesmo painel → oportunidade Path B+.
2. Linear: **delegate ≠ assignee** (humano permanece responsável) — padrão accountability.
3. Claude Tag: anyone-can-tag / anyone-can-steer — acessibilidade de pedido à IA.
4. Fork Paperclip: motor A2A **REUSE**; bridge sala→A2A, Hybrid Panel, dual performance, human-delegate-bridge = **BUILD**.
5. Humano **não** pode `POST .../delegate` (só agent JWT) — precisa bridge server-side.
6. Proatividade: Routines/webhooks **REUSE**; Room deve permanecer silent-until-@; falta `proactivity-policy`.
7. Métricas dual: AI Hub (cost/jobs) + Workload (humano) existem separados na indústria; taxonomia Human\|Agent\|Room = hipótese.
8. Beachhead: **Software Houses STRONG**; Support secundário; Marketing **FLUFF**.

## Decisões tentativas (travar no Cycle 2/4)

| ID | Tentativa | Depende de |
|----|-----------|------------|
| D-09 | Path B+ | confirmar gap ClickUp unificação |
| D-10 | Room silent-until-@; proatividade fora | Autopilot ≠ Super; routines fork |
| D-11 | Performance fora do stream | dual metrics sources |
| D-12 | Assign-as-delegate (owner humano) | Linear + ClickUp Cursor |
| D-13 | Roster + workload lanes unificados | AI Hub + Workload gap |

## Open questions → Cycle 2

- Confirmar quotes ClickUp Super vs Autopilot, AI Hub fields, Workload agents-absent.
- Confirmar Linear delegate vs assignee + Claude Tag multiplayer.
- Confirmar no código: wait:false/waitAllSec, POST delegate 403 board, ChatComposer sem @.
- Confirmar taxonomia métricas mínima P0 (quais KPIs são PRIMARY).
- Confirmar beachhead SE com evidência (não só opinião).

## Exit gate

- [x] 5 catálogos em disco  
- [x] INDEX  
- [ ] Claims ainda não graded → **próximo: Cycle 2C**
