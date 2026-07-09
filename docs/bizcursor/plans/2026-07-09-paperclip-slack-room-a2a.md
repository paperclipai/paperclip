# Paperclip Conference Room (Slack + @agents + A2A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Checkboxes (`- [ ]`) in each phase DoD are the tracking surface. **Do not start coding until Cycle 5 tech specs exist** (`docs/research/slack-a2a-room/cycle-5-tech-specs/`). Specs híbridas (P2.5 / dual cost / dual performance) devem seguir Cycle 5B ou extensão das SPECs P1/P4/P5/P6.

**Goal:** Entregar no fork `QuadriniL/paperclip` Path **B+**: Conference Room estilo Slack (silent-until-@, wake real, fan-out/join A2A, HITL) **mais** Hybrid Team & Performance (roster, workload lanes, dual costs, dual performance, Team mgmt) — beachhead Software Houses.

**Architecture:** Path B+ (Slack+@ **+** Team/Insights) só no fork Paperclip (BizCursor desktop pausado). Mentions/Ask orquestram `paperclipDelegate` / `wait:false`+`waitAllSec`; A2A fan-out é app-level. Team Panel unifica humano+AI (gap ClickUp). Feature flag Coolify-safe; DelegationTrace Board-first; performance **fora** do stream.

**Tech Stack:** Paperclip fork (Board Web + control plane), adapters `opencode_local` / `cursor_cloud`, Coolify deploy, A2A task states nativos, cost-events, membership humano+agente.

**Canonical research (Cycle 4 sala):** [`docs/research/slack-a2a-room/cycle-4-plan/00-PRODUCT-PLAN.md`](../research/slack-a2a-room/cycle-4-plan/00-PRODUCT-PLAN.md)  
**Canonical research (Cycle 4B híbrido — autoritativo para B+):** [`docs/research/slack-a2a-room/cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md`](../research/slack-a2a-room/cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md)

---

## UPDATE 2026-07-09 B+: Hybrid Team & Performance

> **Status:** merge ativo — este plano operacional agora segue Path **B+** (D-09…D-13).  
> **Fonte canônica do produto híbrido:** [`docs/research/slack-a2a-room/cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md`](../research/slack-a2a-room/cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md)  
> **Descoberta:** [`docs/research/slack-a2a-room/cycle-1b-clickup-discovery/00-INDEX.md`](../research/slack-a2a-room/cycle-1b-clickup-discovery/00-INDEX.md)

### O que mudou vs Cycle 4 (só sala)

| Antes (Path B) | Agora (Path B+) |
|----------------|-----------------|
| P0–P6 = Room/A2A | **Mantém P0–P3** Room/A2A core |
| P1 = single `@` + cost pill | **P1 expandido:** Ask button + assign-as-delegate (D-12) |
| — | **NOVO P2.5:** Team Panel hybrid roster + workload lanes (D-13) |
| P4 = $/thread | **P4 expandido:** dual costs ($ agentic + tempo HITL humano) |
| P5 = PARA + weekly KPIs | **P5 expandido:** Dual Performance Dashboard (humano \| agente \| room) (D-11) |
| P6 = playbooks GA | **P6 expandido:** + Team management para Sofia |
| ~17 semanas | ~**20 semanas** |

### Decisões novas (travadas)

| ID | Decisão |
|----|---------|
| **D-09** | Path **B+**: Room + Hybrid Team & Performance |
| **D-10** | Proatividade governada (whitelist); Room = silent-until-@ |
| **D-11** | Performance **fora do stream** (Team / Insights) |
| **D-12** | Assign-as-delegate: humano = owner; agente = delegate |
| **D-13** | Roster AI Hub-like + Workload lanes no mesmo produto |

### Ordem de fases B+

```text
P0 → P1 (+Work Request) → P2 → P2.5 (Team Panel) → P3 → P4 (dual cost) → P5 (Dual Performance) → P6 (GA + Team mgmt)
```

Agentes de implementação: para detalhe de goal / DoD / métricas / cenários SE (EM vê humano+AI), usar o doc Cycle 4B. As seções abaixo foram **estendidas** para refletir B+; em conflito, **4B ganha**.

---

# Plano de Produto — Paperclip Path B+ (Room + Hybrid Team)

> **Ciclo:** 4 + **4B** — Planning  
> **Data:** 2026-07-09  
> **Produto:** Conference Room Slack + `@agents` + A2A **e** Hybrid Team & Performance (lente ClickUp)  
> **Repo de implementação:** `QuadriniL/paperclip` (fork-only)  
> **BizCursor desktop:** **pausado**  
> **Fonte canônica híbrida:** [`docs/research/slack-a2a-room/cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md`](../research/slack-a2a-room/cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md)  
> **Fonte canônica sala (Cycle 4):** [`docs/research/slack-a2a-room/cycle-4-plan/00-PRODUCT-PLAN.md`](../research/slack-a2a-room/cycle-4-plan/00-PRODUCT-PLAN.md)

**NotebookLM (pré-plano):** overlap Villa CD/Stock/Financial/Sales = **não** · **GO** para planejar fora do processo Villa.

---

## 0. Sumário executivo

Construir, no Board do Paperclip (Coolify), um **sistema híbrido** onde:

1. Humanos e agentes coexistem em canais/threads (UX Slack / Claude Tag / Linear Agents).
2. Agentes ficam **silent-until-@** — só acordam quando mencionados (ou via Ask / assign-delegate).
3. `@A @B` dispara **fan-out A2A app-level** com **join** — não “mentions mágicas”.
4. Aba **Team** unifica roster + workload lanes (humano + AI) — gap que o ClickUp não fechou.
5. Custo **dual** ($ agentic + tempo HITL), Dual Performance (humano \| agente \| room) e owner humano — anti-hype Gartner.

**Não** vendemos autonomia 80%, ROAS mágico, “substitui o time”, nem AI Hub clone. Vendemos **ciclo de trabalho híbrido auditável**.

---

## 1. Contexto e decisões travadas

### 1.1 Decisões de produto (Decision Log)

| ID | Decisão | Status | Rationale (pesquisa) |
|----|---------|--------|----------------------|
| **D-01** | **Path B** — Slack + `@agents` (não Manus 1:1 puro) | Travada | Cycle 1: UX Linear/Slack/Teams; Cycle 2: Claude Tag / multiplayer async |
| **D-02** | **Fork-only** — implementação em `QuadriniL/paperclip` | Travada | Cycle 1 D4; BizCursor desktop pausado |
| **D-03** | **A2A fan-out é app-level** — orquestração Paperclip sobre N SendMessage/delegate; A2A ≠ sala | Travada | Cycle 1 D1 (spec v1.0.0); Cycle 2 claim confirmado |
| **D-04** | Reusar `run-delegation` + MCP `paperclipDelegate` + `wait:false` / `waitAllSec` | Travada | Cycle 2: fan-out+join **já existe**; falta bridge sala → A2A |
| **D-05** | Beachhead **Software Houses**; Support **secundário**; Marketing **não beachhead** (FLUFF ROAS) | Travada | Cycle 3 §2–§5 |
| **D-06** | Default **SAS → cascade MAS**; paralelo só com **quorum** (não barrier cego) | Travada | Cycle 2 (Gao / Aegean) |
| **D-07** | Humano owner sempre visível; silent-until-@ | Travada | Cycle 2 UX; Cycle 3 DoD beachhead |
| **D-08** | Wake via path **Coolify-safe** (`adapter_wake` / flag feature) — sem quebrar deploy | Travada | Cycle 1/2 gaps BoardChat + Coolify |
| **D-09** | Path **B+**: Room + Hybrid Team & Performance | Travada | Cycle 1B ClickUp; Cycle 4B |
| **D-10** | Proatividade **governada**; Room = silent-until-@ | Travada | Cycle 1B; anti-spam Gartner |
| **D-11** | Performance **fora do stream** (Team / Insights); dual Humano \| Agente \| Room | Travada | Cycle 1B |
| **D-12** | Assign-as-delegate: humano = owner; agente = delegate | Travada | Linear pattern; Cycle 1B |
| **D-13** | Roster AI Hub-like + Workload lanes no mesmo produto | Travada | Gap ClickUp capacity híbrida |

### 1.2 O que já existe vs. o que falta

| Capacidade | Estado no fork | Gap de produto |
|------------|----------------|----------------|
| `paperclipDelegate` / `run-delegation` | Implementado | Bridge a partir da sala |
| Fan-out `wait:false` + `waitAllSec` | Implementado | Trigger por `@A @B` no BoardChat |
| Mentions em issues | Wakeup independente | ≠ A2A join |
| BoardChat | Sempre concierge, sem `@` | Mentions + silent-until-@ + Ask |
| Humano POST delegate | Bloqueado (só agent JWT) | Room orchestrator no servidor (não Board JWT “fake agent”) |
| Modelo de sala + peer wait | Ausente | P0–P3 |
| Cost pill / budget na sala | Parcial (F3-ish no ecossistema) | P1 / P4 |
| DelegationTrace na sala Board | Ausente (existe rascunho no BizCursor pausado) | P2 no Board UI |
| Workforce unificado (humano+AI) | **Ausente** | **P2.5** Team Panel |
| Dual cost ($ + HITL time) | **Ausente** | **P4 expandido** |
| Dual Performance Dashboard | **Ausente** | **P5 expandido** |
| Team management Operator | **Ausente** | **P6 expandido** |

### 1.3 Princípios de entrega (anti-hype)

> Gartner (25 jun 2025): **>40%** dos projetos agentic cancelados até fim de 2027 — custos, valor unclear, risk controls fracos, “agent washing”.  
> McKinsey Agentic Mesh: orquestração + governança + trust humano; evitar agent sprawl.  
> ClickUp: AI Hub ≠ Workload unificado — oportunidade Paperclip B+.

**Tradução em DoD de produto:** escopo estreito por fase · KPIs de ciclo **e** capacidade híbrida · human gate · custo dual visível · performance fora do stream · sem claim de autonomia plena.

---

## 2. Roadmap visual (P0 → P6 + P2.5 B+)

```mermaid
gantt
    title Path B+ Room + Hybrid Team — Roadmap
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section Room core
    P0 Silent-@ + Coolify-safe           :p0, 2026-07-14, 14d
    P1 Single @ + Work Request           :p1, after p0, 21d
    P2 Fan-out + join + Trace UI         :p2, after p1, 21d

    section Hybrid Team
    P2.5 Team Panel roster + lanes       :p25, after p2, 14d

    section Governança
    P3 Peer wait + HITL cards            :p3, after p25, 21d
    P4 Dual costs $ + HITL time          :p4, after p3, 21d

    section Valor contínuo
    P5 Dual Performance + PARA           :p5, after p4, 21d
    P6 GA playbooks + Team mgmt          :p6, after p5, 21d
```

```text
P0 Foundation ──► P1 @ + Ask/assign ──► P2 Fan-out/Join ──► P2.5 Team Panel
                                                                      │
                         Software House beachhead (EM vê humano+AI) ◄──┤
                         Support secundário ◄─────────────────────────┤
                                                                      ▼
                                              P3 HITL ──► P4 Dual cost ──► P5 Dual Perf ──► P6 GA+Team
```

| Fase | Nome | Duração alvo | Valor de negócio (1 linha) |
|------|------|--------------|----------------------------|
| **P0** | Foundation — Silent-until-@ & Coolify path | **2 semanas** | Sala segura sem spam; deploy não quebra |
| **P1** | Single @ + **Work Request** (Ask / assign-delegate) | **3 semanas** | Pedir trabalho à IA sem fricção; owner humano |
| **P2** | Fan-out & Join — `@A @B` + DelegationTrace | **3 semanas** | Spike paralelo auditável (diferencial A2A) |
| **P2.5** | **Team Panel** — roster híbrido + lanes | **2 semanas** | EM vê carga humano+AI no mesmo painel |
| **P3** | Peer Wait & HITL — quorum + input-required | **3 semanas** | Governança enterprise (approvals no thread) |
| **P4** | **Dual costs** — $ agentic + tempo HITL + density | **3 semanas** | ROI honesto (máquina + atenção humana) |
| **P5** | **Dual Performance** + PARA light + weekly | **3 semanas** | Dashboard humano \| agente \| room |
| **P6** | Polish GA — playbooks + **Team mgmt Sofia** | **3 semanas** | Pacotes vendáveis + gestão de time híbrido |

**Horizonte total:** ~**20 semanas** (~5 meses) até GA B+ — sujeito a Coolify/ops e design partners.

---

## 3. Personas e superfícies

| Persona | Precisa ver | Densidade UI |
|---------|-------------|--------------|
| **Operator** (Sofia / tech lead) | Narrativa, Ask, cards, custo resumido, **gestão leve do Team** | Baixa–média |
| **Board / EM** (founder / eng manager) | Trace, **carga humano+AI**, dual cost, Dual Performance, risco | Alta |
| **Humano IC** | Ask / assign, owner badge, cards | Baixa |
| **Agente** | Prompt + contexto da thread + tools MCP | N/A (runtime) |

**Superfícies:** Board Web — Room (stream) + **Team** + **Insights** (fora do stream, D-11). BizCursor desktop = fora de escopo.

---

## 4. Fases detalhadas

---

### P0 — Foundation: Silent-until-@, Mentions no BoardChat, Coolify-safe

**Duração:** 2 semanas  
**Goal:** Fazer o BoardChat respeitar `@mentions` com agentes **silent-until-@**, via path de wake **seguro no Coolify** (`adapter_wake` + feature flag), sem fan-out ainda.

#### Business value
Elimina o anti-padrão “concierge responde tudo” e o risco de acordar agentes em loop no deploy. Sem P0, qualquer demo Slack vira spam e custo — exatamente o que Gartner aponta como cancelamento.

#### Cenários por vertical (mais fortes)

| Vertical | Cenário P0 | Por que importa agora |
|----------|------------|------------------------|
| **Software House (obrigatório)** | Canal `#eng-bugs`: humano posta sem `@` → nenhum agente responde; só log humano | Prova silent-until-@ no beachhead |
| **Support** | `#support-l1`: ticket webhook posta resumo; agentes silenciosos até lead `@triage-support` | Evita auto-reply sem owner |
| **Content/Marketing (guardrail)** | `#campaign-ops`: drafts humanos sem acordar `@copy` | Gate de brand desde o dia 1 |
| **Supply chain (early)** | `#procurement-exceptions`: alerta ERP na sala, sem wake automático | War room passiva até limiar humano |
| **Finance AP** | `#ap-exceptions`: fatura na fila, silent até `@extract` | Compliance: nada executa sozinho |

#### Functional scope
- Feature flag `conference_room_v1` (default off em prod Coolify; on em staging).
- Parser de `@agentSlug` / `@agentName` no BoardChat (composer + render).
- Política **silent-until-@**: mensagem sem mention → zero wakeup de agente.
- Path de wake Coolify-safe: `adapter_wake` (ou equivalente documentado no fork) — **não** reintroduzir paths que quebram allowlist/HTTP.
- Persistência de membership: canal ↔ agentes mencionáveis.
- Telemetria mínima: `mention_parsed`, `wake_skipped_silent`, `wake_attempted`.
- Docs de ops: como ligar flag no Coolify sem downtime.

#### Out of scope
- Fan-out `@A @B`, join, peer wait.
- Cost pill, DelegationTrace UI.
- Conectores ERP/CRM.
- Qualquer mudança no BizCursor desktop.
- Autonomia de merge/publish.

#### DoD checklist (testável)
- [ ] Flag off → comportamento legado (concierge) inalterado em smoke Coolify.
- [ ] Flag on + mensagem sem `@` → **0** heartbeat runs criadas (assert em API/logs).
- [ ] Flag on + `@ceo olá` → **1** wake do agente CEO (não concierge genérico), run visível no thread.
- [ ] `@nome-inexistente` → erro UX claro, sem wake.
- [ ] Deploy Coolify staging verde; healthcheck + BoardChat load < regressão acordada.
- [ ] Teste unitário do parser de mentions (slug, case, multi-byte).
- [ ] Runbook P0 publicado no fork (`docs/` do Paperclip).

#### Dependencies
- Acesso deploy Coolify do Paperclip fork.
- Inventário de agentes reais (CEO `opencode_local`, Dev `cursor_cloud`) no company de staging.
- Decisão D-08 (adapter_wake) implementável sem fork upstream.

#### Risks
| Risco | Mitigação |
|-------|-----------|
| Wake path quebra allowlist Coolify | Feature flag + canary; rollback = flag off |
| Parser ambíguo (`@dev` vs user humano) | Namespaces / autocomplete só de agentes membership |
| Concierge legado ainda “rouba” a mensagem | Gate explícito: se mention válida → bypass concierge |

#### Success metrics
| Métrica | Alvo P0 |
|---------|---------|
| False wakes (sem `@`) | **0** em suite de regressão |
| Time-to-wake após `@` (p50 staging) | < 5s até run `running` |
| Incidentes de deploy ligados à flag | **0** em staging |

---

### P1 — Single @agent + Work Request: Ask / assign-delegate + cost pill

**Duração:** 3 semanas  
**Goal:** Humano acorda agente real **e** pede trabalho com fricção mínima — botão **Ask / Pedir ao agente**, **assign-as-delegate** (D-12: humano owner + agente delegate), cost pill, owner visível.

#### Business value
Primeiro “aha” vendável **e** intake híbrido (Cycle 1B): tech lead não precisa lembrar sintaxe `@`; EM vê owner ≠ delegate. Alinha Peng/Copilot **com** METR nuance — pitch honesto.

#### Cenários por vertical

| Vertical | Cenário P1 | Valor |
|----------|------------|-------|
| **Software House (obrigatório)** | EM/tech lead: **Ask** em issue “checkout 500” → picker `@triage`; assign-delegate: Sofia owner + `@coder` delegate | Time-to-first-triage; carga ownership clara |
| **Software House** | Ask `@coder` template “implemente spec” → draft + link PR | Time-to-first-diff |
| **Support** | Ask `@triage-support` no ticket; owner = lead humano | 1ª resposta estruturada |
| **Content (guardrail)** | Ask `@brief` — **proibido** KPI ROAS | Ops only |
| **SC early** | Ask `@triage-sc` read-only | Exception triage |
| **Finance AP** | Ask `@extract` sem approve automático | STP prep |

#### Functional scope
- Resolve mention → `agentId` membership; wake do agente nomeado (não concierge).
- Resposta no mesmo thread; cost pill; cancel; rate limit; autocomplete `@`.
- **Ask / Pedir ao agente:** CTA composer/issue → picker → template opcional → wake.
- **Assign-as-delegate (D-12):** `ownerUserId` + `delegateAgentId` ambos na UI.
- Templates leves SE: triage bug, implement spec, review draft.

#### Out of scope
- `@A @B` / join (P2); Team Panel (P2.5); Dual Performance (P5); cards HITL ricos (P3).

#### DoD checklist (testável)
- [ ] ST: `@ceo` / `@dev` → wake real; concierge **não** responde.
- [ ] Botão Ask → picker → 1 wake; owner humano gravado.
- [ ] Assign-delegate: owner humano + delegate agente visíveis.
- [ ] Cost pill (ou `pending`); cancel < 10s; rate limit 4º wake/min.
- [ ] ≥5 threads SE staging; messaging sem SWE-Bench 90%.

#### Dependencies
- P0 completo; agentes CEO/Dev saudáveis; endpoint custo/run (ou stub).

#### Risks
| Risco | Mitigação |
|-------|-----------|
| Wake cai no concierge | Assert `agentId` no DoD |
| Custo indisponível | Pill `pending`; não bloquear P1 |
| Ask sem adoção | Medir % wakes via Ask; iterar CTA |

#### Success metrics
| Métrica | Alvo P1 (piloto 2 semanas) |
|---------|----------------------------|
| Threads com wake real | ≥ **20** |
| % wakes via Ask | ≥ **30%** |
| % delegações com owner+delegate | ≥ **50%** |
| Mediana time-to-first-agent-message | < **90s** |
| NPS tech leads (1–5) | ≥ **4** (n≥5) |

---

### P2 — Fan-out & Join: `@A @B` + waitAllSec + DelegationTrace UI

**Duração:** 3 semanas  
**Goal:** `@A @B` na sala dispara fan-out A2A app-level (`wait:false` + join `waitAllSec`) e o Board mostra **DelegationTrace** (árvore parent/children) no thread.

#### Business value
Diferencial competitivo vs. “só chatbot com mentions”: spike paralelo com auditoria (quem rodou, status, join). Desbloqueia SH-2 (OAuth spike) e Support L1 multi-agent — valor Cycle 3 §2.3 / §3.2.

#### Cenários por vertical

| Vertical | Cenário | A2A pattern |
|----------|---------|-------------|
| **Software House** | SH-2: `@researcher @coder @security` avaliar OAuth; join; humano decide | Paralelo + join |
| **Software House** | SH-1: `@triage @coder` bug prod; triage pode cascade antes de coder (SAS→MAS) | Cascade default |
| **Support** | CS-1: `@triage-support @policy @refund-agent` | Paralelo + limiar $ |
| **Content** | `@brief @copy @brand-check` — brand-check **sempre** no join antes de publish | Paralelo + gate |
| **SC early** | `@triage-sc @buyer @planner` | Paralelo read-mostly |
| **Finance AP** | `@extract @match` (approver só em P3) | Paralelo 2-way |

#### Functional scope
- Parser multi-mention ordenado; política: **todos mencionados veem o mesmo prompt de sala**.
- Orquestrador de sala → N `paperclipDelegate` / equivalent com `wait:false`.
- Join: `waitAllSec` configurável por canal (default documentado, ex. 600s).
- Política default: **cascade** quando dependência explícita (`wait @coder after @triage`); senão paralelo.
- **DelegationTrace** no Board: status agregado, children, expand Board / narrativa Operator.
- Cancel pai → cancel cascata (já no fork; expor na UI da sala).
- Eventos de sala: `fanout_started`, `child_completed`, `join_done`, `join_timeout`.

#### Out of scope
- Quorum parcial (N-of-M) — isso é P3.
- Peer wait agente↔agente sem humano.
- Budget hard-stop (P4).
- Reimplementar cliente A2A JSON-RPC no browser.

#### DoD checklist (testável)
- [ ] `@A @B` → **2** child runs com `parentRunId` comum; ambos recebem contexto da mensagem.
- [ ] Join completa quando ambos `completed` → mensagem de síntese/estado no thread.
- [ ] `waitAllSec` expirado → estado `join_timeout` visível; children canceláveis.
- [ ] DelegationTrace lista children com status ao vivo (poll).
- [ ] Cascade: `@triage then @coder` (sintaxe acordada) → coder só após triage terminal.
- [ ] ST Software House SH-2 em staging com 3 agentes.
- [ ] Zero heurística “detect delegation no texto” — só estado nativo `GET …/delegation` (ou equivalente Board).
- [ ] Testes de contrato do orquestrador (unit + 1 integration staging).

#### Dependencies
- P1 (single wake confiável).
- APIs de delegation já no fork (Cycle 2 confirmado).
- UI Board capaz de embutir painel de trace (design tokens existentes).

#### Risks
| Risco | Mitigação |
|-------|-----------|
| Barrier cego (espera o mais lento sempre) | Default cascade; paralelo só com timeout + UI |
| Custo 3× em fan-out | Soft warning no composer (“3 agentes ≈”); hard budget em P4 |
| Trace diverge do runtime | Fonte única: API delegation; sem parser de markdown |

#### Success metrics
| Métrica | Alvo P2 |
|---------|---------|
| Fan-outs bem-sucedidos (join ok) / tentativas | ≥ **85%** em staging |
| Threads SH com fan-out documentado | ≥ **10** |
| Tempo mediano join (2 agentes opencode/cursor mix) | baseline medido + relatório |
| % traces com 100% children refletidos | **100%** |

---

### P2.5 — Team Panel: Hybrid roster + Workload lanes

**Duração:** 2 semanas  
**Goal:** Aba **Team** com roster híbrido (humanos + agentes) e **lanes de workload** no mesmo painel (D-13), fora do stream (D-11).

#### Business value
Fecha o gap ClickUp (AI Hub ≠ Workload unificado). Diferencial B+: EM responde “quem está carregado — pessoas e agentes?” sem sair do Board.

#### Cenários por vertical

| Vertical | Cenário P2.5 | Por que importa |
|----------|--------------|-----------------|
| **Software House (obrigatório)** | EM: lane Sofia (issues + HITL); lane `@coder` (runs active, avg $); `@triage` idle | EM **vê carga humano+AI** |
| **Support** | Agentes L1 saturados vs humanos VIP | Balanceamento híbrido |
| **Content** | `@brand-check` com role gate no roster | Papel visível |
| **SC / AP** | Read-only agents vs approver humano | Segregação de deveres |

#### Functional scope
- Lista unificada `kind: human | agent`; status, jobs, avg cost, adapter, routines (read-only).
- Lanes: humano (issues owned, HITL abertos) + agente (runs active/queued).
- Deep-link lane → thread/run; filtros canal/role/status.
- Sem ambient Autopilot na Room (D-10).

#### Out of scope
- Dual Performance trends (P5); HRIS; capacity drag-and-drop avançado.

#### DoD checklist (testável)
- [ ] Team lista ≥1 humano + ≥1 agente staging.
- [ ] Lanes alinhadas à API (assert IDs); deep-link correto.
- [ ] Filtro por canal; stream **sem** widgets de performance.
- [ ] EM script “quem está saturado?” < **60s**.

#### Dependencies
- P2 (runs/delegation reais para popular lanes de agentes).

#### Risks
| Risco | Mitigação |
|-------|-----------|
| Roster vira página morta | Deep-links + uso semanal no DoD |
| Confundir com Insights | P2.5 = capacity **agora**; trends = P5 |

#### Success metrics
| Métrica | Alvo P2.5 |
|---------|-----------|
| Tempo EM “quem está livre?” | < **60s** |
| % agentes membership no roster | **100%** |
| Discrepância lane vs API | **0** |
| Uso Team por EM piloto | ≥ **3×/semana** |

---

### P3 — Peer Wait & HITL: input-required + quorum policy

**Duração:** 3 semanas  
**Goal:** Agentes podem **esperar peers** e **pedir input humano** via cards no thread; join usa **quorum**; timestamps HITL alimentam P4; Team lane mostra “waiting on {human}”.

#### Business value
Torna o produto enterprise-safe: Klarna-híbrido (Support), AP approvals, brand gates. Sem HITL cards, o Board não compra — Gartner “risk controls inadequados”. Sem instrumentação de tempo, dual cost (P4) fica cego.

#### Cenários por vertical

| Vertical | Cenário | HITL / quorum |
|----------|---------|---------------|
| **Software House (obrigatório)** | `@coder` pede approve; EM vê card **e** lane Team “HITL waiting on Sofia” | Card approve/reject/revise |
| **Support** | CS-2: escalation VIP; refund > limiar pede card | Always-human option |
| **Content** | `@brand-check` **bloqueia** publish até humano | Gate obrigatório |
| **SC early** | PO > $10k → card buyer humano | $ threshold |
| **Finance AP** | variance > limiar → `@approver` + card | **0** ações acima limiar sem humano |

#### Functional scope
- `input-required` → Human Card; peer wait; quorum `all` \| `n_of_m` \| `any_primary`.
- Re-silent após escalation; audit log; limiares ferramentas perigosas.
- Instrumentação: `hitl_card_opened_at`, `hitl_card_resolved_at`.
- Team Panel: badge waiting on human.

#### Out of scope
- BPMN; SOX pack; voice recruiting; autonomia merge em `main`.

#### DoD checklist (testável)
- [ ] Card obrigatório em `input-required`; approve/reject/revise.
- [ ] Quorum `2_of_3` testado; refund simulado > limiar sem approve = bloqueado.
- [ ] Timestamps HITL persistidos; lane Team reflete card aberto.
- [ ] Audit JSON; CS-1+CS-2 smoke; doc quorum por vertical.

#### Dependencies
- P2 + P2.5 (lanes); membership/roles approver.

#### Risks
| Risco | Mitigação |
|-------|-----------|
| Cards ignorados | SLA reminder + escalate-to-owner |
| Deadlock peer wait | Ciclo detect + break com card humano |
| Over-engineering BPM | Só 3 ações de card; YAGNI |

#### Success metrics
| Métrica | Alvo P3 |
|---------|---------|
| % ações perigosas com approve | **100%** |
| Tempo mediano card → decisão | < **4h** horário comercial |
| Deadlocks peer-wait / semana | **0** |
| Support: % escalations com resumo | ≥ **90%** |

---

### P4 — Dual costs: $ agentic + tempo HITL + density

**Duração:** 3 semanas  
**Goal:** Cada thread/sala mostra **custo dual** — (1) **$ / tokens** agentic; (2) **minutos-humano HITL** — budgets, densidade Operator/Board, CSV.

#### Business value
Resposta direta ao Gartner (custos / valor unclear). Tokens sozinhos **subestimam** o preço (atenção do EM). Dual cost = pitch honesto para renovar piloto.

#### Cenários por vertical

| Vertical | Uso dual cost |
|----------|---------------|
| **Software House (obrigatório)** | Spike: $12 agentic + 45 min HITL Sofia — EM corta PoC caro em atenção | Decisão baseada em dual cost |
| **Support** | $/ticket + min humano VIP vs L1 | Escala híbrida |
| **Content** | $/campanha ops + min brand-check | Ops only (não ROAS) |
| **SC / AP** | $/exception + tempo approver no audit | Compliance |

#### Functional scope
- Agregar cost-events → `$/thread`, `$/canal`.
- Agregar HITL wait/resolve → `hitl_minutes` por thread/canal/semana.
- Pill dual Operator; tabela Board com colunas separadas.
- Budget $ soft/hard; alerta soft se HITL p50 > limiar.
- Export CSV dual; toggle densidade Operator/Board.
- **Não** monetizar salário — só tempo.

#### Out of scope
- FinOps multi-cloud; chargeback; auto-otimização de modelo.

#### DoD checklist (testável)
- [ ] Thread mostra $ (ou partial) **e** HITL minutes (0 se nenhum card).
- [ ] Hard budget bloqueia wake; CSV com `$` + `hitl_minutes`.
- [ ] Toggle densidade persiste; DoD “Board vê custo + HITL” = true.

#### Dependencies
- P1 cost pill; P3 timestamps HITL; P2 para fan-out $ fazer sentido.

#### Risks
| Risco | Mitigação |
|-------|-----------|
| Custos incompletos por adapter | Marcar `partial`; não inventar |
| Hard stop frustra demo | Bypass admin auditado |

#### Success metrics
| Métrica | Alvo P4 |
|---------|---------|
| % threads com $ known/partial | **100%** |
| % threads com HITL time known (incl. 0) | **100%** |
| Canais SE com budget $ | ≥ **1** |
| Decisão de corte PoC com dual cost | ≥ **1** documentada |

---

### P5 — Dual Performance Dashboard + PARA light + weekly value

**Duração:** 3 semanas  
**Goal:** Dashboard **Dual Performance** (filtros **Humano \| Agente \| Room**) fora do stream (D-11) + PARA light + weekly value.

#### Business value
Sem métricas dual, o EM não governa o sistema híbrido; sem PARA, cada `@` reexplica o repo. Fecha capacidade (P2.5) + custo (P4) + **resultado**.

#### Cenários por vertical

| Vertical | Memória / métrica |
|----------|-------------------|
| **Software House (obrigatório)** | Insights: Humano (HITL p50 Sofia) · Agente (`@coder` success/$ ) · Room (time-to-first-diff, join %, HITL %) | Weekly value sem slideware |
| **Support** | Macros/KB; KPI 1ª resposta < 2 min | Híbrido Klarna |
| **Content** | Brand voice; % brand-check — sem ROAS | Guardrail |
| **SC** | Playbook limiares $ | Exceptions |
| **AP** | Vendor prefs; queue time | Compliance |

#### Functional scope
- Insights: Outcome + Collaboration + Reliance + Agent health + Cost + Human orchestration + Risk — só acionáveis.
- PARA light scoped por canal; teto tokens; baseline wizard; opt-out.
- Weekly report exportável; deep-link Team lanes.
- **Proibido:** productivity score único opaco humano+AI.

#### Out of scope
- RAG enterprise completo; auto-tuning; voice memory como claim causal.

#### DoD checklist (testável)
- [ ] Três filtros Humano \| Agente \| Room com dados staging.
- [ ] EM compara Sofia vs `@coder` em < **2 min**.
- [ ] PARA no próximo `@`; opt-out; weekly 1 semana real.
- [ ] Sem PII Support em agregados; sem widgets de perf no stream.

#### Dependencies
- P1–P4 + P2.5; design partner SE para baseline.

#### Risks
| Risco | Mitigação |
|-------|-----------|
| Memória polui prompt | Teto tokens + pin manual |
| Vanity charts | Só KPIs Cycle 3/1B acionáveis |

#### Success metrics
| Métrica | Alvo P5 (piloto 30–60d) |
|---------|-------------------------|
| Time-to-first-diff vs baseline | **−40%** (n≥10) |
| Handoffs fora do canal | **−50%** |
| Weekly Insights aberto pelo EM/Board | ≥ **1×/semana** |
| % PRs com testes citados | ≥ **70%** |

---

### P6 — Polish GA + Vertical Playbooks + Team management (Sofia)

**Duração:** 3 semanas  
**Goal:** Endurecer GA (a11y, vazios, i18n) + playbooks SE/Support (+ early SC/AP) **incluindo gestão de Team** para Operator/Sofia + proatividade governada documentada (D-10).

#### Business value
Oferta empacotável: montar **time híbrido** (sala + roster + budgets + Ask templates + Insights) em < 1 dia — não só “ligar chat”.

#### Cenários por vertical (playbooks)

| Playbook | Inclui | Não inclui |
|----------|--------|------------|
| **Software House GA** | Canais, agentes, **Team seed**, budgets dual, quorum, Ask templates, Insights baseline | Autonomia merge; “−FTE” |
| **Support Ops** | L1/VIP, always-human, Team lanes | “−700 FTE” |
| **Content Ops (guardrail)** | brand-check; KPIs ops | ROAS/ROI mídia |
| **SC Exceptions (early)** | limiares $; read-only planner | Autonomia PO |
| **Finance AP** | extract/match/approver; 0 above-threshold sem humano | STP 100% claim |

#### Functional scope
- Onboarding Room + **Team**: membership humano; attach agente; roles (owner, approver, operator).
- Sofia: budget, quorum, templates Ask; **pausar agente** (no new wakes).
- Whitelist triggers proativos **fora** da Room (routines/webhooks) — sem ambient chat.
- A11y AA; i18n PT-BR/EN; ST-ROOM + ST-TEAM no CI; seed JSON executável.
- Flag default on novos companies; anti-hype no playbook (D-09…D-13).

#### Out of scope
- Marketplace; mobile nativo; reativar BizCursor; HRIS sync completo; Marketing ROAS pack.

#### DoD checklist (testável)
- [ ] Playbook SE: company limpa → Room+Team+Insights < **30 min**.
- [ ] Sofia pausa agente → Ask/wakes bloqueados.
- [ ] ST-ROOM + ST-TEAM CI verdes; a11y teclado Team+Ask+HITL.
- [ ] Claims FLUFF = 0 no material; BizCursor continua pausado (explícito).

#### Dependencies
- P0–P5 estáveis; 1 design partner SE (+ Support ou 2º SE).

#### Risks
| Risco | Mitigação |
|-------|-----------|
| Playbook slideware | Seed JSON no DoD |
| Scope creep vertical | Early SC/AP = appendix |

#### Success metrics
| Métrica | Alvo P6 |
|---------|---------|
| Time-to-first-value (SE + Team) | < **1 dia** |
| Bugs P0/P1 no GA | **0** |
| Design partners ativos | ≥ **2** |
| Claims FLUFF | **0** |

---

## 5. Matriz fase × vertical (desbloqueio B+)

| Fase | Software House | Support Ops | Content (guardrails) | SC early | Finance AP |
|------|----------------|-------------|----------------------|----------|------------|
| P0 | silent demo | silent fila | silent drafts | alerta passivo | fila passiva |
| P1 | **@ + Ask + assign-delegate** | Ask triage | brief Ask | triage Ask | extract Ask |
| P2 | **spikes paralelos** | L1 multi-agent | brief+copy+brand | triage paralelo | extract+match |
| **P2.5** | **EM vê humano+AI load** | balance L1/VIP | roles gate | segregação | approver visível |
| P3 | review gates + lane HITL | **híbrido VIP** | **brand block** | $ cards | **approver cards** |
| P4 | **dual $ + HITL min** | $/ticket + min | $/campanha ops | $/exception | audit dual |
| P5 | **Dual Performance** | KPI <2 min | % brand-check | playbooks | queue −30% |
| P6 | **playbook + Team mgmt** | **playbook GA** | appendix guardrail | early appendix | appendix pós-gov |

---

## 6. Métricas norte (produto B+)

Alinhadas a Cycle 3 + Cycle 1B/4B — **não** autonomy theater:

| Norte | Definição | Onde vive |
|-------|-----------|-----------|
| Time-to-first-diff | humano bug → 1º PR link no thread | P5 Room |
| EM capacity clarity | tempo para “quem está livre (humano+AI)?” | P2.5 |
| Dual cost coverage | % threads com $ **e** HITL time known | P4 |
| Human gate integrity | % ações perigosas com approve | P3 |
| Work request adoption | % wakes via Ask / assign-delegate | P1 |
| Join reliability | fan-out join ok / tentativas | P2 |
| False wake rate | wakes sem `@` | P0 |
| Dual performance cadence | Insights aberto ≥1×/semana pelo EM | P5 |

---

## 7. Anti-hype Gartner / McKinsey / ClickUp (obrigatório em pitch)

### 7.1 Gartner — >40% projetos agentic cancelados até 2027
- **Fonte:** [Gartner PR, 25 jun 2025](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)
- **Motivos:** custo, valor unclear, risk controls, hype/PoC, agent washing.
- **Nosso antídoto:** P0 flag/canary · P1 Ask+owner · P2.5 capacity honesta · P3 HITL · P4 **dual** cost · P5 Dual Performance · P6 playbooks sem FLUFF · D-10 sem ambient spam.

### 7.2 McKinsey — Agentic mesh + gen-AI paradox
- **Fontes:** [Seizing the agentic AI advantage](https://www.mckinsey.com/capabilities/quantumblack/our-insights/seizing-the-agentic-ai-advantage) · [Agentic AI Mesh](https://medium.com/quantumblack/how-we-enabled-agents-at-scale-in-the-enterprise-with-the-agentic-ai-mesh-architecture-baf4290daf48)
- **Antídoto:** poucos agentes com owner · A2A + Team roster como mesh · trust via cards · sem sprawl antes de P4/P6 pause.

### 7.3 ClickUp — lição competitiva
- Não copiar AI Hub **separado** do Workload; unificar roster + lanes (D-13).

### 7.4 Frase de pitch (única B+)
> “Sala Slack com `@agents` auditáveis **e** painel onde o EM vê carga, custo ($ + tempo humano) e performance de pessoas e agentes — porque >40% dos projetos agentic morrem por hype, custo e risco; não vendemos autonomia, vendemos ciclo híbrido visível.”

### 7.5 Claims proibidos
- “Resolve 80% dos bugs sozinho”
- “Substitui 700 agentes” / “−700 FTE” / “substitui o EM”
- “+X% ROAS com agentes”
- “Gartner 50% SCM” como proof of value Phase 1
- “SWE-Bench 90% = produção”
- “Productivity score” único opaco humano+AI
- Autopilot ambient na Room como default
- Jabarian voice lift como feature Slack

---

## 8. Citações de pesquisa (Cycles 1–4B)

| Doc | Uso neste plano |
|-----|-----------------|
| [`cycle-1b-clickup-discovery/00-INDEX.md`](../research/slack-a2a-room/cycle-1b-clickup-discovery/00-INDEX.md) | D-09…D-13; ClickUp PRIMARY; Ask stack; dual metrics |
| [`cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md`](../research/slack-a2a-room/cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md) | **Canônico B+** — fases, DoD, métricas híbridas |
| [`cycle-4-plan/00-PRODUCT-PLAN.md`](../research/slack-a2a-room/cycle-4-plan/00-PRODUCT-PLAN.md) | Base sala P0–P6 |
| [`cycle-1-discovery/00-INDEX.md`](../research/slack-a2a-room/cycle-1-discovery/00-INDEX.md) | Path B; fork-only; A2A app-level |
| [`cycle-2-confirmation/00-INDEX.md`](../research/slack-a2a-room/cycle-2-confirmation/00-INDEX.md) | Claims; `waitAllSec`; UX Claude/Linear; quorum |
| [`cycle-3-deep-dive/03-verticals-and-value.md`](../research/slack-a2a-room/cycle-3-deep-dive/03-verticals-and-value.md) | Beachhead SE; anti-hype; matriz vertical |
| [`docs/handoffs/2026-07-07-f2-native-delegation.md`](../../handoffs/2026-07-07-f2-native-delegation.md) | Contrato delegation; BizCursor pausado |

**Próximo ciclo sugerido:** Cycle 5 / 5B — tech specs Room + P2.5 Team + dual cost + Dual Performance em `docs/research/slack-a2a-room/cycle-5-tech-specs/` (estender ou pasta `cycle-5b-`).

---

## 9. Governança de execução

| Papel | Responsabilidade |
|-------|------------------|
| Product / founder | Prioridade B+, design partners, claims |
| Eng fork Paperclip | P0–P6 + P2.5 no Board; Coolify |
| Ops Coolify | Flags, canary, rollback |
| Design partner SE (EM) | Baseline carga + Insights semanais |
| Operator Sofia | Team mgmt no GA; templates Ask |
| Agentes de implementação | Seguir este plano + Cycle 4B; **não** reabrir D-01…D-13 sem ADR |

**Commits / PRs:** só no fork Paperclip para este roadmap. BizCursor: freeze salvo hotfixes críticos pré-acordados.

**Critério para pausar o roadmap:** se P1 não atingir wakes reais em staging em 3 semanas → stop e reavaliar adapter_wake.  
**Critério pausa B+:** se P2.5 não permitir ao EM “quem está livre?” em < 60s → não marketingar “híbrido ClickUp”.

---

## 10. Veredito Cycle 4 + 4B

1. Path **B+** (~20 semanas) entrega GA beachhead **Software House** com Room **e** Hybrid Team — playbook Support secundário.
2. Valor Room em **P1** (Ask); diferencial A2A em **P2**; diferencial ClickUp-gap em **P2.5**; enterprise gate em **P3**; sobrevivência comercial em **P4–P5** dual; Team mgmt em **P6**.
3. BizCursor desktop permanece **pausado**; DelegationTrace e Team/Insights são **Board-first**.
4. Cycle 5/5B detalha contratos sem reabrir Path B+ / fork-only / app-level fan-out / D-09…D-13.
5. Em conflito entre Cycle 4 sala e Cycle 4B híbrido → **4B ganha**.

---

*Documento atualizado Cycle 4B Hybrid · 2026-07-09 · PT-BR*

---

## Execution handoff

**Plan complete (B+).** Duas opções de execução (após Cycle 5/5B tech specs):

1. **Subagent-Driven (recomendado)** — um subagent fresco por fase/tarefa; review entre fases (`superpowers:subagent-driven-development`).
2. **Inline Execution** — executar na sessão com checkpoints (`superpowers:executing-plans`).

**Ordem:** P0 → P1 → P2 → **P2.5** → P3 → P4 → P5 → P6. Não pular fases. Não reabrir D-01…D-13 sem ADR. Canônico híbrido: `cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md`.
