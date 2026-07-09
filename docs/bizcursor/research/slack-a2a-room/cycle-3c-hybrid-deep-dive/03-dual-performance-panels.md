# Dual Performance Dashboard — Human | Agent | Room (Path B+)

> **Ciclo:** 3C — Hybrid deep dive (agent #3)  
> **Data:** 2026-07-09  
> **Âncora:** **somente** métricas **P0** do Cycle 2C INDEX (CONFIRMED)  
> **Confirmação:** [`cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md`](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md) (score **5/8 CONFIRMED**)  
> **INDEX P0:** [`cycle-2c-hybrid-confirmation/00-INDEX.md`](../cycle-2c-hybrid-confirmation/00-INDEX.md) § P0 Dual Metrics  
> **Decisões LOCKED:** **D-11** (performance fora do stream), D-09 (Path B+), D-13 (roster+workload)  
> **Requisito promovido:** **R-09** — Dual performance fora do stream  
> **Fase de implementação:** **P4.5** (após P4 costs + P5-R room metrics)  
> **SPEC espelho:** [`cycle-5b-clickup-tech-specs/P4.5-dual-performance-SPEC.md`](../cycle-5b-clickup-tech-specs/P4.5-dual-performance-SPEC.md)  
> **NotebookLM:** skip (non-Villa) — product/tech research Path B+ metrics

---

## 0. Por que este doc existe

Cycle 2C **travou** o P0 metric set mínimo — e **só** isso entra no Dual Performance Dashboard v1:

| Lane | Métricas P0 (CONFIRMED only) | Claim(s) |
|------|------------------------------|----------|
| **Human** | Cycle Time p50 · Capacity load | C2-D4-02, C2-D4-01 |
| **Agent** | Avg Cost/job · Jobs in Progress · Intervention count | C2-D4-01, C2-D4-05 |
| **Room** | Hybrid Cycle Time · Co-touch rate | C2-D4-02/03, C2-D4-06 |

Fonte autoritativa: [`04-dual-performance-confirm.md`](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md) §4 (P0 metric set) + INDEX 2C § P0 Dual Metrics.

**OUT explícito (não desenhar em P4.5 v1):** ROAS, #agents vanity, TTFT, latency p95, raw token count, “80% autonomia”, Collab Score / Initiative Entropy como KPI de produto, cost/outcome McKinsey-driven, success rate isolado como “cooperação”. Ver §7 anti-vanity e confirm §4 OUT table.

Este deep dive **projeta layout, fontes Paperclip, refresh e MoSCoW** para P4.5 — sem expandir o catálogo além do P0 CONFIRMED.

---

## 1. Job-to-be-done

> “Provar, **fora do chat**, se o time híbrido está fluindo (humano), custando e sendo intervindo (agente), e colaborando de verdade (room) — com números honestos e ações claras.”

| É | Não é |
|---|--------|
| Dashboard de **orquestração** dual (3 tabs) | Performance review RH / stack ranking |
| Superfície **Insights** (D-11) | Widgets no BoardChat / Room stream |
| Agregação de cost-events + issues + runs + memberships | Novo billing ledger |
| Prova semanal Sofia + vista densa Board | Marketing lift / ROAS |

---

## 2. Placement — D-11 LOCKED (fora do stream)

### 2.1 Regra dura

**D-11** (Cycle 2C INDEX, LOCKED): painéis de performance **fora do stream**.

| Superfície | Dual Performance? | Motivo |
|------------|-------------------|--------|
| Room / BoardChat stream | **PROIBIDO** | Stream = narrativa A2A; KPIs poluem atenção (R-09) |
| Aba **Team** (P2.5) | Strip **somente** 2 KPIs Room (Hybrid CT + Co-touch) — link “Ver Insights” | Strip ≠ dashboard; ver [`01-hybrid-team-panel-ux.md`](./01-hybrid-team-panel-ux.md) |
| Página **Insights** / Dual Performance | **CANÔNICO** | Tabs Human \| Agent \| Room + densidades |
| Costs page (P4) | Link cruzado; **não** substitui | Costs = ledger; Insights = orquestração |
| Digest Sofia (in-app) | Snapshot semanal → CTA “Abrir Insights” | Operator, não Board dense |

### 2.2 Rota e flag

| Decisão | Valor |
|---------|-------|
| Rota | `/company/:id/insights` (ou tab Dual em Dashboard existente) |
| Feature flag | `enableDualPerformanceV1` |
| Escape | Header: “Abrir sala” / “Abrir Team” — nunca embutir stream |
| Densidade default | Sofia = cards + digest; Board = tabelas + CSV |

**Implicação UX:** nenhum card P0, sparkline ou tabela dual aparece **dentro** de bolhas, composer ou timeline da Room. Custo por hop (P4) permanece pill local na bolha — isso **não** é Dual Performance.

---

## 3. Layout canônico — tabs Human | Agent | Room

### 3.1 Shell da página Insights

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Insights · Acme Co          Janela: [7d ▾] [30d] [custom]   Densidade: Sofia|Board
│ Fontes: cost-events · issues · runs · memberships     Atualizado: há 2 min ↻
├─────────────────────────────────────────────────────────────────────────────┤
│ [ Human ]  [ Agent ]  [ Room ]                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  (conteúdo da tab ativa — ver §3.2–3.4)                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ Footer: “P0 only · null > fake zero · ver anti-vanity”                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Regras de shell:**

1. **Três tabs first-class** — Human | Agent | Room (não Overview genérico no v1 P0; Overview Sofia fica no digest, não como 4ª tab obrigatória).  
2. **Range picker** Must: 7d / 30d / custom ≤90d.  
3. **Refresh** explícito + timestamp (ver §6).  
4. **Empty state honesto** se fonte ausente (P5-R / P1.5 / memberships incompletos) — `null`, nunca `0` inventado.

### 3.2 Tab Human (P0-Hu-1, P0-Hu-2)

> Contrato: Linear Cycle Time start→complete ([confirm](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md) C2-D4-02) + Workload-style capacity ([confirm](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md) C2-D4-01).

```
┌─ Human · Orquestração humana ──────────────────────────────────────────────┐
│                                                                            │
│  ┌ Cycle Time p50 ─────────┐  ┌ Capacity load (company) ─────────────────┐ │
│  │ 1d 14h                  │  │ 3 green · 1 yellow · 1 red               │ │
│  │ vs 7d ant.: −18%        │  │ “1 pessoa acima do limite WIP”           │ │
│  └─────────────────────────┘  └──────────────────────────────────────────┘ │
│                                                                            │
│  Tabela (Board) / lista (Sofia)                                            │
│  Member        │ CT p50 │ WIP/limit │ Load │ Ação se ruim                  │
│  Sofia         │ 1.2d   │ 4/5       │ 🟢   │ —                             │
│  João          │ 2.8d   │ 6/5       │ 🔴   │ Rebalancear / pausar assign   │
│                                                                            │
│  Label UI: “Orquestração humana” — NUNCA “score” / “rating” / “PDI”        │
└────────────────────────────────────────────────────────────────────────────┘
```

| Métrica | Definição operacional P0 | UI Sofia | UI Board |
|---------|--------------------------|----------|----------|
| **Cycle Time p50** | Tempo start→complete em issues com **owner humano**; só issues que passaram por in-progress (contrato Linear) | “Tempo até pronto (mediana)” | p50 + trend + histogram opcional Should |
| **Capacity load** | WIP assigned / capacity limit por pessoa; green/yellow/red | “Carga da equipe” | tabela member × WIP/limit × cor |

**Ação se ruim:** CT p50 sobe → revisar WIP / handoffs; load vermelho → rebalancear assigns (link Team P2.5).

### 3.3 Tab Agent (P0-Ag-1, P0-Ag-2, P0-Ag-3)

> Contrato: AI Hub Avg Cost / Jobs in Progress ([confirm](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md) C2-D4-01) + CowPilot intervention count ([confirm](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md) C2-D4-05).

```
┌─ Agent · Saúde operacional ────────────────────────────────────────────────┐
│                                                                            │
│  ┌ Avg Cost/job ──┐  ┌ Jobs in Progress ──┐  ┌ Intervention count ──────┐ │
│  │ $18.40         │  │ 7 ativos           │  │ 12 na janela             │ │
│  │ vs 7d: +9%     │  │ (agora)            │  │ 1.7 / job done           │ │
│  └────────────────┘  └────────────────────┘  └──────────────────────────┘ │
│                                                                            │
│  Por agente                                                                │
│  Agente   │ Avg $/job │ Jobs now │ Interv. │ Link                        │
│  @CEO     │ $12.10    │ 1        │ 0       │ → AgentDetail / Costs       │
│  @Dev     │ $41.00    │ 2        │ 5 ⚠     │ → runs filtrados            │
└────────────────────────────────────────────────────────────────────────────┘
```

| Métrica | Definição operacional P0 | UI Sofia | UI Board |
|---------|--------------------------|----------|----------|
| **Avg Cost/job** | $ médio por job/run do agente na janela (USD; fonte cost-events) | “Custo médio por job” | por agente + company rollup |
| **Jobs in Progress** | Contagem de jobs/runs agentic **ativos agora** (não histórico) | “Em andamento” | live count + lista |
| **Intervention count** | Nº de vezes que humano pausa/override por run (HITL) | “Quantas vezes você interveio” | count + rate / job |

**Ação se ruim:** Avg $ sobe → modelo/budget; Jobs now saturado → `maxConcurrentRuns`; Intervention alto → prompt/policy ou work-request mal especificado (não “agente ruim” moral).

### 3.4 Tab Room (P0-Rm-1, P0-Rm-2)

> Contrato: Hybrid Cycle Time (Linear+Jira status contract) + Co-touch como proxy de interdependence AAAI ([confirm](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md) C2-D4-02/03/06).

```
┌─ Room · Colaboração híbrida ───────────────────────────────────────────────┐
│                                                                            │
│  ┌ Hybrid Cycle Time ──────────────┐  ┌ Co-touch rate ──────────────────┐ │
│  │ p50 2.1d                        │  │ 41%                             │ │
│  │ issues com ≥1 hop agentic       │  │ ≥1 humano E ≥1 agente no hist.  │ │
│  └─────────────────────────────────┘  └─────────────────────────────────┘ │
│                                                                            │
│  Nota Board: Co-touch ≠ success. Throughput alto + co-touch baixo =        │
│  “IA sozinha” ou “humano sozinho” — não cooperação (AAAI C2-D4-06).        │
└────────────────────────────────────────────────────────────────────────────┘
```

| Métrica | Definição operacional P0 | UI Sofia | UI Board |
|---------|--------------------------|----------|----------|
| **Hybrid Cycle Time** | open→done (ou start→complete) em issue/thread com **≥1 hop agentic**; status selecionáveis à la Jira | “Tempo híbrido até pronto” | p50 + cohort agentic |
| **Co-touch rate** | % issues/threads com ≥1 ação humana **e** ≥1 ação agent no histórico | “Trabalho em dupla” | % + trend |

**Ação se ruim:** Hybrid CT alto → join/HITL wait; Co-touch baixo com muito spend → revisar se agents rodam sem owner humano (risco orphan — fora P0 UI mas linkável).

### 3.5 Densidades Sofia vs Board

| Aspecto | Sofia (Operator) | Board |
|---------|------------------|-------|
| Cards | 2–3 por tab, linguagem de negócio | Mesmos KPIs + números crus |
| Tabelas | Lista curta top-N | Full table + sort |
| Export | Não | CSV Must |
| Digest | Card semanal 5 bullets → Insights | Opcional |
| Labels | “Orquestração humana” | IDs técnicos em footer |

---

## 4. Definições P0 — contrato fechado

Espelho 1:1 de [`04-dual-performance-confirm.md`](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md) §4:

| ID | Lane | Métrica | Definição | Claim |
|----|------|---------|-----------|-------|
| P0-Hu-1 | Human | Cycle Time (p50) | start→complete, owner humano | C2-D4-02 |
| P0-Hu-2 | Human | Capacity load | WIP vs capacity, G/Y/R | C2-D4-01 |
| P0-Ag-1 | Agent | Avg Cost / job | $ médio por job/run | C2-D4-01 |
| P0-Ag-2 | Agent | Jobs in Progress | jobs ativos agora | C2-D4-01 |
| P0-Ag-3 | Agent | Human intervention count | pausas/overrides por run | C2-D4-05 |
| P0-Rm-1 | Room | Hybrid Cycle Time | open→done com ≥1 hop agentic | C2-D4-02, C2-D4-03 |
| P0-Rm-2 | Room | Co-touch rate | % com ≥1 humano **e** ≥1 agent | C2-D4-06 |

**Não adicionar** métricas “úteis” sem nova confirmação CONFIRMED. Should/Could em P4.5 só para **UX** (sparklines, drill-down), não para novos KPIs.

---

## 5. Data sources — Paperclip

### 5.1 Mapa métrica → fonte

| Métrica P0 | Fonte primária Paperclip | Agregação | Notas |
|------------|--------------------------|-----------|-------|
| Cycle Time p50 | **issues** (timestamps start/complete ou status transitions) | p50 na janela; filtro owner ∈ memberships human | Contrato Linear; excluir issues nunca in-progress |
| Capacity load | **issues** (WIP open assigned) + **memberships** (capacity limit / role) | WIP/limit por member; G/Y/R thresholds | Reusar Team P2.5 limits se existirem; senão default company |
| Avg Cost/job | **cost-events** (+ budgets opcional) | sum($) / count(jobs done) por agentId | REUSE `costs.ts`; sem ledger novo |
| Jobs in Progress | **runs** (status running/queued ativos) | count now por agent + company | Live; não confundir com # jobs históricos |
| Intervention count | **runs** / activity / HITL events (`needs_you`, pause, override) | count na janela; rate = interv / jobs done | Proxy CowPilot; se telemetria HITL ausente → `null` |
| Hybrid Cycle Time | **issues** + hops agentic (delegation / runs ligados) | p50 subset agentic | Mesmo clock que Hu-1; filtro ≥1 hop |
| Co-touch rate | **issues** + histórico ações (comments/runs/work-requests) | % com touch human ∧ agent | Proxy AAAI interdependence — **não** Int_cons |

### 5.2 Paths de reuso (fork)

| Capacidade | Path absoluto (alvo) |
|------------|----------------------|
| Costs / cost-events | `/Users/macbook/Projects/paperclip/server/src/services/costs.ts` · `budgets.ts` |
| Costs UI | `/Users/macbook/Projects/paperclip/ui/src/pages/Costs.tsx` |
| Dashboard | `/Users/macbook/Projects/paperclip/server/src/services/dashboard.ts` · `ui/.../Dashboard.tsx` |
| Activity | `/Users/macbook/Projects/paperclip/server/src/services/activity.ts` |
| Issues / runs | services/routes existentes de issues + runs (poller / heartbeat) |
| Memberships | company members + agent roster (P2.5 `team-roster` quando existir) |
| Dual API (NEW P4.5) | `GET /api/companies/:id/dual-performance?from=&to=` |
| Digest API (NEW) | `GET .../dual-performance/digest` |

### 5.3 Payload tipado (esboço Zod — fronteira)

```ts
// Conceitual — implementação em P4.5 SPEC
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
  sources: { costEvents: bool, issues: bool, runs: bool, memberships: bool, hitl: bool },
}
```

**RNF:** `null` quando `sources.* === false`; UI mostra empty state, não zero.

---

## 6. Refresh e freshness

| Modo | Comportamento | MoSCoW |
|------|---------------|--------|
| **On navigate** | Fetch dual-performance ao abrir Insights | Must |
| **Manual ↻** | Botão refresh + `refreshedAt` no header | Must |
| **Range change** | Re-fetch ao mudar 7d/30d/custom | Must |
| **Polling leve** | Jobs in Progress a cada 30–60s **só** com tab Agent visível | Should |
| **Cron digest** | Snapshot semanal materializado para Sofia | Should |
| **WebSocket push** | Fora de P4.5 | Won't |

**Regras:**

1. Jobs in Progress é a única métrica “live”; demais são window aggregates.  
2. Não misturar “agora” com “7d” no mesmo card sem label.  
3. Timeout agregação: &lt; 3s p95 / 30d (piloto); UI skeleton + retry.  
4. Stale banner se `refreshedAt` &gt; 10 min e tab Agent aberta.

---

## 7. Anti-vanity rules (obrigatórias)

Derivadas de [`04-dual-performance-confirm.md`](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md) §4 OUT + §5 + princípio anti-hype P4.5 SPEC:

| # | Regra | Enforçamento |
|---|-------|--------------|
| AV-1 | **Só P0 CONFIRMED** no v1 | Code review / SPEC gate — sem TTFT, ROAS, #agents |
| AV-2 | **null &gt; fake zero** | RNF; empty state se fonte ausente |
| AV-3 | **Co-touch ≠ success** | Room tab sempre mostra co-touch **ao lado** de Hybrid CT; proibido card “cooperação = % done” |
| AV-4 | **Sem employee score** | Labels “Orquestração humana”; proibido rating/PDI/stack rank público |
| AV-5 | **# agents não é KPI** | Contagem de agentes só em Team roster, nunca card Insights |
| AV-6 | **Intervention ≠ culpa** | Copy: “intervenção HITL”, não “falha do agente” |
| AV-7 | **Autonomy % fora** | “80% autonomia” / Autonomy ratio = Won't P4.5 (PARTIAL / risco moral) |
| AV-8 | **Ação &gt; vanity** | Todo card P0 tem “o que fazer se ruim” (§3) |
| AV-9 | **Fora do stream** | D-11 — zero widgets Dual no chat |
| AV-10 | **Não substituir Costs** | Insights agrega; Costs permanece source of truth $ |

---

## 8. Relação com Team strip (P2.5) e Costs (P4)

```
Team (P2.5)                     Insights Dual (P4.5)              Costs (P4)
┌─────────────────┐             ┌──────────────────┐             ┌──────────┐
│ Roster+lanes    │  strip 2    │ Human|Agent|Room │  drill $    │ Ledger   │
│ WIP / jobs now  │ ──────────► │ full P0 set      │ ──────────► │ events   │
│ link Insights   │  KPIs Room  │ digest Sofia     │             │ budgets  │
└─────────────────┘             └──────────────────┘             └──────────┘
         ▲                              │
         │                              │ capacity feed (Hu-2)
         └──────────────────────────────┘
```

- **Team** mostra capacidade operacional; **Insights** prova valor/orquestração na janela.  
- **Não duplicar** tabelas densas no Team (W3 = Dual charts → P4.5, ver UX Team doc).

---

## 9. MoSCoW para P4.5 (alinhado ao P0 2C)

### 9.1 Must

| ID | Item |
|----|------|
| M1 | Página Insights com tabs **Human \| Agent \| Room** |
| M2 | Exibir **exatamente** as 7 métricas P0 (§4) |
| M3 | Placement **fora do stream** (D-11 / R-09) |
| M4 | Range 7d / 30d / custom ≤90d |
| M5 | API `GET .../dual-performance` tipada + `sources` flags |
| M6 | Agregar **cost-events, issues, runs, memberships** (sem ledger novo) |
| M7 | Labels anti-hype + AV-1…AV-10 |
| M8 | Sofia digest in-app (≤5 bullets) + CTA Insights |
| M9 | Board dense tables + CSV |
| M10 | Empty states honestos (`null`) se P5-R / HITL / P1.5 ausentes |
| M11 | Feature flag `enableDualPerformanceV1` |
| M12 | Refresh on navigate + manual ↻ + `refreshedAt` |

### 9.2 Should

| ID | Item |
|----|------|
| S1 | Sparklines 7d por métrica P0 |
| S2 | Polling 30–60s só Jobs in Progress (tab Agent) |
| S3 | Drill-down: top issues Hybrid CT / top agents $ |
| S4 | Cron snapshot digest semanal |
| S5 | Sort por métrica só Board + confirmação (anti stack-rank acidental) |
| S6 | Eventos `insights.viewed`, `digest.opened` |
| S7 | Link row Agent → Costs filter / AgentDetail |

### 9.3 Could

| ID | Item |
|----|------|
| C1 | Email digest (se infra mail) |
| C2 | Custom status columns para Hybrid CT (Jira-like picker) |
| C3 | Comparação cohort human-only vs hybrid (ainda sem KPI novo — só slice) |

### 9.4 Won't (P4.5)

| ID | Item | Motivo |
|----|------|--------|
| W1 | ROAS / marketing lift | OUT 2C PARTIAL |
| W2 | # agents como KPI | Anti-washing / AV-5 |
| W3 | TTFT / latency p95 / raw tokens | C2-D4-04 PARTIAL |
| W4 | Employee scoring / PDI / stack rank | Anti-hype |
| W5 | Widgets Dual **dentro** do Room stream | D-11 |
| W6 | Substituir página Costs | Escopo |
| W7 | ML forecast / OKR custom | Escopo |
| W8 | Collab Score / Initiative Entropy UI | Lab-only; intervention basta |
| W9 | “80% autonomia” / Autonomy ratio card | Vanity / moral hazard |

---

## 10. Smoke tests (orientação P4.5)

| ID | Cenário | Esperado |
|----|---------|----------|
| ST-P45-01 | Abrir Insights com flag on | 3 tabs; 7 métricas ou null+empty |
| ST-P45-02 | Room stream | Zero cards Dual Performance |
| ST-P45-03 | cost-events presentes | Avg Cost/job numérico; link Costs |
| ST-P45-04 | Sem HITL telemetry | Intervention = null, não 0 |
| ST-P45-05 | Issue human+agent no hist. | Conta em Co-touch numerator |
| ST-P45-06 | Issue só agent | Não conta co-touch; pode contar Hybrid CT |
| ST-P45-07 | Digest Sofia | ≤5 bullets; CTA Insights |
| ST-P45-08 | Label Human | Texto sem “score”/“rating” |

---

## 11. Riscos e mitigação

| Risco | Mitigação |
|-------|-----------|
| Dual vira “RH de humanos” | AV-4; copy review; Won't W4 |
| Vanity metrics creep no PR | Gate: só IDs P0-Hu/Ag/Rm |
| Agregação lenta 90d | Índices costs/issues; cap 90d; timeout |
| Team strip vs Insights confusão | Strip = 2 KPIs + link; charts só Insights |
| Intervention mal instrumentado | null até P3/HITL events estáveis |
| P4.5 antes de P4/P5 | SPEC: pré-req P4 + P5-R; stub empty, não inventar |

---

## 12. Decisões para Cycle 4 / SPEC

| ID | Decisão | Status |
|----|---------|--------|
| D-11 | Performance fora do stream | **LOCKED** (2C) |
| R-09 | Dual performance fora do stream | **PROMOTED** |
| P0 set | 7 métricas §4 | **LOCKED** — este doc não expande |
| Tabs | Human \| Agent \| Room | **Proposed** → SPEC P4.5 Must |
| Overview 4ª tab | Fora v1 (digest cobre Sofia) | **Proposed** |
| Polling | Só Jobs in Progress | **Proposed** Should |

---

## 13. Checklist de pronto (deep dive)

- [x] Layout tabs Human | Agent | Room  
- [x] Somente P0 do INDEX 2C / confirm §4  
- [x] Data sources: cost-events, issues, runs, memberships  
- [x] Refresh / freshness  
- [x] Anti-vanity AV-1…AV-10  
- [x] Placement D-11 fora do stream  
- [x] MoSCoW P4.5  
- [x] Citação explícita de [`04-dual-performance-confirm.md`](../cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md)

---

## 14. Entrega

| Campo | Valor |
|-------|-------|
| **Path** | `docs/research/slack-a2a-room/cycle-3c-hybrid-deep-dive/03-dual-performance-panels.md` |
| **Próximo** | Cycle 4 plan mirror / execução P4.5 SPEC sem expandir P0 |
| **Depende** | P4 (costs) · P5-R (room) · P2.5 (capacity feed opcional) |
