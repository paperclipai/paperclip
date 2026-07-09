# KPIs & Success Metrics — Path B+ Beachhead (Software Houses)

> **Ciclo:** 4C — Planning (hybrid) · agent #3  
> **Data:** 2026-07-09  
> **Produto:** Path **B+** — Conference Room + Hybrid Team & Performance  
> **Beachhead:** Software Houses (**LOCKED** — Cycle 2C verticals)  
> **Secundário:** Support Ops · **Non-goal:** Marketing / ROAS  
> **Âncoras:**  
> - Cycle 2C dual performance: [`../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md`](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md)  
> - Cycle 2C INDEX P0 set: [`../cycle-2c-hybrid-confirmation/00-INDEX.md`](../cycle-2c-hybrid-confirmation/00-INDEX.md)  
> - Cycle 2C beachhead: [`../cycle-2c-hybrid-confirmation/05-verticals-confirm.md`](../cycle-2c-hybrid-confirmation/05-verticals-confirm.md)  
> - Cycle 3C dual panels: [`../cycle-3c-hybrid-deep-dive/03-dual-performance-panels.md`](../cycle-3c-hybrid-deep-dive/03-dual-performance-panels.md)  
> - Cycle 3C gap/DAG: [`../cycle-3c-hybrid-deep-dive/05-implementation-gap-matrix.md`](../cycle-3c-hybrid-deep-dive/05-implementation-gap-matrix.md)  
> - Cycle 4B product plan: [`../cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md`](../cycle-4b-clickup-plan/00-PRODUCT-PLAN-HYBRID.md)  
> **NotebookLM:** skip (non-Villa) — product/business KPIs Path B+ Software Houses

---

## 0. Por que este doc existe

Cycle 2C **travou** o P0 metric set (7 métricas CONFIRMED) e o beachhead Software Houses. Cycle 3C **desenhou** Dual Performance fora do stream (D-11 / R-09) e o mapa de fontes Paperclip. Este doc de Cycle 4C **traduz** isso em:

1. **North-star + input metrics** de negócio para o beachhead SE.  
2. **Product KPIs** = exatamente o P0 Dual set (Human | Agent | Room).  
3. **Smoke / acceptance metrics** por fase (P0→P6 + inserts P1.5 / P2.5 / P4.5 / P5.5).  
4. **Anti-hype** — o que **recusamos** medir ou pitchar.  
5. **Instrumentation plan** — cost-events, runs, issues, HITL timestamps.

**Regra dura (herdada 2C §4):** se a métrica depende de claim **PARTIAL** → **OUT** do P0 e do north-star de produto. PARTIAL pode informar anti-hype messaging, não KPI de sucesso.

---

## 1. Beachhead context — Software Houses

### 1.1 Por que SE é o beachhead (Cycle 2C)

| Evidência | Grade 2C | Implicação de KPI |
|-----------|----------|-------------------|
| Peng lab +55,8% task speed; Demirer field +26% tasks (n=4.867) | CONFIRMED | Outcome de **throughput de issues** é mensurável — mas **não** é “autonomia %” |
| Linear: human assignee + agent delegate | CONFIRMED | Ownership humana é invariante; KPIs de accountability ≠ agent-as-assignee |
| ClickUp AI Hub ≠ Workload | CONFIRMED | Dual panel (humano \| agente) é diferencial — medir **unificação de vista**, não clone de AI Hub |
| Anti-hype METR / SWE-Bench Pro / Gartner | CONFIRMED (messaging) | Proibir “80% autonomia” e ROAS no pitch e no dashboard |

**Job-to-be-done do beachhead (Sofia / EM em software house):**

> “Ver, na mesma semana, se o time híbrido está **fechando issues** com owner humano, **custo agentic** sob controle, **intervenções HITL** honestas, e **co-touch** real — sem vanity de #agents.”

### 1.2 Personas e o que cada uma “compra” como sucesso

| Persona | Sucesso que importa | Superfície de KPI |
|---------|---------------------|-------------------|
| **Sofia (Operator / tech lead)** | Pedir trabalho à IA sem fricção; ver custo e intervenção sem sair do fluxo | Room + digest Insights |
| **EM / Board (founder, eng manager)** | Carga humano+AI, $/job, hybrid cycle time, co-touch | Team + Insights Dual |
| **IC humano** | Owner claro; Ask / assign-delegate funciona | Room / issue |
| **Agente** | N/A (não é stakeholder de KPI) | Runtime |

---

## 2. North-star + input metrics

### 2.1 North-star (negócio + produto)

**North-star Path B+ (Software Houses):**

> **Hybrid issues completed with human owner + ≥1 agent hop**, na janela de 7d, com **co-touch** e **custo médio por job** dentro do budget da company.

Formalização operacional:

| Campo | Definição |
|-------|-----------|
| **Nome** | Hybrid Throughput with Accountability (HTA) |
| **Numerador** | Issues `done` na janela com: (a) owner humano, (b) ≥1 hop agentic no histórico, (c) co-touch = true |
| **Denominador de qualidade** | Não é “todos os issues”; é o cohort híbrido — evita inflar com trabalho 100% humano |
| **Guardrails obrigatórios** | Avg Cost/job ≤ budget alert; Intervention rate monitorada (não maximizar autonomia) |
| **Unidade** | count / 7d (Sofia) · count / 30d (Board) |
| **Fonte** | issues + runs/delegation + memberships (owner) |

**Por que não “# agents” ou “% autonomia”:** Cycle 2C C2-D4-08 PARTIAL + verticals anti-hype CONFIRMED — agent washing e cancelamentos Gartner. Cycle 3C AV-5 / AV-7.

**Por que co-touch no north-star:** AAAI C2-D4-06 CONFIRMED — task reward ≠ cooperação. Throughput híbrido sem co-touch = “IA sozinha” ou “humano sozinho” (Cycle 3C §3.4).

### 2.2 Input metrics (leading indicators)

Input metrics alimentam o north-star; **não** substituem outcome.

| ID | Input metric | Lane | Por que leading | Fonte |
|----|--------------|------|-----------------|-------|
| IN-01 | Work Requests criados (Ask / assign-delegate) / 7d | Room / P1.5 | Sem pedido fácil, não há hops | work-request events |
| IN-02 | % threads com `@` explícito (vs ambient) | Room / P0–P5.5 | Silent-until-@ saudável | room messages + policy |
| IN-03 | Jobs in Progress (agora) | Agent P0-Ag-2 | Capacidade agentic saturada → CT sobe | runs |
| IN-04 | Capacity load vermelho (count members) | Human P0-Hu-2 | WIP humano alto → hybrid CT sobe | issues + memberships |
| IN-05 | Intervention count / jobs done | Agent P0-Ag-3 | Spec ruim ou policy frouxa | HITL timestamps |
| IN-06 | Fan-out joins completos / tentados | Room P2 | Orquestração A2A viva | delegation + waitAllSec |
| IN-07 | HITL cards resolvidos / abertos | Room P3 | Gate humano não emperra | issue status + HITL events |
| IN-08 | Insights views / digest opens | Insights P4.5 | EM realmente usa Dual (não só chat) | product analytics |

### 2.3 Outcome metrics (lagging — beachhead)

| ID | Outcome | Definição | Alvo piloto SE (90d) | Não confundir com |
|----|---------|-----------|---------------------|-------------------|
| OUT-01 | **HTA** (north-star) | Hybrid issues done + owner + co-touch / 7d | Tendência ↑ vs baseline 2 semanas pós-P2 | Issues totais da company |
| OUT-02 | Hybrid Cycle Time p50 | P0-Rm-1 | ↓ vs baseline human-only CT no mesmo board | Latency LLM |
| OUT-03 | Human Cycle Time p50 | P0-Hu-1 | Estável ou ↓ (não piorar por agent sprawl) | “Produtividade individual” RH |
| OUT-04 | Avg Cost / job | P0-Ag-1 | Dentro de budget; sem spike >2× sem review | Raw tokens |
| OUT-05 | Co-touch rate | P0-Rm-2 | ≥ floor acordado no piloto (ex. 30% cohort híbrido) | Success rate isolado |
| OUT-06 | Time-to-first-Ask | Mediana do 1º Work Request após onboarding | < 7 dias no piloto | Feature adoption vanity |

### 2.4 Funil de valor (como ler junto)

```
IN-01 Work Requests ──► hops agentic ──► OUT-01 HTA
         │                    │
         │                    ├── OUT-04 Avg $/job (guardrail)
         │                    ├── IN-05 Intervention (qualidade do pedido)
         │                    └── OUT-05 Co-touch (cooperação real)
         │
IN-04 Capacity load ──► OUT-02 / OUT-03 Cycle Times
IN-08 Insights usage ──► decisão de EM (não vanity dashboard)
```

---

## 3. Dual Performance P0 → Product KPIs

Espelho 1:1 de Cycle 2C confirm §4 e Cycle 3C §4. **Estes são os product KPIs canônicos** do Dual Performance Dashboard (P4.5). Nenhum KPI de produto P0 fora desta tabela.

### 3.1 Tabela canônica

| ID | Lane | Product KPI | Definição operacional | Claim 2C | UI (3C) |
|----|------|-------------|----------------------|----------|---------|
| **P0-Hu-1** | Human | Cycle Time (p50) | start→complete; owner humano; só issues que passaram in-progress (Linear) | C2-D4-02 | “Tempo até pronto (mediana)” |
| **P0-Hu-2** | Human | Capacity load | WIP assigned / capacity; G/Y/R (Workload-style) | C2-D4-01 | “Carga da equipe” |
| **P0-Ag-1** | Agent | Avg Cost / job | $ médio por job/run na janela (USD) | C2-D4-01 | “Custo médio por job” |
| **P0-Ag-2** | Agent | Jobs in Progress | Contagem de jobs/runs **ativos agora** | C2-D4-01 | “Em andamento” |
| **P0-Ag-3** | Agent | Human intervention count | Pausas/overrides HITL por run na janela | C2-D4-05 | “Quantas vezes você interveio” |
| **P0-Rm-1** | Room | Hybrid Cycle Time | open→done (ou start→complete) com ≥1 hop agentic; status selecionáveis (Jira-like) | C2-D4-02/03 | “Tempo híbrido até pronto” |
| **P0-Rm-2** | Room | Co-touch rate | % issues/threads com ≥1 ação humana **e** ≥1 ação agent | C2-D4-06 | “Trabalho em dupla” |

### 3.2 Mapeamento north-star ↔ P0

| North-star / Outcome | Depende de P0 |
|----------------------|---------------|
| HTA (OUT-01) | P0-Rm-2 (co-touch) + hops (runs) + owner (memberships) |
| OUT-02 Hybrid CT | P0-Rm-1 |
| OUT-03 Human CT | P0-Hu-1 |
| OUT-04 Cost guardrail | P0-Ag-1 |
| Capacidade (leading) | P0-Hu-2, P0-Ag-2 |
| Qualidade do pedido | P0-Ag-3 |

### 3.3 Placement (não negociável)

Herdado **D-11 LOCKED** / **R-09** (2C INDEX) e Cycle 3C §2:

| Superfície | Product KPIs Dual? |
|------------|-------------------|
| Room / BoardChat stream | **PROIBIDO** |
| Team strip (P2.5) | Só 2 KPIs Room (Hybrid CT + Co-touch) + link Insights |
| Insights `/company/:id/insights` | **CANÔNICO** — 7 KPIs |
| Costs (P4) | Ledger $; não substitui Dual |
| Digest Sofia | Snapshot ≤5 bullets → CTA Insights |

### 3.4 Targets de produto (piloto SE — não SLA de marketing)

| KPI | Sinal “saudável” (piloto) | Sinal “investigar” |
|-----|---------------------------|--------------------|
| P0-Hu-1 | CT p50 estável ou ↓ vs baseline | ↑ >25% em 14d |
| P0-Hu-2 | 0–1 members red | ≥2 red sustentados |
| P0-Ag-1 | Dentro do budget company | Spike >2× mediana 7d |
| P0-Ag-2 | < maxConcurrentRuns | Saturado contínuo |
| P0-Ag-3 | Rate estável; copy sem culpa | Rate ↑ sem mudança de volume de jobs |
| P0-Rm-1 | ≤ human CT × 1.5 no cohort híbrido | Hybrid CT >> human CT sem HITL wait |
| P0-Rm-2 | ≥ floor piloto no cohort híbrido | Throughput alto + co-touch baixo |

**Regra Cycle 3C AV-2:** `null` > fake zero. Target só se `sources.* === true`.

---

## 4. Smoke / acceptance metrics por fase

Ordem canônica (Cycle 3C INDEX / gap matrix):

```
P0 → P1 → P1.5 → P2 → P2.5 → P3 → P4 → P4.5 → P5 → P5.5 → P6
```

Cada fase tem: **métrica de aceite** (pass/fail de produto) + **instrumentação mínima** + **anti-regressão**.

### 4.1 Room core

| Fase | Acceptance metric (pass) | Smoke IDs (orientação) | Instrumentação mínima |
|------|--------------------------|------------------------|------------------------|
| **P0** | Flag on; 1:1 board↔concierge; lista agentes; **0** mensagens ambient sem `@` em teste de 24h | ST-P0-* (SPEC room) | room message events; feature flag; agent list |
| **P1** | Sofia `@CEO` → 1 wake orquestrado; composer `@` funciona; silent mantido | ST-P1-* | mention → wake link; run created_at |
| **P2** | `@A @B` → fan-out + join; DelegationTrace visível; humano **não** POST delegate no browser | ST-P2-* | delegation hops; waitAllSec result; trace UI event |

### 4.2 Hybrid inserts

| Fase | Acceptance metric (pass) | Smoke IDs | Instrumentação mínima |
|------|--------------------------|-----------|------------------------|
| **P1.5** | Qualquer member cria Work Request (Ask / assign-delegate); **owner ≠ delegate**; bridge server-side | ST-P15-* | work_request.created; owner_id; delegate_agent_id |
| **P2.5** | Um painel humanos+agentes; status; lanes v1; deep-link Ask/Room | ST-P25-* | memberships; agent roster; WIP counts; jobs now strip |
| **P4.5** | Insights com **exatamente 7** KPIs P0 (ou null+empty); **zero** Dual no stream; digest Sofia | ST-P45-01…08 (3C §10) | dual-performance API; sources flags; insights.viewed |

### 4.3 Governança + valor

| Fase | Acceptance metric (pass) | Smoke IDs | Instrumentação mínima |
|------|--------------------------|-----------|------------------------|
| **P3** | Peer wait; card `input-required`; quorum opt-in documentado | ST-P3-* | HITL card open/resolve timestamps |
| **P4** | Cost pill por hop; dual cost $ + tempo HITL; alertas budget | ST-P4-* | cost-events; HITL duration |
| **P5** | Room metrics must verdes; spike memória com veredito | ST-P5-* | room metric counters |
| **P5.5** | Policy JSON; Room **não** recebe ambient; routines fora do chat | ST-P55-* | policy.evaluate; ambient_blocked count |
| **P6** | Flag graduável; playbooks SE; anti-washing no copy; hybrid surfaces documentadas | ST-P6-* | GA checklist; playbook completion |

### 4.4 Acceptance gates de negócio (piloto beachhead)

Além de smoke técnico, o piloto SE só “passa” se:

| Gate | Critério | Quando medir |
|------|----------|--------------|
| G-SE-1 | ≥1 company SE com HTA > 0 por 2 semanas consecutivas | Pós-P2 + P1.5 |
| G-SE-2 | Avg Cost/job reportável (não null) para ≥1 agente | Pós-P4 |
| G-SE-3 | Co-touch rate calculável (não null) no cohort híbrido | Pós-P4.5 (deps P5-R) |
| G-SE-4 | EM abriu Insights ≥1× / semana no piloto | Pós-P4.5 |
| G-SE-5 | Zero claims “80% autonomia” / ROAS no material GA | P6 copy review |

### 4.5 Matriz fase × P0 KPI (quando a métrica fica “verde”)

| P0 KPI | Primeira fase que **pode** popular | Fase em que vira **Must** no Dual |
|--------|-------------------------------------|-----------------------------------|
| P0-Hu-1 | P1 (issues com start/complete) | P4.5 |
| P0-Hu-2 | P2.5 (capacity limits) | P4.5 |
| P0-Ag-1 | P4 (cost-events) | P4.5 |
| P0-Ag-2 | P2 / P2.5 (runs) | P4.5 (live) |
| P0-Ag-3 | P3 (HITL events estáveis) | P4.5 (`null` até lá — AV-2) |
| P0-Rm-1 | P2 (hops) + issues | P4.5 (após P5-R) |
| P0-Rm-2 | P1.5 + P2 (ações human+agent) | P4.5 |

---

## 5. O que recusamos medir (anti-hype)

Herdado de Cycle 2C §4 OUT + Cycle 3C §7 AV-1…AV-10 + verticals C4.

### 5.1 Ban list — nunca KPI de sucesso Path B+

| Anti-métrica | Por quê | Fonte |
|--------------|---------|-------|
| **# de agentes criados / ativos como KPI** | Agent washing; roster ≠ valor | 2C C2-D4-08 PARTIAL → anti-métrica; 3C AV-5 |
| **ROAS / AI marketing lift** | Marketing = FLUFF beachhead; não está em PRs Gartner como KPI | 2C verticals C3; C2-D4-08 |
| **“80% autonomia” / Autonomy ratio** | METR / SWE-Bench Pro; moral hazard; Won't P4.5 | 2C verticals C4; 3C AV-7 / W9 |
| **Success rate isolado como “cooperação”** | AAAI: task reward ≠ cooperação | C2-D4-06 CONFIRMED |
| **TTFT / latency p95 / raw token count** | C2-D4-04 PARTIAL; vanity sem $ | 2C OUT; 3C W3 |
| **Cost/outcome McKinsey-driven como P0** | Prescrição PARTIAL; Avg Cost já cobre $ | C2-D4-07 PARTIAL |
| **Collab Score / Initiative Entropy / Controlled Autonomy UI** | Lab CONFIRMED; pesado demais; intervention basta | C2-D4-05 notas; 3C W8 |
| **Employee score / PDI / stack rank** | Dual ≠ RH | 3C AV-4 / W4 |
| **Widgets Dual dentro do stream** | D-11 | 3C AV-9 |
| **“Substitui o EM / o time”** | Messaging lock beachhead | 4B princípios; verticals |

### 5.2 Permitido medir, mas **não** como north-star

| Métrica | Uso permitido | Uso proibido |
|---------|---------------|--------------|
| Raw token count | Debug / Costs drill-down | Card Insights / pitch |
| Error/retry rate | Ops / reliability | “Agente inteligente” vanity |
| # agents no Team roster | Inventário operacional | KPI de sucesso / marketing |
| Adoption (# users que abriram Room) | Funil onboarding | Prova de ROI agentic |
| Latency LLM | Adapter health | Dual Performance P0 |

### 5.3 Copy rules (enforcement de produto)

1. Labels Human = **“Orquestração humana”** — nunca “score” / “rating” / “PDI”.  
2. Intervention = **“intervenção HITL”** — nunca “falha do agente”.  
3. Co-touch sempre **ao lado** de Hybrid CT — proibido card “cooperação = % done”.  
4. Footer Insights: “P0 only · null > fake zero · ver anti-vanity” (3C §3.1).  
5. Pitch SE: ciclo auditável (latência de handoff, custo, gate humano) — **não** autonomia plena.

---

## 6. Instrumentation plan

### 6.1 Princípios

1. **REUSE** cost-events, runs, issues, memberships, activity — sem ledger novo (3C §5).  
2. **null > fake zero** quando fonte ausente (pré-P3 HITL, pré-P4 costs, pré-P5-R).  
3. Timestamps em **UTC ISO-8601**; durações em **ms** na API; UI em d/h.  
4. Toda agregação Dual carrega `sources: { costEvents, issues, runs, memberships, hitl }`.  
5. Product analytics (insights.viewed) **separado** de telemetria de orquestração.

### 6.2 cost-events

| Campo / evento | Uso KPI | Notas |
|----------------|---------|-------|
| `amountUsd` (ou cents) | P0-Ag-1 Avg Cost/job | REUSE `costs.ts` |
| `agentId` / `runId` / `sessionId` | Rollup por agente; drill Costs | Fork session-payload se SPEC exigir |
| `createdAt` | Janela 7d/30d/≤90d | Cap 90d (3C) |
| `companyId` | Scope Insights | Obrigatório |
| Budget alerts | Guardrail OUT-04 | P4; link Dual → Costs |

**Fórmula P0-Ag-1:**

```
avgCostPerJobUsd = sum(cost-events.amountUsd in window, agent filter)
                 / count(distinct jobs/runs done in window)
```

Se `costEvents === false` → `avgCostPerJobUsd = null`.

### 6.3 runs

| Campo / evento | Uso KPI | Notas |
|----------------|---------|-------|
| `status` ∈ running \| queued | P0-Ag-2 Jobs in Progress | Live count “agora” |
| `status` ∈ done \| failed \| cancelled | Denominador cost / intervention rate | Não misturar com “agora” |
| `agentId`, `issueId`, `startedAt`, `endedAt` | Hybrid CT cohort; hops | Ligação issue↔run |
| `delegationParentId` / hop index | Fan-out trace; ≥1 hop agentic | P2 |
| Run created sem mention (ambient) | IN-02 / P5.5 | Deve ser ~0 na Room |

**Fórmula P0-Ag-2:**

```
jobsInProgress = count(runs where status in {running, queued} now)
```

### 6.4 issues

| Campo / evento | Uso KPI | Notas |
|----------------|---------|-------|
| `createdAt` | Lead time (opcional Should; não P0) | Linear lead = create→complete |
| `startedAt` / transition to in-progress | P0-Hu-1 Cycle Time start | Excluir never in-progress |
| `completedAt` / done | CT end; HTA numerador | |
| `assigneeId` (human owner) | Accountability; HTA | D-12 — owner nunca some |
| `delegateAgentId` (se existir) | Work Request / assign-delegate | P1.5 |
| Status history | Hybrid CT com colunas Jira-like | Could P4.5 C2 |
| Action history (comment / run / work-request) | P0-Rm-2 co-touch | human ∧ agent |

**Fórmulas:**

```
cycleTimeP50Ms = percentile_50(completedAt - startedAt)
  where owner is human AND passed in-progress

hybridCycleTimeP50Ms = same clock
  where count(agent hops|runs on issue) >= 1

coTouchRate = count(issues in window with ≥1 human action AND ≥1 agent action)
            / count(issues in window in cohort)
```

Cohort default piloto: issues tocados na Room ou com Work Request / delegation — documentar no SPEC P4.5.

### 6.5 HITL timestamps

| Evento | Timestamp | Uso |
|--------|-----------|-----|
| `hitl.opened` (`needs_you` / input-required) | `openedAt` | Card P3; wait time |
| `hitl.resolved` (approve / reject / provide input) | `resolvedAt` | IN-07 |
| `hitl.pause` / `hitl.override` / human take-over | `intervenedAt` | **P0-Ag-3** |
| Work Request human follow-up | `followedUpAt` | Qualidade do pedido (Should) |

**Fórmula P0-Ag-3:**

```
interventionCount = count(hitl.pause|override|takeover in window)
interventionRate  = interventionCount / count(jobs done in window)  // display only
```

Se `sources.hitl === false` → `interventionCount = null` (ST-P45-04).  
**HITL duration** (P4 dual cost): `sum(resolvedAt - openedAt)` — input metric / cost dual; **não** substitui P0-Ag-3.

### 6.6 memberships & capacity

| Campo | Uso |
|-------|-----|
| Member role / type (human vs agent) | Roster P2.5; filtros Dual |
| `capacityLimit` (WIP max) | P0-Hu-2 |
| Active assignments count | WIP numerator |

```
load = wip / capacityLimit → green | yellow | red (thresholds company)
```

### 6.7 Product analytics (meta-KPIs)

| Evento | Uso |
|--------|-----|
| `insights.viewed` | G-SE-4; IN-08 |
| `digest.opened` | Sofia engagement |
| `team_panel.opened` | Adoção P2.5 |
| `work_request.created` | IN-01 |
| `ambient_blocked` | P5.5 health |

Não misturar esses eventos com cost-events.

### 6.8 API Dual (contrato de instrumentação)

Herdado Cycle 3C §5.3 — fronteira tipada:

```ts
// Conceitual — implementação P4.5 SPEC
DualPerformanceSchema = {
  window: { from, to },
  refreshedAt: string,
  human: {
    cycleTimeP50Ms: number | null,
    capacity: { green: number, yellow: number, red: number, members: [...] },
  },
  agent: {
    avgCostPerJobUsd: number | null,
    jobsInProgress: number | null,
    interventionCount: number | null,
    byAgent: [...],
  },
  room: {
    hybridCycleTimeP50Ms: number | null,
    coTouchRate: number | null, // 0..1
  },
  sources: {
    costEvents: boolean,
    issues: boolean,
    runs: boolean,
    memberships: boolean,
    hitl: boolean,
  },
}
```

**Refresh (3C §6):** on navigate + manual ↻ Must; polling 30–60s **só** Jobs in Progress com tab Agent visível Should.

### 6.9 Ordem de instrumentação (DAG)

```
P0  message + flag events
P1  mention→wake + run link
P1.5 work_request + owner/delegate ids
P2  delegation hops + join results
P2.5 memberships capacity + roster status
P3  HITL opened/resolved/intervene timestamps   ← desbloqueia P0-Ag-3 ≠ null
P4  cost-events + HITL duration                 ← desbloqueia P0-Ag-1 ≠ null
P5  room metrics must                           ← desbloqueia P0-Rm-* robustos
P4.5 dual-performance aggregate API + Insights UI
P5.5 policy.evaluate + ambient_blocked
P6  playbook + GA checklist events
```

---

## 7. Cadência de leitura (quem olha o quê)

| Cadência | Persona | KPIs | Ação se ruim |
|----------|---------|------|--------------|
| **Diário (ops)** | Sofia | IN-01, P0-Ag-2, HITL abertos | Desbloquear cards; ajustar Ask |
| **Semanal** | Sofia + EM | Digest: HTA, P0-Ag-1, P0-Rm-1/2, capacity reds | Abrir Insights; rebalancear |
| **Quinzenal piloto** | EM | Gates G-SE-1…4; trends 14d | Go/No-go expansão agentes |
| **Mensal** | Board | OUT-01…05; budget; anti-hype copy audit | Renovar budget / playbooks |

---

## 8. Riscos de medição e mitigação

| Risco | Mitigação |
|-------|-----------|
| Dual vira RH de humanos | AV-4; sem stack rank; labels de orquestração |
| Vanity creep no PR (“só mais um card”) | Gate: só IDs P0-Hu/Ag/Rm no Dual v1 |
| Intervention mal instrumentado → 0 falso | null até P3 estável (ST-P45-04) |
| HTA inflado com issues triviais | Cohort híbrido documentado; floor de hops |
| Co-touch gamed (comment vazio) | v1: qualquer ação; v2 Could: ação substantiva (fora P0) |
| Insights sem uso (dashboard morto) | G-SE-4; digest CTA; Team strip link |
| Medir Marketing ROAS “só um pouco” | Non-goal LOCKED — recusar no backlog |

---

## 9. Checklist de pronto (este doc)

- [x] North-star HTA + input/outcome para Software Houses  
- [x] 7 product KPIs = P0 Dual Cycle 2C (citado)  
- [x] Smoke/acceptance por fase P0–P6 + inserts  
- [x] Anti-hype ban list (2C OUT + 3C AV)  
- [x] Instrumentation: cost-events, runs, issues, HITL timestamps  
- [x] Placement D-11 / R-09 respeitado  
- [x] Gates de piloto G-SE-1…5  

---

## 10. Entrega

| Campo | Valor |
|-------|-------|
| **Path** | `docs/research/slack-a2a-room/cycle-4c-hybrid-plan/02-kpi-and-success-metrics.md` |
| **Cita 2C** | `04-dual-performance-confirm.md` §4 P0; `00-INDEX.md` R-09/D-11; `05-verticals-confirm.md` beachhead |
| **Cita 3C** | `03-dual-performance-panels.md` layout/sources/AV/smoke; `05-implementation-gap-matrix.md` DAG fases |
| **Próximo** | SPEC P4.5 / plano executável sem expandir P0; espelho `writing-plans` se Cycle 4C consolidar |
