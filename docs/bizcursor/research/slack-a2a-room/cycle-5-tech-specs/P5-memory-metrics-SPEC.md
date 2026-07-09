# P5 — Memória PARA (bridge leve ou defer) + Métricas da Room

> **Versão:** 1.0  
> **Data:** 2026-07-09  
> **Ciclo:** 5 — Tech specs  
> **Repo de implementação:** fork `/Users/macbook/Projects/paperclip` (`QuadriniL/paperclip`)  
> **Pré-requisitos:** P1–P4 (sala operacional com `@`, A2A, HITL, custos)  
> **BizCursor F4 PARA:** referência conceitual; **não** portar pipeline Tauri nesta fase  
> **Confiança:** Média em memória (spike); Alta em métricas de sala (eventos internos)

---

## 1. Contexto

### 1.1 Duas frentes no mesmo ciclo de produto

| Frente | Objetivo | Risco de escopo |
|--------|----------|-----------------|
| **A — Memória PARA bridge** | Continuidade (“o que combinamos?”) entre sessões da room | Alto — dual-mode F4 é grande |
| **B — Room metrics** | Mentions, fan-outs, join success, cost/session para piloto beachhead | Médio — telemetria + dashboard leve |

P5 **prioriza B (Must)** e trata A como **spike com critério GO/NO-GO** (Should leve ou defer explícito). Isso evita agent washing de “memória institucional” sem métricas de ciclo.

### 1.2 Por que métricas agora

DoD Software House (Cycle 3) exige threads reais, time-to-first-diff, custo visível. Sem contadores de:

- mentions / fan-outs / join success  

…o piloto não prova que a sala é usada como prometido (só “chat bonito”).

### 1.3 Memória — estado no ecossistema

| Peça | Status |
|------|--------|
| Skill `para-memory-files` / `$AGENT_HOME` | Já no mundo Paperclip agentes |
| Plugin `plugin-llm-wiki` | Wiki no fork — **não** é PARA dual-mode completo |
| BizCursor F4 SPEC | Pipeline desktop (indexer/search/capture) — **pausado** para Room |
| Room | Sem painel memória nativo |

### 1.4 Decisão de produto (spike)

```
SPIKE-P5-MEM (≤ 3 dias engenharia):
  GO  → bridge leve: search read-only de daily notes / MEMORY.md do agent-of-record
        injetado no wake context da room (sem UI editor completa)
  NO-GO → defer memória completa para pós-GA / alinhamento F4;
          documentar no INDEX e playbooks P6 como “não claim”
```

**Regra:** se spike NO-GO, P5 **ainda** fecha com métricas Must — memória não bloqueia GA experimental→GA (P6), mas **proíbe** marketing “lembra tudo”.

### 1.5 Personas

| Persona | Memória (se GO) | Métricas |
|---------|-----------------|----------|
| Sofia | “Lembra preferências do repo” via agente, sem painel complexo | Não precisa dashboard; vê resumo semanal simples |
| Board | Opcional: link para wiki/PARA files | Dashboard: mentions, fan-out rate, join %, $/session |

---

## 2. Requisitos funcionais

### 2.1 Memória (RF-P5-M-XX)

| ID | Requisito | MoSCoW |
|----|-----------|--------|
| **RF-P5-M-01** | Executar spike SPIKE-P5-MEM com relatório GO/NO-GO escrito | Must |
| **RF-P5-M-02** | Se GO: pre-run inject de até K snippets (keyword) do `$AGENT_HOME` do agent-of-record no wake da room | Should |
| **RF-P5-M-03** | Se GO: post-run capture **opcional** (staging only; commit humano/Board) | Could |
| **RF-P5-M-04** | Se NO-GO: doc de defer + anti-claim checklist item | Must |
| **RF-P5-M-05** | Não substituir skill PARA do agente; bridge é read-mostly | Must (se GO) |
| **RF-P5-M-06** | Sem embeddings próprios obrigatórios no spike (keyword/qmd leve ok) | Should |

### 2.2 Métricas da room (RF-P5-R-XX)

| ID | Requisito | MoSCoW |
|----|-----------|--------|
| **RF-P5-R-01** | Contar **mentions** por room/thread (resolvidas `agent://`) | Must |
| **RF-P5-R-02** | Contar **fan-outs** (N≥2 mentions com orchestration parallel/quorum) | Must |
| **RF-P5-R-03** | Contar **join success** (parent settled com política cumprida vs timeout/fail) | Must |
| **RF-P5-R-04** | Expor **cost/session** (reusa P4 `sessionCostCents`) na API de métricas | Must |
| **RF-P5-R-05** | Dashboard Board: cards/tabela por room e janela 7/30d | Must |
| **RF-P5-R-06** | Eventos auditáveis: `room.metric.mention`, `room.metric.fanout`, `room.metric.join_*` | Should |
| **RF-P5-R-07** | Export CSV (Board) | Could |
| **RF-P5-R-08** | Sofia: resumo semanal em linguagem natural (“12 threads, 4 fan-outs, $X”) | Could |

---

## 3. Requisitos não funcionais

| ID | Requisito | Métrica |
|----|-----------|---------|
| **RNF-P5-01** | Spike memória timeboxed | ≤ 3 dias-calendário ou ≤ 5 PR-days |
| **RNF-P5-02** | Métricas não degradam send path | Instrumentação async / out-of-band; p95 send +&lt;50ms |
| **RNF-P5-03** | PII | Métricas agregadas; sem corpos de mensagem no dashboard default |
| **RNF-P5-04** | Retenção | Agregados 90d (configurável); raw events conforme activity log policy |
| **RNF-P5-05** | Multi-tenant | Sempre scoped por `companyId` |

---

## 4. MoSCoW (resumo)

| Must | Should | Could | Won't (P5) |
|------|--------|-------|------------|
| Spike GO/NO-GO documentado | Bridge leve read-only se GO | Capture post-run + CSV + digest Sofia | Dual-mode F4 completo no desktop |
| Mentions, fan-outs, join success, cost/session | Eventos nomeados | UI editor PARA | Memory federation cross-company |
| Dashboard Board 7/30d | — | Embeddings semânticos | Voice recruiting memory |

---

## 5. UX

### 5.1 Métricas (Board)

Página ou seção **Room insights** (sob Company / Dashboard):

| Card | Definição |
|------|-----------|
| Mentions | Σ mentions agente em posts humanos |
| Fan-outs | Σ orquestrações com ≥2 targets |
| Join success % | joins OK / (OK+timeout+fail) |
| Cost / session | mediana e p95 `$` por thread com ≥1 hop |

Sofia: **não** vê dashboard denso; opcional digest.

### 5.2 Memória (somente se GO)

- Sem painel lateral completo na v1 do spike.
- Comportamento: agente responde com continuidade; Board pode abrir files via workspace/wiki existente.
- Empty state se NO-GO: nenhum UI stub mentindo “Memória”.

### 5.3 Anti-padrões

- Dashboard de vanity (“1000 agent messages”) sem join/cost.
- Claim “PARA completo” com só keyword grep.
- Indexar mensagens privadas de humanos sem policy.

---

## 6. Arquitetura (paths no fork)

### 6.1 Métricas

```
board-room / room-orchestrator
    → emit counters (mentions, fanout, join outcome)
         → room-metrics service
              → GET /api/companies/:id/room-metrics
                   → UI Room insights
P4 room-costs ──────────────────────────┘ cost/session
```

| Área | Path absoluto proposto |
|------|------------------------|
| Service | `/Users/macbook/Projects/paperclip/server/src/services/room-metrics.ts` |
| Schema (agregados) | `/Users/macbook/Projects/paperclip/packages/db/src/schema/room_metric_daily.ts` (ou reusar activity_log se suficiente) |
| Route | `/Users/macbook/Projects/paperclip/server/src/routes/room-metrics.ts` |
| OpenAPI | `/Users/macbook/Projects/paperclip/server/src/routes/openapi.ts` |
| UI | `/Users/macbook/Projects/paperclip/ui/src/pages/RoomInsights.tsx` |
| Cards | reusar `/Users/macbook/Projects/paperclip/ui/src/components/MetricCard.tsx` |
| Hook | `/Users/macbook/Projects/paperclip/ui/src/hooks/useRoomMetrics.ts` |
| Testes | `/Users/macbook/Projects/paperclip/server/src/__tests__/room-metrics.test.ts` |
| Instrumentação | `/Users/macbook/Projects/paperclip/server/src/services/room-orchestrator.ts` |

### 6.2 Memória — spike

| Área | Path absoluto |
|------|---------------|
| Plugin wiki (inspiração, não obrigatório) | `/Users/macbook/Projects/paperclip/packages/plugins/plugin-llm-wiki/` |
| Agent home / skills PARA (upstream skill catalog) | `/Users/macbook/Projects/paperclip/packages/skills-catalog/` + skills agente |
| Spike doc (obrigatório) | `/Users/macbook/Projects/bizcursor/docs/research/slack-a2a-room/cycle-5-tech-specs/SPIKE-P5-memory-GO-NO-GO.md` *(criar no fim do spike)* |
| Se GO — bridge service | `/Users/macbook/Projects/paperclip/server/src/services/room-memory-bridge.ts` |
| Se GO — inject no wake | pontos em `heartbeat.ts` / room-orchestrator wake path |
| Referência BizCursor (não implementar) | `/Users/macbook/Projects/bizcursor/docs/phases/f4-para-memory/SPEC.md` |

### 6.3 Critérios GO do spike

| Critério | GO se |
|----------|-------|
| Latência inject | p95 &lt; 200ms keyword top-K |
| Path `$AGENT_HOME` legível no Coolify | Sim para `opencode_local` agent-of-record |
| Sem split-brain | Agente continua dono dos arquivos PARA |
| Escopo | ≤ 400 LOC bridge + testes |

Qualquer falha → **NO-GO** e defer.

### 6.4 Contrato métricas (alvo)

```ts
type RoomMetricsWindow = {
  companyId: string;
  roomId?: string;
  windowDays: 7 | 30;
  mentions: number;
  fanouts: number;
  joins: { success: number; timeout: number; failed: number };
  joinSuccessRate: number; // 0..1
  costPerSessionCents: { median: number; p95: number; samples: number };
};
```

---

## 7. Smoke tests (ST-P5-XX)

| ID | Cenário | Esperado |
|----|---------|----------|
| **ST-P5-01** | 10 posts com `@A` | mentions ≥ 10 no window |
| **ST-P5-02** | 3 fan-outs `@A @B` | fanouts = 3 |
| **ST-P5-03** | 2 joins OK, 1 timeout | joinSuccessRate = 2/3 |
| **ST-P5-04** | Threads com custo P4 | cost/session mediana coerente |
| **ST-P5-05** | Operator não PATCH métricas | read-only / 403 write |
| **ST-P5-06** | Spike report existe com GO ou NO-GO | arquivo + decisão no INDEX |
| **ST-P5-07** | Se GO: wake com snippet injetado | log/run context contém marcador `room-memory` |
| **ST-P5-08** | Se NO-GO: UI sem item “Memória” falso | grepped |

---

## 8. Definição de pronto (DoD)

- [ ] RF-P5-R-01..05 Must + dashboard Board
- [ ] SPIKE-P5-MEM concluído com GO ou NO-GO escrito
- [ ] Se GO: RF-P5-M-02 mínimo + testes; se NO-GO: anti-claim no P6 checklist
- [ ] ST-P5-01..06 passam
- [ ] Métricas usáveis no piloto Software House (amostra ≥20 threads)
- [ ] Sem PII de corpo de mensagem no dashboard default
- [ ] OpenAPI room-metrics documentado

---

## 9. Riscos

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Escopo memória engole P5 | Atraso GA | Timebox + NO-GO permitido |
| `$AGENT_HOME` inacessível no Coolify | Spike sempre NO-GO | Aceitar; métricas seguem |
| Contar mention wake como fan-out | Métrica mentirosa | Fan-out só com orchestration N≥2 |
| Cost/session com N=0 | Divisão zero | `samples` + hide card |
| Overlap plugin-llm-wiki | Confusão produto | Wiki ≠ PARA room; docs claros |
| Instrumentação síncrona lenta | UX send | Async enqueue |

---

## 10. Dependências

```
P4 (cost/session)
  → P5 metrics Must
  → SPIKE memory ∥ (paralelo, não bloqueia métricas)
       → P6 (playbooks usam métricas; memória só se GO)
```
