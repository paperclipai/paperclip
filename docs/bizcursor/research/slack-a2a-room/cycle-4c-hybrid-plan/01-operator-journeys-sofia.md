# Jornadas da Operator (Sofia) — Path B+ Hybrid

> **Ciclo:** 4C — Planning (agent #2)  
> **Data:** 2026-07-09  
> **Persona primária:** Sofia (Operator / tech lead)  
> **Produto:** Path **B+** — Conference Room Slack+`@`+A2A **e** Hybrid Team & Performance  
> **Repo de implementação:** fork `/Users/macbook/Projects/paperclip` (`QuadriniL/paperclip`)  
> **BizCursor desktop:** pausado  
> **Beachhead:** Software Houses · **Secundário:** Support Ops  
> **Âncora Cycle 3C:** [`../cycle-3c-hybrid-deep-dive/00-INDEX.md`](../cycle-3c-hybrid-deep-dive/00-INDEX.md)

`NotebookLM: skip (non-Villa) — Path B+ operator journey planning`

---

## 0. Propósito deste doc

Transformar o deep dive Cycle 3C em **jornadas operacionais testáveis** para Sofia — o que ela faz, com quem, em quais superfícies, e **qual fase P# desbloqueia** cada jornada.

Este artefato alimenta:

| Consumidor | Uso |
|------------|-----|
| Cycle 4C product plan (irmão) | Priorização de DoD por jornada |
| Cycle 5 / 5B SPECs | Smoke tests ST-* alinhados a passos Sofia |
| Playbooks P6 | Guia Operator PT-BR |
| QA / demo scripts | Roteiro beachhead SH + Support |

**Não é SPEC de implementação.** É o contrato de experiência Operator → fases.

### Fontes Cycle 3C (obrigatórias)

| Doc 3C | O que promove nas jornadas |
|--------|----------------------------|
| [`01-hybrid-team-panel-ux.md`](../cycle-3c-hybrid-deep-dive/01-hybrid-team-panel-ux.md) | Onboard híbrido; F-T1…F-T5; R-03 / D-13 |
| [`02-human-work-request-flows.md`](../cycle-3c-hybrid-deep-dive/02-human-work-request-flows.md) | Ask / `@` / assign-as-delegate; R-01…R-07; D-12 |
| [`03-dual-performance-panels.md`](../cycle-3c-hybrid-deep-dive/03-dual-performance-panels.md) | Review semanal; D-11 / R-09; P0 metric set |
| [`04-proactivity-governance.md`](../cycle-3c-hybrid-deep-dive/04-proactivity-governance.md) | Kill switch / budget; D-10; L1–L3 |
| [`05-implementation-gap-matrix.md`](../cycle-3c-hybrid-deep-dive/05-implementation-gap-matrix.md) | DAG canônico P0→P6 + inserts `.5` |

### Ordem canônica de fases (3C INDEX / gap matrix)

```
P0 → P1 → P1.5 → P2 → P2.5 → P3 → P4 → P4.5 → P5 → P5.5 → P6
```

---

## 1. Mapa rápido — jornada → fase que desbloqueia

| # | Jornada Sofia | Desbloqueio mínimo (Must) | Soft-deps / polish |
|---|---------------|---------------------------|--------------------|
| **J1** | Onboard hybrid team | **P2.5** (roster+lanes) | P0 agents/members; P1.5 Ask-on-row |
| **J2** | SE sprint room com `@` fan-out | **P2** (fan-out+join+trace) | P0+P1; P3 HITL; P4 cost pills |
| **J3** | Pedir trabalho à IA (não-tech) | **P1.5** (Ask + D-12) | P1 `@`; P2.5 CTA Team; P5.5 gate |
| **J4** | Review dual performance semanal | **P4.5** (Insights + digest) | P4 costs; P5-R metrics; P2.5 capacity |
| **J5** | Kill switch / budget incident | **P5.5** + **P4** (policy + budgets) | P2.5 pause agent; Claim 5 80/90/100 |
| **J6** | Support-ops (secundária, leve) | **P1.5** + templates Support | P0 silent; P3 HITL; P6 playbook |

---

## 2. Personas e papéis nas jornadas

| Ator | Papel Path B+ | Densidade UI | Superfícies |
|------|---------------|--------------|-------------|
| **Sofia** | Operator — orquestra humanos+agentes; accountability | Baixa–média | Room, Team, Ask, Insights digest, Inbox |
| **Board / EM** | Admin — policy, budget, kill switch, CSV | Alta | Settings Proactivity, Costs, Insights dense |
| **João / IC humano** | Member — pede trabalho, steers thread | Baixa | Room `@`, Ask, Issue owner |
| **@CEO / @Dev / @QA / @ops** | Agentes — delegates (nunca owners) | N/A | Runtime adapters |
| **Cliente / ticket** | Trigger externo (Support) | — | Webhook → issue (fora Room ambient) |

**Regra D-12 (3C `02`):** Sofia (ou outro humano) permanece **owner**; agente = **delegate**.  
**Regra D-11 (3C `03`):** métricas densas **fora** do stream da Room.  
**Regra D-10 (3C `04`):** Room = silent-until-`@`; Autopilot-like só em Routines.

---

## 3. Jornada J1 — Onboard hybrid team (humanos + agentes)

> **Job:** “Montar o time híbrido em uma página — convidar colegas, adicionar agentes, ver carga — sem abrir o chat.”  
> **Fonte UX:** 3C [`01-hybrid-team-panel-ux.md`](../cycle-3c-hybrid-deep-dive/01-hybrid-team-panel-ux.md) §4 F-T1…F-T5 · R-03 · D-13  
> **Fase que desbloqueia:** **P2.5** (Must) · Pré: **P0** (agents + members + flag)

### 3.1 Atores

| Ator | Ação |
|------|------|
| Sofia | Conduz onboard; convida; adiciona agentes; define capacity mental |
| Board | Cria company / libera flag `enableHybridTeamPanelV1`; opcional NewAgent |
| Humanos convidados | Aceitam invite → entram no roster |
| Agentes | Idle no roster após create (build ≠ cobrança — Claim 6 via 3C `01`) |

### 3.2 Pré-condições

1. Company existe; Sofia é `member+` / operator.  
2. **P0** verde: agents listáveis, CompanyAccess/invites REUSE.  
3. Feature flag Hybrid Team on (staging).  
4. Zero ou poucos agentes — empty states do 3C `01` §9.

### 3.3 Passos (happy path)

| # | Passo Sofia | Sistema | Superfície |
|---|-------------|---------|------------|
| 1 | Abre nav **Team** | Rota `/company/:id/team` | Hybrid Team Panel |
| 2 | Vê empty / strip Insights stub | Copy “Convide o primeiro colega” / “Adicione o primeiro agente” | Roster |
| 3 | **[+ Convidar]** humano (F-T1) | Modal CompanyInvites REUSE; pending = `away` | Toolbar |
| 4 | Colega aceita | Lane Capacity 0/N · `available` | Roster sync |
| 5 | **[+ Agente]** (F-T2) | NewAgent REUSE; idle 0/cap; copy “criar ≠ gastar créditos” | Toolbar |
| 6 | Filtra Kind=Ambos; ordena Overload-first | Status unificado human\|agent | Filtros |
| 7 | Seleciona @Dev → drawer | Métricas P0 lane + CTAs | Detail drawer |
| 8 | Opcional: **Pedir ao agente** (F-T5) | Abre Ask (P1.5) ou Room `@` | CTA diferencial |
| 9 | Opcional: **Pausar** agente error (F-T3) | Status → `away` (paused) | Drawer |
| 10 | Escape-link “Abrir sala” | Mentions continuam na Room (R-07) | Header escape |

### 3.4 Passos de rebalance (sem DnD)

Conforme 3C `01` F-T4 — ClickUp **não** unificou Workload+AI; Paperclip oferece rebalance **explícito**:

1. Sofia vê `@Dev` overloaded (2/2 · $ alto).  
2. Seleciona `@QA` available.  
3. **Pedir ao agente** / criar pedido com `owner=Sofia`, `delegate=@QA` (D-12).  
4. **Não** arrasta lanes (Won't P2.5).

### 3.5 Critérios de sucesso

| ID | Critério | Verificação |
|----|----------|-------------|
| J1-S1 | Board explica o panel a Sofia em ≤30s | Demo script 3C `01` §10 |
| J1-S2 | Humanos e agentes no **mesmo** roster (R-03/D-13) | Screenshot / ST-P25 |
| J1-S3 | Capacity humana G/Y/R visível sem Costs | Lane human |
| J1-S4 | Jobs in Progress + Avg Cost na lane agente | Lane agent |
| J1-S5 | Owner humano + delegate na copy dos CTAs | D-12 |
| J1-S6 | Teclado percorre roster; Esc fecha drawer | A11y 3C `01` §5 |
| J1-S7 | Nenhuma métrica P0 **só** no stream Room | D-11 |

### 3.6 Dependência de fase

| Fase | Papel em J1 |
|------|-------------|
| **P0** | Agents + members + invites — **pré-requisito** |
| **P1** | Soft — deep-link Room `@` útil |
| **P1.5** | Soft — CTA “Pedir ao agente” completo |
| **P2** | Soft — status busy alimentado por runs reais |
| **P2.5** | **Desbloqueio Must** — jornada completa |
| P4.5 | Strip Insights 2 KPIs Room (Should) |

**Smoke âncora:** ST-P25 (Cycle 5B).

---

## 4. Jornada J2 — SE sprint room com `@` fan-out

> **Job:** “Rodar o stand-up / spike do sprint na Conference Room: mencionar vários agentes, ver join e trace, sem ambient spam.”  
> **Fontes:** 3C [`02`](../cycle-3c-hybrid-deep-dive/02-human-work-request-flows.md) §2 Claude Tag · gap matrix [`05`](../cycle-3c-hybrid-deep-dive/05-implementation-gap-matrix.md) §2.2 P2 · D-10  
> **Fase que desbloqueia:** **P2** · Pré: **P0** + **P1**

### 4.1 Atores

| Ator | Ação |
|------|------|
| Sofia | Facilita a Room; posta brief com `@Dev @QA` |
| João (IC) | Steers no thread (anyone-can-steer — R-05 / Claude Tag) |
| @Dev, @QA | Children A2A; replies no thread |
| Board | Observa DelegationTrace / density alta (opcional) |

### 4.2 Contexto beachhead (Software House)

Cenário típico: `#eng-sprint` — “revisem o PR do auth e o plano de teste”. Sofia precisa de **fan-out paralelo** auditável, não de dois Asks manuais.

### 4.3 Pré-condições

1. Flag Conference Room on; silent-until-`@` enforce (P0).  
2. Composer com mentions `agent://` (P1 ADAPT MarkdownEditor — 3C `02` / gap C5).  
3. `room-orchestrator` + human-delegate bridge (P2 BUILD — gap C9 / PR-F1).  
4. Agentes invokable; budget > 0.

### 4.4 Passos (happy path)

| # | Passo | Sistema | Nota 3C |
|---|-------|---------|---------|
| 1 | Sofia abre Conference Room | Stream multiplayer; agentes no roster da sala | 02 §2.2 |
| 2 | Digita mensagem **sem** `@` | **0** wakes (silent-until-@) | D-10 |
| 3 | Digita `@` → autocomplete Agent Cards | Mentions humanos+agentes | R-07 |
| 4 | Envia `[@Dev](agent://…) [@QA](agent://…) revise o PR X` | Confirm N≥3 se policy (custo) | 02 microcopy fan-out |
| 5 | Orchestrator fan-out `wait:false` | Children via agent-of-record (**não** browser POST delegate) | 05 §4.3; R-06 |
| 6 | UI mostra “Pensando…” / bolhas por agente | Owner = Sofia (autora) | 02 §2.2 |
| 7 | Join / `waitAllSec` | Barrier REUSE; DEBT teste | 05 C1 |
| 8 | Sofia abre **DelegationTrace** | GET delegation board-readable REUSE + UI BUILD | 05 §2.2 |
| 9 | João responde no thread (steer) | Sem re-`@` obrigatório | Claude Tag R-05 |
| 10 | (P3) Card HITL se `needs_you` | Aprovação no thread | Soft |
| 11 | (P4) Cost pill por hop | Fora Dual dashboard; pill local OK | D-11 nuance 03 |

### 4.5 Anti-passos (falha esperada)

| Ação errada | Resultado esperado |
|-------------|-------------------|
| Multi-select Ask modal N>1 | `FANOUT_USE_ROOM` — 3C `02` §3.4 |
| Browser tenta `POST .../delegate` | 403 — C2 / R-06 |
| Ambient sem `@` | 0 reply agente — D-10 |
| Claim “mention = join” | Proibido — PR-F5 / C6 |

### 4.6 Critérios de sucesso

| ID | Critério |
|----|----------|
| J2-S1 | Msg sem `@` → 0 heartbeat agentic |
| J2-S2 | `@Dev @QA` → ≥2 children + join observável |
| J2-S3 | Trace visível para Sofia (densidade Operator) |
| J2-S4 | Humano nunca autentica como agent no browser |
| J2-S5 | Colega pode steer no mesmo thread |
| J2-S6 | Coolify path **sem** `claude` CLI spawn (PR-F3) |

### 4.7 Dependência de fase

| Fase | Papel |
|------|-------|
| **P0** | Silent + flag + agents |
| **P1** | Single `@` + composer |
| **P1.5** | Soft — Ask não substitui fan-out |
| **P2** | **Desbloqueio Must** |
| **P3** | Soft — HITL / quorum |
| **P4** | Soft — cost pills |
| P2.5 | Soft — ver busy nas lanes durante sprint |

**Smoke âncora:** ST-P2 (+ waitAllSec debt).

---

## 5. Jornada J3 — Request work from AI (teammate não-técnico)

> **Job:** “Pedir trabalho à IA tão fácil quanto pedir a um colega — sem JWT, runId ou A2A.”  
> **Fonte:** 3C [`02-human-work-request-flows.md`](../cycle-3c-hybrid-deep-dive/02-human-work-request-flows.md) stack ①–④ · R-01 · D-12 · Claim 8 diferencial Ask  
> **Fase que desbloqueia:** **P1.5** · Pré: **P0** + **P1**

### 5.1 Atores

| Ator | Ação |
|------|------|
| Sofia **ou** PM/CS não-tech (member) | Abre Ask; escolhe template; confirma |
| Owner humano | Sempre o requester (default) ou selecionado |
| Delegate agente | @CEO / @ops / @research conforme template |
| Board | CRUD templates (Should); vê audit |

### 5.2 Por que esta jornada existe

ClickUp confirma intake progressivo **sem** CTA único “Request work from AI” (Claim 8 — 3C `02` §3.1). Path B+ adiciona **Ask** como diferencial de acessibilidade — Sofia leiga não precisa do mental model Slack.

### 5.3 Stack de affordances (qual usar)

| Situação | Preferir | Fase |
|----------|----------|------|
| “Olha isso rápido” | ① Room `@` | P1 |
| Bug com SLA | ③ Issue owner+delegate | P1.5 |
| Fora da Room / Team Panel | ② Ask modal | P1.5 |
| Pedido semanal idêntico | ④ Template | P1.5 |
| Fan-out Dev+QA | ① Room (não modal) | P2 |

### 5.4 Passos — Ask → issue (Path A, default Sofia)

| # | Passo | Sistema |
|---|-------|---------|
| 1 | Sofia em IssueDetail / Team / Inbox → **Pedir ao agente** | CTA member+; guest oculto |
| 2 | Modal: agente + template `triage_bug` | Chips `aria-pressed` |
| 3 | Lê helper: “Você continua responsável. O agente executa.” | D-12 copy |
| 4 | Edita brief; Owner=Sofia; Delegate=@Dev; destino=issue | Campos 02 §3.3 |
| 5 | Submit + Idempotency-Key | `POST /work-requests` user JWT |
| 6 | Server: persist owner+delegate; wake `work_request` | **Sem** browser POST delegate |
| 7 | Toast + scroll ao comment; chips Owner/Delegate | Activity `work_request.created` |
| 8 | Ciclo: queued → running → needs_you / done | Estados 02 §7.4 |

### 5.5 Passos — Ask → Room (Path B)

1. Origem BoardChat → destino `room`.  
2. Post mention formatado + `room-orchestrator` (P1).  
3. Mesma accountability: owner = Sofia.

### 5.6 Error states que Sofia deve entender

| Código | Copy acionável (3C `02` §7.3) |
|--------|------------------------------|
| `AGENT_NOT_INVOKABLE` | Agente pausado / sem adapter |
| `NOT_ASSIGNABLE` | Policy bloqueia delegate |
| `FANOUT_USE_ROOM` | Use Room com @A @B |
| `BUDGET_EXCEEDED` | Peça ao Board (liga J5) |
| `POLICY_BLOCKED` | P5.5 whitelist |
| `AGENT_BUSY` | Enfileirar ou outro agente |

### 5.7 Critérios de sucesso

| ID | Critério |
|----|----------|
| J3-S1 | Member não-tech completa pedido em ≤60s sem docs técnicas |
| J3-S2 | Owner humano + delegate agente persistidos e visíveis |
| J3-S3 | Zero tentativa bem-sucedida de POST delegate do browser |
| J3-S4 | ≥5 templates built-in + Blank (beachhead) |
| J3-S5 | Multi-agent no modal bloqueado com CTA Room |
| J3-S6 | Empty/error states acionáveis (não stack trace) |

### 5.8 Dependência de fase

| Fase | Papel |
|------|-------|
| **P0** | Auth + agents |
| **P1** | Wake single / Room Path B |
| **P1.5** | **Desbloqueio Must** |
| **P2.5** | Soft — CTA no row Team |
| **P5.5** | Soft — `assertTriggerAllowed` em Ask |
| P4 | Soft — budget gate mensagem |

**Smoke âncora:** ST-P15.

---

## 6. Jornada J4 — Review dual performance semanal

> **Job:** “Provar fora do chat se o time híbrido fluiu, custou e colaborou — com números honestos e ações.”  
> **Fonte:** 3C [`03-dual-performance-panels.md`](../cycle-3c-hybrid-deep-dive/03-dual-performance-panels.md) · D-11 · R-09 · P0 metric set (7 métricas)  
> **Fase que desbloqueia:** **P4.5** · Pré: **P4** + **P5-R** · Soft: **P2.5** capacity

### 6.1 Atores

| Ator | Ação |
|------|------|
| Sofia | Consome **digest** semanal (≤5 bullets) → abre Insights |
| Board / EM | Tabs densas + CSV; drill Costs |
| Sistema | Agrega cost-events · issues · runs · memberships |

### 6.2 Cadência

| Momento | Ação Sofia |
|---------|------------|
| Segunda 9h (Should cron) | Digest in-app aparece |
| Review 15–20 min | Abre Insights; janela 7d |
| Se ruim | Link Team (rebalance) / Costs / AgentDetail |
| Nunca | Procurar KPIs Dual **dentro** do stream Room |

### 6.3 Passos

| # | Passo | Tab / UI | Métricas P0 |
|---|-------|----------|-------------|
| 1 | Abre digest → CTA **Abrir Insights** | Snapshot Sofia | — |
| 2 | Confirma densidade Sofia; range 7d | Shell Insights | — |
| 3 | Tab **Human** | Cycle Time p50 · Capacity load G/Y/R | P0-Hu-1/2 |
| 4 | Se João vermelho | Ação: rebalancear assigns → Team P2.5 | AV-8 |
| 5 | Tab **Agent** | Avg Cost/job · Jobs in Progress · Interventions | P0-Ag-1/2/3 |
| 6 | Se @Dev $ alto / interv. alto | Ação: modelo/budget ou brief Ask ruim — **não** “agente culpado” | AV-6 |
| 7 | Tab **Room** | Hybrid Cycle Time · Co-touch rate | P0-Rm-1/2 |
| 8 | Lê nota: Co-touch ≠ success | Anti-vanity AV-3 | 03 §7 |
| 9 | Refresh ↻ se stale | `refreshedAt` | Must |
| 10 | Se fonte ausente | Empty `null` — **nunca** fake zero | AV-2 |

### 6.4 O que Sofia **não** faz nesta jornada

- Stack-rank de humanos / PDI (Won't W4).  
- Usar ROAS, TTFT, #agents vanity (OUT 2C).  
- Colar widgets Dual no chat (D-11).  
- Tratar Insights como substituto de Costs (AV-10).

### 6.5 Critérios de sucesso

| ID | Critério |
|----|----------|
| J4-S1 | Digest ≤5 bullets + CTA Insights |
| J4-S2 | Exatamente 7 métricas P0 (ou null+empty) |
| J4-S3 | Zero cards Dual no Room stream (ST-P45-02) |
| J4-S4 | Labels “Orquestração humana” — sem “score/rating” |
| J4-S5 | Toda métrica ruim tem “o que fazer” |
| J4-S6 | Board pode exportar CSV; Sofia não precisa |

### 6.6 Dependência de fase

| Fase | Papel |
|------|-------|
| **P2.5** | Soft — capacity feed Hu-2 |
| **P4** | **Pré** — cost-events |
| **P5** (P5-R) | **Pré** — room metrics |
| **P4.5** | **Desbloqueio Must** |
| P3 | Soft — intervention telemetry |

**Smoke âncora:** ST-P45-01…08.

---

## 7. Jornada J5 — Kill switch / budget incident

> **Job:** “Quando o gasto ou a proatividade sai do controle, Sofia escala e o Board corta — sem ambient na Room e sem surpresa.”  
> **Fonte:** 3C [`04-proactivity-governance.md`](../cycle-3c-hybrid-deep-dive/04-proactivity-governance.md) §7 · Claim 5 80/90/100 · D-10  
> **Fase que desbloqueia:** **P5.5** (kill/policy) + **P4** (budgets/alerts) · Soft: **P2.5** pause agent

### 7.1 Atores

| Ator | Poder |
|------|-------|
| Sofia | Observa banners/Inbox; **pausa agente** (F-T3); **não** edita policy (read-only RF-P55-13) |
| Board | Kill L1/L2; edita whitelist; reabre freeze |
| Sistema | Threshold alerts → Inbox (**não** spam Room) |

### 7.2 Gatilhos de incidente

| Gatilho | Limiar | Sink (3C `04` §7.3) |
|---------|--------|---------------------|
| Budget | 80% | Banner + Inbox Board; badge Team |
| Budget | 90% | + rate-limit routines |
| Budget | 100% | Block wakes Autopilot-like; `budget_blocked` |
| Ambient attempt | qualquer | Deny + audit (K4 meta = 0) |
| Agent error storm | policy | Pause L3 / Inbox |

### 7.3 Passos — incidente de budget (Sofia → Board)

| # | Passo | Quem | Sistema |
|---|-------|------|---------|
| 1 | Sofia vê badge overload / banner 80% no Team ou Inbox | Sofia | Fora do stream (D-11) |
| 2 | Abre Costs / Insights Agent tab | Sofia | Confirma Avg $/ Jobs |
| 3 | **Pausa** @Dev overloaded (Team drawer) | Sofia | L3 adapter pause — 01 F-T3 |
| 4 | Notifica Board: “budget 90%+” | Sofia | Inbox / chat humano |
| 5 | Board abre **Settings → Proactivity** | Board | Callout Room silent |
| 6 | Board arma **Kill switch L1** | Board | Bloqueia routine/webhook wakes; **mantém** mention / work_request / assignment |
| 7 | Se incidente grave: **L2 Hard freeze** | Board | Bloqueia também manual_wakeup + fire; reason obrigatória (Should) |
| 8 | Audit: `proactivity.kill_switch` + `budget_blocked` | Sistema | Últimos 50 eventos |
| 9 | Após correção: Board desliga kill; Sofia retoma Ask/`@` | Ambos | Mentions humanos nunca foram cortados no L1 |
| 10 | Post-mortem leve: digest / Insights 7d | Sofia | J4 |

### 7.4 Passos — tentativa ambient (regressão)

1. Mensagem na Room **sem** `@`.  
2. Esperado: **0** agent reply (D-10; `postWithoutMentionWakesAgent: false` imutável).  
3. Se legado concierge: só com `legacyConcierge` opt-in — **fora** beachhead default (04 §6.4).  
4. KPI K4 Ambient wake count = **0**.

### 7.5 Níveis de kill (referência rápida)

| Nível | Escopo | Mantém Ask/`@`? |
|-------|--------|-----------------|
| L0 | Ambient impossível no código | Sim |
| L1 Company | Autopilot-like off | **Sim** |
| L2 Hard freeze | Quase tudo off | Não (só Board reabre) |
| L3 Agent pause | Um agente | Sim (outros) |

### 7.6 Critérios de sucesso

| ID | Critério |
|----|----------|
| J5-S1 | Alertas 80/90/100 chegam Inbox — **não** flood Room |
| J5-S2 | L1 em um clique; Sofia continua podendo `@` / Ask |
| J5-S3 | 100% bloqueia novos routine/webhook wakes |
| J5-S4 | Ambient wake count = 0 no beachhead |
| J5-S5 | Audit kill + budget_blocked consultável pelo Board |
| J5-S6 | Fail-closed se policy corrupt (Room silent) |

### 7.7 Dependência de fase

| Fase | Papel |
|------|-------|
| **P4** | Budgets + thresholds surface |
| **P2.5** | Soft — Pausar + badge |
| **P5.5** | **Desbloqueio Must** — policy + kill + enforce |
| P1.5 | Soft — Ask permanece no L1 |
| P6 | Soft — playbook incidente no guia Sofia |

**Smoke âncora:** ST-P55 + ST-P4 budget alerts.

---

## 8. Jornada J6 — Support-ops (secundária, leve)

> **Job:** “No vertical Support, Sofia (ou CS) pede rascunho/triage à IA com owner humano — sem Autopilot na sala de guerra.”  
> **Fontes:** 3C `02` templates Support · `04` Autopilot ≠ Super · gap matrix beachhead Secondary · Cycle 4B D-05  
> **Fase que desbloqueia:** **P1.5** (+ template `draft_reply`) · Soft: **P0**, **P3**, **P6** playbook

### 8.1 Por que “leve”

Support é **evidência B** (secundária), não beachhead A (Software Houses). A jornada reusa a mesma stack Ask/D-12 — **não** exige fan-out P2 nem Dual P4.5 no dia 1 do piloto Support.

### 8.2 Atores

| Ator | Ação |
|------|------|
| Sofia / CS lead | Owner do ticket/issue |
| Agente @ops | Delegate — rascunho / triage |
| Cliente | Fora do produto (ticket chega via webhook → issue) |
| Board | Conecta webhook; **não** liga ambient Room |

### 8.3 Passos (caminho mínimo)

| # | Passo | Fase |
|---|-------|------|
| 1 | Ticket vira issue (webhook / ingest) — **fora** do stream Room | P0 + routines REUSE |
| 2 | CS abre issue → **Pedir ao agente** | P1.5 |
| 3 | Template `draft_reply` ou `triage_bug` (se bug) | P1.5 catalog |
| 4 | Owner=CS; Delegate=@ops; brief + tom | D-12 |
| 5 | Agente comenta rascunho; status `needs_you` | P1.5 / P3 soft |
| 6 | Humano edita e envia ao cliente (**humano accountable**) | Claim 7 / AIG |
| 7 | Se war-room: CS `@ops` na Room **só** quando pedir | P1; D-10 |
| 8 | **Não** ligar Autopilot postando na Room | P5.5 Won't ambient |

### 8.4 O que fica de fora (de propósito)

| Item | Motivo |
|------|--------|
| Fan-out multi-agent no ticket | Overkill Support v1 → P2 se necessário |
| Dual Performance obrigatório no piloto Support | J4 é SH-first; Support consome depois |
| Ambient “responde todo ticket sozinho” | REJECT 3C `04` |
| Plane agent-as-owner | Anti-padrão D-12 |

### 8.5 Critérios de sucesso (leves)

| ID | Critério |
|----|----------|
| J6-S1 | CS completa draft_reply sem conhecer A2A |
| J6-S2 | Owner humano sempre no ticket agentic |
| J6-S3 | 0 posts ambient de agente na Room de suporte |
| J6-S4 | Webhook → issue (não → spam chat) |
| J6-S5 | Playbook Support documentado em P6 |

### 8.6 Dependência de fase

| Fase | Papel |
|------|-------|
| **P0** | Silent Room se usarem chat |
| **P1.5** | **Desbloqueio Must** |
| **P3** | Soft — HITL card |
| **P5.5** | Soft — webhook allow; ambient deny |
| **P6** | Soft — playbook Support empacotado |

**Smoke âncora:** ST-P15 com template Support + ST-P0 silent.

---

## 9. Matriz cruzada — jornada × superfície × decisão LOCKED

| Jornada | Room | Team | Ask/Issue | Insights | Settings Proactivity | Decisões |
|---------|------|------|-----------|----------|----------------------|----------|
| J1 Onboard | escape link | **primária** | CTA Soft | strip Soft | — | D-13, R-03, D-11 |
| J2 Sprint fan-out | **primária** | Soft busy | — | — | — | D-10, D-01/B+, PR-F1 |
| J3 Pedir IA | Path B Soft | CTA Soft | **primária** | — | gate Soft | D-12, R-01, R-06 |
| J4 Review semanal | **proibido** Dual | link Soft | — | **primária** | — | D-11, R-09 |
| J5 Incident | sem spam | pause Soft | Ask L1 ok | pós Soft | **primária Board** | D-10, Claim 5 |
| J6 Support | só se `@` | — | **primária** | defer | webhook Soft | D-12, D-10 |

---

## 10. Sequência temporal sugerida (Sofia no piloto SH)

```text
Semana 0–2   P0/P1     → Sofia confia: chat humano não acorda AI
Semana 2–4   P1.5      → J3 Ask no dia a dia (bugs / research)
Semana 4–6   P2        → J2 fan-out no spike de sprint
Semana 6–7   P2.5      → J1 onboard time híbrido visível
Semana 7–10  P3/P4     → HITL + custo; prepara incidentes
Semana 10–12 P4.5      → J4 review semanal vira hábito
Semana 12–14 P5.5      → J5 kill/budget ensaiado com Board
Semana 14+   P6        → J6 Support playbook + GA anti-washing
```

Alinhado ao DAG 3C [`05`](../cycle-3c-hybrid-deep-dive/05-implementation-gap-matrix.md) §3.3 e sprints §8.

---

## 11. Riscos por jornada (mitigações 3C)

| Jornada | Risco | Mitigação (doc 3C) |
|---------|-------|---------------------|
| J1 | Panel vira segundo OrgChart sem ação | Ask + deep-link Room no DoD P2.5 (`05` §4.4) |
| J2 | Coolify quebra com `claude` spawn | ADAPT adapter_wake PR-F3 (`05` §4.1) |
| J2 | Mention confundido com join | PR-F5 / C6 (`05`) |
| J3 | Plane-style agent owner | Validators D-12 (`02` §4.5) |
| J3 | Fake agent JWT no browser | FORBIDDEN R-06 (`02` §6) |
| J4 | Dual vira RH de humanos | AV-4 / Won't W4 (`03` §7) |
| J4 | Vanity metrics creep | Gate só P0 IDs (`03`) |
| J5 | Kill corta Ask por engano | L1 preserva mention/work_request (`04` §7.2) |
| J5 | Threshold auto-run na Room | Default false; Inbox only (`04`) |
| J6 | Autopilot “na sala de suporte” | REJECT ambient; playbook P6 (`04` §0) |

---

## 12. Checklist de pronto deste artefato Cycle 4C

- [x] Seis jornadas Sofia com atores, passos, sucesso, fase P#  
- [x] Citações explícitas aos cinco docs Cycle 3C  
- [x] Mapa jornada → fase + soft-deps  
- [x] Matriz superfície × decisão LOCKED  
- [x] Sequência temporal piloto SH  
- [x] Support como jornada secundária explícita  
- [x] ≥250 linhas  
- [ ] Product plan 4C irmão referencia este arquivo  
- [ ] SPECs 5/5B amarram ST-* aos IDs J*-S*

---

## 13. Handoff

| Próximo | Usa deste doc |
|---------|---------------|
| `00-PRODUCT-PLAN` Cycle 4C (se existir) | DoD por jornada J1–J6 |
| Playbook Sofia P6 | Roteiros J1–J5 + J6 Support |
| QA scripts | Passos numerados + critérios J*-S* |
| Demo Board→Sofia | J1 (30s panel) + J3 (Ask) + J2 (fan-out) |

**Path absoluto deste arquivo:**

`/Users/macbook/Projects/bizcursor/docs/research/slack-a2a-room/cycle-4c-hybrid-plan/01-operator-journeys-sofia.md`

---

## Metadados

| Campo | Valor |
|-------|-------|
| Agente | Cycle 4 Planning #2 — Operator journeys Sofia |
| Método | Síntese Cycle 3C → jornadas faseadas Path B+ |
| Quotes inventadas | 0 (grades/decisões herdadas de 3C/2C) |
| Idioma | PT-BR |
| Confiança | Alta — ancorado em 3C INDEX + docs 01–05 |
