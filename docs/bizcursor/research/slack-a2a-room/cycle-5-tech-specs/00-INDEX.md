# Ciclo 5 — Tech Specs (P0–P6)

> **Data:** 2026-07-09  
> **Produto:** Paperclip Conference Room (Slack-mode: humanos + `@agente` + A2A fan-out/wait/join)  
> **Implementação:** fork `/Users/macbook/Projects/paperclip` (`QuadriniL/paperclip`)  
> **BizCursor desktop:** pausado para Room (cherry-pick seletivo de trace/HITL depois)  
> **Pesquisa prévia:** Cycles 1–3 em `docs/research/slack-a2a-room/`  
> **Plano de execução:** Cycle 4 (`../cycle-4-plan/`) — quando publicado, este INDEX linka o plano mestre

---

## 1. Propósito deste ciclo

Transformar a pesquisa (protocolo, UX, verticais, gaps do fork) em **SPECs técnicas executáveis** por fase de produto **P0→P6**, com RF/RNF, MoSCoW, UX, paths absolutos no fork, smoke tests, DoD e riscos.

Cada SPEC é **autocontida** o bastante para um subagent implementar sem reler a conversa — mas assume leitura dos Cycles 1–3 para contexto de produto.

---

## 2. Mapa de fases

| Fase | Título | Spec | Status doc |
|------|--------|------|------------|
| **P0** | Foundation — auth, agentes listáveis, flag Conference Room, 1:1 baseline | [P0-foundation-SPEC.md](./P0-foundation-SPEC.md) | **Escrita** |
| **P1** | Single `@mention` + silent-until-@ + human owner (Slack-mode MVP) | [P1-single-mention-SPEC.md](./P1-single-mention-SPEC.md) | **Escrita** |
| **P2** | Fan-out `@A @B` + join (`waitAllSec`) + bridge room→A2A + trace | [P2-fanout-join-SPEC.md](./P2-fanout-join-SPEC.md) | **Escrita** |
| **P3** | Peer wait, HITL cards (`input-required`), quorum opcional vs barrier | [P3-peer-wait-hitl-SPEC.md](./P3-peer-wait-hitl-SPEC.md) | **Escrita** |
| **P4** | Cost pill hop/session, alerts 80/100 na room, densidade Operator vs Board | [P4-costs-roles-SPEC.md](./P4-costs-roles-SPEC.md) | **Escrita** |
| **P5** | Métricas da room + spike memória PARA (GO/NO-GO) | [P5-memory-metrics-SPEC.md](./P5-memory-metrics-SPEC.md) | **Escrita** |
| **P6** | Graduar flag, Coolify GA, playbooks SH/Support, docs Sofia, anti-washing | [P6-ga-playbooks-SPEC.md](./P6-ga-playbooks-SPEC.md) | **Escrita** |

> **Nota de nomenclatura:** Cycle 3 §8.A usava P3=cost e P4=memory na lente GTM. Neste Cycle 5 a numeração de **entrega técnica** é a tabela acima (P3=peer/HITL/quorum, P4=costs/roles, P5=memory+metrics, P6=GA). O conteúdo de valor é o mesmo; só o índice de fase muda.

---

## 3. Dependências (DAG)

```mermaid
flowchart LR
  P0[P0 Foundation] --> P1[P1 Slack MVP]
  P1 --> P2[P2 A2A bridge]
  P2 --> P3[P3 Peer/HITL/Quorum]
  P3 --> P4[P4 Costs/Roles]
  P4 --> P5[P5 Metrics + Memory spike]
  P5 --> P6[P6 GA + Playbooks]
```

| Aresta | Motivo |
|--------|--------|
| P0→P1 | Sem flag/agentes/auth não há sala |
| P1→P2 | Mentions UX antes do motor de fan-out |
| P2→P3 | Peer/quorum estendem join já existente |
| P3→P4 | Custo por hop precisa hops estáveis + estados |
| P4→P5 | cost/session alimenta métricas |
| P5→P6 | GA exige métricas de piloto; memória opcional |

**Paralelismo permitido:** spike de memória (P5-A) ∥ instrumentação de métricas (P5-B); docs P6 podem rascunhar em paralelo a P5 desde que DoD espere métricas.

---

## 4. Índice das SPECs neste pacote

### 4.0 P0–P2 (fundação → fan-out)

| Spec | Arquivo |
|------|---------|
| P0 Foundation | [P0-foundation-SPEC.md](./P0-foundation-SPEC.md) |
| P1 Single mention | [P1-single-mention-SPEC.md](./P1-single-mention-SPEC.md) |
| P2 Fan-out + join | [P2-fanout-join-SPEC.md](./P2-fanout-join-SPEC.md) |

### 4.1 [P3 — Peer wait, HITL, quorum](./P3-peer-wait-hitl-SPEC.md)

- Peer wait (padrão Co-Gym) event-driven sobre `run-delegation`.
- HITL cards na sala reusando `issue_thread_interactions` / approvals.
- `join: "all" | "quorum"` (Aegean) vs `waitAllSec` barrier.
- Magentic = política de turns, não port de framework.

### 4.2 [P4 — Custos e roles/density](./P4-costs-roles-SPEC.md)

- Cost pill por hop + session; alerts 80/100 **na room**.
- Operator vs Board density via `access` / memberships Paperclip.
- Reusa `costs` / `budgets` — sem ledger paralelo.

### 4.3 [P5 — Memória + métricas](./P5-memory-metrics-SPEC.md)

- Must: mentions, fan-outs, join success, cost/session + dashboard Board.
- Memória PARA: spike timeboxed GO/NO-GO; defer explícito permitido.
- Anti-claim se NO-GO.

### 4.4 [P6 — GA e playbooks](./P6-ga-playbooks-SPEC.md)

- Graduar `enableConferenceRoomChat`.
- Checklist Coolify GA.
- Playbooks Software House + Support Ops.
- Guia Sofia PT-BR + anti-washing checklist.

---

## 5. Plano de implementação (visão Cycle 4 → 5)

Quando `../cycle-4-plan/` publicar o plano mestre, linkar aqui. Até lá, ordem operacional sugerida:

| Sprint | Foco | Saída |
|--------|------|-------|
| S0 | P0 + P1 | Sala `@` + silent + owner; flag on staging |
| S1 | P2 | Human/room API + fan-out + trace |
| S2 | P3 | Peer wait + HITL cards + quorum opt-in |
| S3 | P4 | Pills + 80/100 + density |
| S4 | P5 | Metrics dashboard + memory spike report |
| S5 | P6 | GA policy + Coolify checklist + playbooks + Sofia docs |

**Execução recomendada:** subagent-driven por SPEC (um subagent por fase), com review entre fases. Skills: `subagent-driven-development` / `executing-plans`.

**Repo de código:** somente fork Paperclip paths listados em cada SPEC § Arquitetura.

---

## 6. Links para Cycles anteriores

| Ciclo | Path | Uso |
|-------|------|-----|
| 1 — Discovery | [`../cycle-1-discovery/00-INDEX.md`](../cycle-1-discovery/00-INDEX.md) | Fontes A2A/academia/indústria; decisões path B |
| 2 — Confirmation | [`../cycle-2-confirmation/00-INDEX.md`](../cycle-2-confirmation/00-INDEX.md) | Claims confirmados; gaps BoardChat / human delegate |
| 3 — Deep dive | [`../cycle-3-deep-dive/01-protocol-and-orchestration.md`](../cycle-3-deep-dive/01-protocol-and-orchestration.md) | Contrato sala vs A2A; quorum/peer |
| 3 — UX | [`../cycle-3-deep-dive/02-ux-slack-room.md`](../cycle-3-deep-dive/02-ux-slack-room.md) | Sofia/Board density; silent-until-@ |
| 3 — Verticais | [`../cycle-3-deep-dive/03-verticals-and-value.md`](../cycle-3-deep-dive/03-verticals-and-value.md) | Beachhead SH; Support; anti-hype |
| 3 — Gaps fork | [`../cycle-3-deep-dive/04-paperclip-gap-analysis.md`](../cycle-3-deep-dive/04-paperclip-gap-analysis.md) | REUSAR/ADAPTAR/CONSTRUIR + paths |
| 4 — Plan | [`../cycle-4-plan/`](../cycle-4-plan/) | Plano executável (a publicar) |

### Specs / handoffs relacionados (BizCursor)

| Doc | Path |
|-----|------|
| F2 A2A | `/Users/macbook/Projects/bizcursor/docs/phases/f2-a2a-orchestrator/SPEC.md` |
| F3 Costs | `/Users/macbook/Projects/bizcursor/docs/phases/f3-costs-budget/SPEC.md` |
| F4 PARA | `/Users/macbook/Projects/bizcursor/docs/phases/f4-para-memory/SPEC.md` |
| Handoff delegation | `/Users/macbook/Projects/bizcursor/docs/handoffs/2026-07-07-f2-native-delegation.md` |
| Fork A2A spec | `/Users/macbook/Projects/paperclip/doc/spec/agent-delegation-a2a.md` |

---

## 7. Paths âncora no fork (consulta rápida)

| Concern | Path |
|---------|------|
| `run-delegation` | `/Users/macbook/Projects/paperclip/server/src/services/run-delegation.ts` |
| Board chat route | `/Users/macbook/Projects/paperclip/server/src/routes/board-chat.ts` |
| BoardChat UI | `/Users/macbook/Projects/paperclip/ui/src/pages/BoardChat.tsx` |
| Flag Conference Room | `/Users/macbook/Projects/paperclip/ui/src/hooks/useConferenceRoomChatEnabled.ts` |
| Issue thread interactions | `/Users/macbook/Projects/paperclip/server/src/services/issue-thread-interactions.ts` |
| Costs / budgets | `/Users/macbook/Projects/paperclip/server/src/services/costs.ts`, `budgets.ts` |
| Access / roles | `/Users/macbook/Projects/paperclip/server/src/services/access.ts` |
| MCP delegate | `/Users/macbook/Projects/paperclip/packages/mcp-server/src/tools.ts` |
| Adapters | `/Users/macbook/Projects/paperclip/packages/adapters/cursor-cloud/`, `opencode-local/` |

---

## 7.1 Extensão Hybrid (Cycle 5B)

Path **B+** (Team panel, Work Request, Dual Performance, Proactivity) — SPECs em:

[`../cycle-5b-clickup-tech-specs/00-INDEX.md`](../cycle-5b-clickup-tech-specs/00-INDEX.md)

| Fase | Spec |
|------|------|
| P1.5 Work Request | [`../cycle-5b-clickup-tech-specs/P1.5-work-request-SPEC.md`](../cycle-5b-clickup-tech-specs/P1.5-work-request-SPEC.md) |
| P2.5 Hybrid Team Panel | [`../cycle-5b-clickup-tech-specs/P2.5-hybrid-team-panel-SPEC.md`](../cycle-5b-clickup-tech-specs/P2.5-hybrid-team-panel-SPEC.md) |
| P4.5 Dual Performance | [`../cycle-5b-clickup-tech-specs/P4.5-dual-performance-SPEC.md`](../cycle-5b-clickup-tech-specs/P4.5-dual-performance-SPEC.md) |
| P5.5 Proactivity Policy | [`../cycle-5b-clickup-tech-specs/P5.5-proactivity-policy-SPEC.md`](../cycle-5b-clickup-tech-specs/P5.5-proactivity-policy-SPEC.md) |

---

## 8. Critério de saída do Cycle 5

- [x] SPECs P0–P6 completas no diretório (RF, RNF, MoSCoW, UX, arquitetura, smoke, DoD, riscos)
- [x] Este INDEX com mapa P0–P6, DAG, links Cycles 1–3 e plano resumido
- [x] Cycle 5B hybrid specs linkadas (§7.1)
- [ ] Cycle 4 plan publicado e linkado na §5
- [ ] Spike memória P5: arquivo GO/NO-GO quando executado

---

## 9. Anti-hype (herdado — vale para todas as fases)

> Scoped agents, clear cycle metrics, human gate — porque &gt;40% dos projetos agentic morrem por hype, custo e risco.

Detalhe normativo: [P6 anti-washing](./P6-ga-playbooks-SPEC.md) §8.3.

**NotebookLM:** pesquisa Paperclip/Bizcursor Room — sem overlap processo Villa (CD/Stock/Financial). GO para docs técnicas.
