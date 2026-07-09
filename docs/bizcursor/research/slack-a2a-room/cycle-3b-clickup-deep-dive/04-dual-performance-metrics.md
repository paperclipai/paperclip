# Métricas dual — performance Humano \| Agente

> **Ciclo:** 3B — ClickUp deep dive  
> **Data:** 2026-07-09  
> **Decisão:** D-11 — painéis **fora** do stream (aba Team / Insights)  
> **Base 1B:** Outcome · Collaboration · Reliance · Agent health · Cost · Human orchestration · Risk  
> **Fontes conceituais:** Magentic / Co-Gym / McKinsey / Deloitte / Google Cloud command centers (confiança média — instrumentar no fork)

---

## 1. Princípios

1. **Dual por design:** todo KPI diz se aplica a `human`, `agent`, ou `hybrid`.  
2. **Fora do chat:** Room mostra custo/hop local; **não** dashboards.  
3. **Duas densidades:** Sofia (linguagem de negócio) vs Board (telemetria).  
4. **Ação > vanity:** cada métrica tem “o que fazer se ruim”.  
5. **Reusar Costs:** não reinventar ledger — agregar.

---

## 2. Taxonomia

### 2.1 Outcome (resultado)

| ID | Métrica | Aplica a | Definição operacional | Sofia | Board |
|----|---------|----------|----------------------|-------|-------|
| O1 | Throughput | hybrid | Issues fechadas / semana com participação agentic | “Pedidos concluídos” | count + trend |
| O2 | Cycle time | hybrid | p50/p90 tempo open→done (owner+delegate) | “Tempo médio até pronto” | histogram |
| O3 | First-pass accept | hybrid | % issues agentic sem reopen em 7d | “Acertou de primeira” | % + cohort |
| O4 | Human-only share | human | % issues sem delegate | “Feito só por pessoas” | % |

### 2.2 Collaboration (colaboração)

| ID | Métrica | Aplica a | Definição | Sofia | Board |
|----|---------|----------|-----------|-------|-------|
| C1 | Co-touch rate | hybrid | % issues com ≥1 humano **e** ≥1 agente no histórico | “Trabalho em dupla” | % |
| C2 | Fan-out join success | agent | % room orchestrations N≥2 com join completo | — (avançado) | % + timeouts |
| C3 | Handoff count | hybrid | Média de hops A2A / issue agentic | “Quantas mãos” | hops/issue |
| C4 | Mention precision | hybrid | % mentions que geram run útil (não cancel) | — | % |

### 2.3 Reliance (dependência / confiança operacional)

| ID | Métrica | Aplica a | Definição | Sofia | Board |
|----|---------|----------|-----------|-------|-------|
| R1 | Delegation rate | hybrid | % issues novas com delegate agente | “Quanto pedimos à IA” | % |
| R2 | Autonomy ratio | agent | % conclusões sem `needs_you` intermediário | “IA sozinha até o fim” | % (cuidado: alto ≠ bom) |
| R3 | Review burden | human | Tempo humano em `needs_you` / semana | “Tempo seu revisando” | minutes |
| R4 | Override rate | human | % vezes humano rejeita/refaz output agente | “Quantas vezes corrigimos” | % |

**Nota:** Reliance alto + Override alto = risco (IA barata mas ruim). Insights deve **parear** R1×R4.

### 2.4 Agent health

| ID | Métrica | Aplica a | Definição | Sofia | Board |
|----|---------|----------|-----------|-------|-------|
| A1 | Success rate | agent | runs done / (done+failed) janela | “Agentes ok?” | % por agente |
| A2 | Error rate | agent | failed / total | “Problemas” | % + top errors |
| A3 | Queue wait | agent | p50 tempo queued→running | — | latency |
| A4 | Liveness | agent | stuck runs (run-liveness) | “Travado” | count |
| A5 | Pause ratio | agent | tempo paused / calendar | — | % |

**Paths REUSE:** `run-liveness`, heartbeats, Activity.

### 2.5 Cost

| ID | Métrica | Aplica a | Definição | Sofia | Board |
|----|---------|----------|-----------|-------|-------|
| $1 | Spend window | agent | $ na janela (semana/mês) | “Gastamos ≈ R$ X” | cents + tokens |
| $2 | Cost / done issue | hybrid | spend / issues agentic done | “Custo por pedido” | ratio |
| $3 | Cost / hop | agent | média por delegation hop | — | ratio |
| $4 | Budget headroom | agent | 1 − spend/budget | “Ainda temos folga?” | % + 80/100 alerts |
| $5 | Idle spend | agent | custo em runs cancelados/erro | “Desperdício” | cents |

**Paths REUSE:**

- `/Users/macbook/Projects/paperclip/server/src/services/costs.ts`
- `/Users/macbook/Projects/paperclip/server/src/services/budgets.ts`
- `/Users/macbook/Projects/paperclip/ui/src/pages/Costs.tsx`

### 2.6 Human orchestration

| ID | Métrica | Aplica a | Definição | Sofia | Board |
|----|---------|----------|-----------|-------|-------|
| H1 | WIP por owner | human | issues abertas / humano | “Sua fila” | distribution |
| H2 | Time-to-assign | human | create→delegate set | “Demora a pedir IA” | p50 |
| H3 | Approval latency | human | `needs_you` → resolve | “Demora a aprovar” | p50 |
| H4 | Invite activation | human | invites accepted / sent | — | % |

### 2.7 Risk

| ID | Métrica | Aplica a | Definição | Sofia | Board |
|----|---------|----------|-----------|-------|-------|
| K1 | Ungated high-impact | hybrid | ações sensíveis sem approval | “Riscos sem revisão” | count |
| K2 | Budget incidents | agent | breaches / near-breaches | “Estourou verba” | incidents |
| K3 | Orphan agentic | hybrid | issues com delegate **sem** owner humano | “Sem responsável” | count → 0 meta |
| K4 | Ambient wake count | agent | wakes fora de whitelist (doc 05) | — | count (deve ser 0) |

---

## 3. Layout do dashboard Insights

### 3.1 IA da página (aba Team → Insights)

```
┌────────────────────────────────────────────────────────────┐
│ Insights          Janela: [7d ▾]     Densidade: [Sofia|Board]
├──────────────────────────┬─────────────────────────────────┤
│ OUTCOME                  │ RELIANCE                        │
│ Concluídos 28 (↑12%)     │ Pedidos à IA 61%                │
│ Tempo médio 1d 4h        │ Correções 18%  ⚠ pareado        │
├──────────────────────────┼─────────────────────────────────┤
│ COST (Sofia: 1 card)     │ HEALTH                          │
│ ≈ R$ 420 / R$ 800        │ Agentes ok 96% · 1 overloaded   │
├──────────────────────────┴─────────────────────────────────┤
│ COLLAB / RISK (Board default expandido; Sofia colapsado)   │
│ Join success 91% · Orphans 0 · Budget incidents 1          │
├────────────────────────────────────────────────────────────┤
│ TABELA DUAL (toggle Humano | Agente)                       │
│ nome · WIP/runs · success · $ · status                     │
└────────────────────────────────────────────────────────────┘
```

### 3.2 Sofia vs Board — o que muda

| Bloco | Sofia | Board |
|-------|-------|-------|
| Outcome | O1, O2, O3 em PT simples | + O4, trends, export |
| Reliance | R1, R4 com callout | + R2, R3 raw |
| Cost | $1, $4 linguagem R$ | $1–$5 + link Costs full |
| Health | A1 + “quem está overloaded” | A1–A5 por agente |
| Collab | C1 só | C1–C4 + fan-out |
| Risk | K2, K3 em vermelho se >0 | K1–K4 + audit links |
| Tabela | Top 5 | Full + sort + CSV |

### 3.3 Onde **não** colocar

| Local | Pode | Não pode |
|-------|------|----------|
| Room stream | cost pill hop, “precisa de você” | charts Reliance/Outcome |
| Hybrid lanes | WIP, budget %, status | histórico 7d completo |
| Costs page | ledger detalhado | substituir Insights outcome |
| Agents page | health pontual | dual human metrics |

---

## 4. Instrumentação no fork (mínimo)

| Métrica | Evento / query | Path sugerido |
|---------|----------------|---------------|
| O1–O3 | issues closed + timestamps + delegate flag | BUILD `insights-service` agregando `issues` |
| C2 | delegation join results | REUSE `run-delegation` state |
| R1 | issues com `delegateAgentId` / total | issues schema ADAPT |
| A1–A4 | heartbeat runs | REUSE heartbeats + `run-liveness.ts` |
| $1–$5 | cost windows | REUSE `costs.ts` / `budgets.ts` |
| H1 | WIP por `ownerUserId` | issues |
| K3 | delegate sem owner | query + alert |
| K4 | ambient wakes | room-policy + routines audit |

**BUILD:**

- `/Users/macbook/Projects/paperclip/server/src/services/insights.ts`
- `/Users/macbook/Projects/paperclip/server/src/routes/insights.ts`
- `/Users/macbook/Projects/paperclip/ui/src/features/hybrid-team/InsightsPanel.tsx`
- `/Users/macbook/Projects/paperclip/packages/shared/src/validators/insights.ts`

---

## 5. Alertas (não são métricas vanity)

| Condição | Severidade | Destino |
|----------|------------|---------|
| Budget ≥ 80% | warn | Inbox Board + strip |
| Budget ≥ 100% | block / policy | Budget incident (já existe) |
| Orphan agentic > 0 | warn | Insights + issue banner |
| Agent error rate > 15% (7d) | warn | Team roster |
| Override rate > 40% com delegation > 50% | info | Insights callout “qualidade” |
| Ambient wake > 0 | critical | Board only |

---

## 6. Anti-padrões de métrica

1. Mostrar só **tokens** para Sofia.  
2. Celebrar **Autonomy ratio** alto sem Override.  
3. Misturar custo de **todos** os adapters sem filtro company.  
4. KPI no meio do chat.  
5. Dashboard builder livre antes de ter os 7 eixos estáveis.

---

## 7. Critérios de pronto

- [ ] Sete eixos com IDs estáveis (O/C/R/A/$/H/K).  
- [ ] Layout Sofia ≠ Board especificado.  
- [ ] Paths REUSE Costs/Delegation vs BUILD insights.  
- [ ] Meta K3 (orphans) = 0 no beachhead.  
- [ ] Pareamento Reliance × Override documentado.
