# P0–P6 Room SPECs — Deltas Path B+ (Cycle 5C)

> **Data:** 2026-07-09  
> **Propósito:** checklist do que **muda / adiciona / reforça** nas SPECs Room existentes por causa do Path **B+** (Conference Room **+** Hybrid Team & Performance).  
> **Não reescreve** P0–P6 — apenas deltas com referência a `../cycle-5-tech-specs/P*-SPEC.md`.  
> **Plano canônico:** [`../cycle-4c-hybrid-plan/00-PRODUCT-PLAN-HYBRID-V2.md`](../cycle-4c-hybrid-plan/00-PRODUCT-PLAN-HYBRID-V2.md)  
> **Inserts híbridos (SPECs próprias):** [`../cycle-5b-clickup-tech-specs/`](../cycle-5b-clickup-tech-specs/)

`NotebookLM: skip (non-Villa) — Path B+ room SPEC deltas`

---

## 0. Como usar este documento

| Situação | Ação |
|----------|------|
| Implementar fase Room Pn | Ler SPEC Room **e** a seção **Δ-Pn** abaixo |
| Conflito RF Room vs delta | **Delta vence** (Path B+) — registrar no PR |
| Capacidade só Hybrid (.5) | Implementar SPEC 5B; Room só precisa dos hooks listados aqui |
| Smoke | Manter `ST-Pn-*` da SPEC Room; adicionar checks Δ listados |

**Legenda de delta**

| Tag | Significado |
|-----|-------------|
| **ADD** | Novo RF / smoke / DoD não presente (ou só implícito) na SPEC Room |
| **OVERRIDE** | Altera comportamento ou DoD da SPEC Room |
| **REINFORCE** | Já está na SPEC Room; Path B+ torna **obrigatório** / não negociável |
| **HOOK** | Room deve emitir evento/contrato consumido por insert `.5` |
| **DEFER** | Explicitamente fora da fase Room; vive no insert `.5` ou P6 |

---

## Δ-P0 — Foundation

**SPEC base:** [`../cycle-5-tech-specs/P0-foundation-SPEC.md`](../cycle-5-tech-specs/P0-foundation-SPEC.md)

### O que permanece (sem delta)

- Flag `enableConferenceRoomChat`, auth board, agents listáveis, standing issue Board Operations.
- Baseline 1:1 e política silent-until-@ como regra de produto.
- Paths âncora: `board-chat.ts`, `BoardChat.tsx`, `useConferenceRoomChatEnabled.ts`.

### Deltas Path B+

| ID | Tag | Delta | Motivo B+ |
|----|-----|-------|-----------|
| **Δ-P0-01** | **REINFORCE** | Path Coolify **MUST** ser `adapter_wake` / `paperclipChatWake` — spawn `claude` CLI é **FORBIDDEN** em deploy remoto GA-bound | D-08 · 4C runtime · gap PR-F3 |
| **Δ-P0-02** | **OVERRIDE** | DoD P0: contrato `mode: "adapter_wake_pending" \| "silent"` estável em staging Coolify (não só “plano escrito” de migração) | 4C fecha Coolify-safe cedo |
| **Δ-P0-03** | **ADD** | Composer Room: baseline de **mention chips** (`agent://`) via MarkdownEditor / MentionOption — mesmo se wake host completo for P1 | Prepara P1 + P1.5 Ask draft |
| **Δ-P0-04** | **HOOK** | Persistência de `roomMessageId` + `mentionedAgentIds` tipados (Zod) — payload consumível por room-orchestrator e Work Request | Bridge P1 / P1.5 |
| **Δ-P0-05** | **REINFORCE** | Mensagem **sem** `@` e sem Ask/assign → **0** wakes (silent) | D-10; P5.5 só reforça policy editor |
| **Δ-P0-06** | **ADD** | Documentar no PR P0: adapters beachhead `cursor_cloud` + `opencode_local` apenas no contrato Operator | Stack BizCursor / AGENTS.md |
| **Δ-P0-07** | **DEFER** | Team Panel / roster unificado → **P2.5** (não inventar AI Hub na P0) | D-13 |
| **Δ-P0-08** | **HOOK** | Feature flag Room não bloqueia leitura futura de Hybrid flags; settings instance devem coexistir | P6 team mgmt / GA B+ |

### Smoke / DoD extras

| Check | Critério |
|-------|----------|
| ST-Δ-P0-01 | Coolify staging: authenticated + `@` → `adapter_wake_pending` **sem** processo `claude` CLI |
| ST-Δ-P0-02 | Sem `@` → `silent`; zero heartbeat wakeup |
| ST-Δ-P0-03 | Composer aceita chip `agent://` (mesmo que FANOUT_NOT_ENABLED para N>1) |

### Referências cruzadas

- Gap matrix §2.0: [`../cycle-3c-hybrid-deep-dive/05-implementation-gap-matrix.md`](../cycle-3c-hybrid-deep-dive/05-implementation-gap-matrix.md)  
- Risks Coolify: [`../cycle-4c-hybrid-plan/03-risks-and-rollout.md`](../cycle-4c-hybrid-plan/03-risks-and-rollout.md)

---

## Δ-P1 — Single mention

**SPEC base:** [`../cycle-5-tech-specs/P1-single-mention-SPEC.md`](../cycle-5-tech-specs/P1-single-mention-SPEC.md)

### O que permanece

- `room-orchestrator` single `@` → host run; reply no thread; cost pill básica por turn.
- Multi-mention continua `400 FANOUT_NOT_ENABLED` até P2.

### Deltas Path B+

| ID | Tag | Delta | Motivo B+ |
|----|-----|-------|-----------|
| **Δ-P1-01** | **OVERRIDE** | **Mentions no composer da Room são Must de UX** — `ChatComposer` plain sem `@` é gap C5; Room **MUST** usar MarkdownEditor + chips (não “nice-to-have”) | PR-F4 · D-01 |
| **Δ-P1-02** | **ADD** | Human **owner** da thread/room session **sempre visível** na UI (nome/avatar) quando há wake | Prepara D-12 / P1.5 |
| **Δ-P1-03** | **HOOK** | `reason=conference_room_mentioned` (ou equivalente) + `roomMessageId` no wakeup — estável para Ask reusar o mesmo path | P1.5 Work Request |
| **Δ-P1-04** | **REINFORCE** | Wake **somente** server-side (board session → host run); **FORBIDDEN** expor agent/run JWT ao WebView | PR-F1 |
| **Δ-P1-05** | **ADD** | Skill sala: documentar silent-until-@ + single wake (ADAPT `paperclip-board` → skill Conference Room) | 4C journeys J1/J2 |
| **Δ-P1-06** | **HOOK** | Evento telemetria `room.mention.single` (agentId, roomMessageId, ownerUserId) — alimenta P5 / P4.5 | Dual + room metrics |
| **Δ-P1-07** | **DEFER** | Botão Ask / templates / assign-as-delegate → **P1.5** | SPEC 5B |
| **Δ-P1-08** | **ADD** | DoD P1 Path B+: Sofia consegue `@CEO` **e** o mesmo wake path é reutilizável por API interna de Work Request (sem segundo motor) | Unificação intake |

### Smoke / DoD extras

| Check | Critério |
|-------|----------|
| ST-Δ-P1-01 | Composer Room: digitar `@` lista agentes; chip inserido |
| ST-Δ-P1-02 | Owner humano visível no header/thread durante run |
| ST-Δ-P1-03 | Wake via orchestrator; zero JWT de run no network tab do browser |

---

## Δ-P2 — Fan-out + join + trace

**SPEC base:** [`../cycle-5-tech-specs/P2-fanout-join-SPEC.md`](../cycle-5-tech-specs/P2-fanout-join-SPEC.md)

### O que permanece

- Fan-out `@A @B`, `wait:false` / `waitAllSec`, bridge room→A2A via `run-delegation`, DelegationTrace UI.

### Deltas Path B+

| ID | Tag | Delta | Motivo B+ |
|----|-----|-------|-----------|
| **Δ-P2-01** | **ADD** | Fan-out **preserva** human owner da sessão; children = delegates (nunca reassign owner para agente) | D-12 |
| **Δ-P2-02** | **HOOK** | Trace hops expõem `agentId`, `parentRunId`, status — consumíveis por Team Panel capacity (busy/idle) | P2.5 |
| **Δ-P2-03** | **HOOK** | Telemetria `room.fanout.started` / `room.join.completed` (success\|timeout) | P5 + P4.5 |
| **Δ-P2-04** | **REINFORCE** | REUSE `run-delegation` + MCP — **não** reinventar protocolo A2A | D-03 · D-04 |
| **Δ-P2-05** | **ADD** | Se P1.5 já shipped: fan-out a partir de Ask multi-agent (template) usa o **mesmo** orchestrator P2 | Unificação intake |
| **Δ-P2-06** | **OVERRIDE** | Trace **não** vira dashboard de KPIs — só narrativa de hops; KPIs ficam em Insights (P4.5) | D-11 |
| **Δ-P2-07** | **DEFER** | Capacity lanes / roster merge → **P2.5** | SPEC 5B |

### Smoke / DoD extras

| Check | Critério |
|-------|----------|
| ST-Δ-P2-01 | Após fan-out, owner humano inalterado; agentes = delegates nos hops |
| ST-Δ-P2-02 | Eventos join success/timeout gravados para métricas |

---

## Δ-P3 — Peer wait / HITL / quorum

**SPEC base:** [`../cycle-5-tech-specs/P3-peer-wait-hitl-SPEC.md`](../cycle-5-tech-specs/P3-peer-wait-hitl-SPEC.md)

### O que permanece

- Peer wait event-driven, HITL cards (`input-required`), `join: all|quorum` vs barrier.

### Deltas Path B+

| ID | Tag | Delta | Motivo B+ |
|----|-----|-------|-----------|
| **Δ-P3-01** | **ADD** | HITL card mostra **quem** (humano owner / approver) e **qual agente** pediu input — labels alinhados ao roster (se P2.5 existir) | D-12 · UX híbrida |
| **Δ-P3-02** | **HOOK** | Duração HITL (`openedAt`→`resolvedAt`) emitida para **cost dual** (tempo de intervenção + $) | P4 Δ + P4.5 |
| **Δ-P3-03** | **REINFORCE** | Quorum é opt-in; default barrier/`waitAllSec` — não “magia Magentic” | Anti-hype · Cycle 5 P3 |
| **Δ-P3-04** | **ADD** | Card HITL **nunca** auto-resolve por Autopilot/routine | D-10 |
| **Δ-P3-05** | **HOOK** | Contador `room.hitl.interventions` para Dual Performance (reliance / human gate) | P4.5 P0 metrics |
| **Δ-P3-06** | **DEFER** | Policy editor de proatividade → **P5.5** (P3 só consome “Room silent”) | SPEC 5B |

### Smoke / DoD extras

| Check | Critério |
|-------|----------|
| ST-Δ-P3-01 | HITL exige ação humana; routine/cron não fecha o card |
| ST-Δ-P3-02 | Intervention duration disponível para agregação P4/P4.5 |

---

## Δ-P4 — Costs / roles / density

**SPEC base:** [`../cycle-5-tech-specs/P4-costs-roles-SPEC.md`](../cycle-5-tech-specs/P4-costs-roles-SPEC.md)

### O que permanece

- Cost pill hop/session na room; alerts 80/100; Operator vs Board density; REUSE `costs`/`budgets`.

### Deltas Path B+

| ID | Tag | Delta | Motivo B+ |
|----|-----|-------|-----------|
| **Δ-P4-01** | **ADD** | **Cost dual hooks:** além de `$` por hop/session, expor **HITL duration** agregada da sessão (intervenção humana) no payload Board-density | 4C KPI · dual cost $ + tempo |
| **Δ-P4-02** | **HOOK** | API/session summary emite campos estáveis (`sessionCostUsd`, `hopCosts[]`, `hitlDurationMs`, `interventionCount`) para `dual-performance` | P4.5 |
| **Δ-P4-03** | **OVERRIDE** | Stream da Room: **apenas** pills/toasts — **proibido** widgets de capacity/KPI dual no hero do chat | D-11 |
| **Δ-P4-04** | **REINFORCE** | Sem ledger paralelo; hard-stop Paperclip autoritativo | P4 SPEC + FORBIDDEN gap |
| **Δ-P4-05** | **ADD** | Roles density: Operator vê semáforo + total; Board vê breakdown — alinhado a digests Sofia vs Board em P4.5 | D-11 density |
| **Δ-P4-06** | **HOOK** | Budget incident 80/100 na room também incrementa telemetria `room.budget.alert` (severity Dual Risk lane) | P4.5 |
| **Δ-P4-07** | **DEFER** | Dashboard Dual completo / digest semanal → **P4.5** | SPEC 5B |

### Smoke / DoD extras

| Check | Critério |
|-------|----------|
| ST-Δ-P4-01 | Payload session inclui `$` **e** `hitlDurationMs` (0 se sem HITL) |
| ST-Δ-P4-02 | Nenhum painel Dual renderizado dentro do stream BoardChat |
| ST-Δ-P4-03 | `GET` summary room session compatível com contrato Zod esperado por P4.5 |

### Nota de implementação

Os hooks Δ-P4-* são o **contrato mínimo** Room→Hybrid. P4.5 pode stub UI se telemetria P5-R atrasar, mas **não** pode inventar segunda fonte de custo.

---

## Δ-P5 — Memory + room metrics

**SPEC base:** [`../cycle-5-tech-specs/P5-memory-metrics-SPEC.md`](../cycle-5-tech-specs/P5-memory-metrics-SPEC.md)

### O que permanece

- Must: mentions, fan-outs, join success, cost/session + dashboard Board.
- Memória PARA: spike GO/NO-GO timeboxed; defer permitido.

### Deltas Path B+

| ID | Tag | Delta | Motivo B+ |
|----|-----|-------|-----------|
| **Δ-P5-01** | **ADD** | Room metrics Must incluem contadores já hooked: `mention.single`, `fanout`, `join`, `hitl.interventions`, `budget.alert` | Alimenta P4.5 7 KPIs |
| **Δ-P5-02** | **HOOK** | Export/`GET` room-metrics tipado para merge em `dual-performance` (não duplicar UI Dual na P5) | D-11 · P4.5 |
| **Δ-P5-03** | **OVERRIDE** | Dashboard P5 Board = métricas **da room/orquestração**; KPIs human\|agent\|room unificados ficam em **P4.5 Insights** | Separação superfícies |
| **Δ-P5-04** | **REINFORCE** | Spike memória PARA: se NO-GO, anti-claim obrigatório (sem “memória híbrida” no pitch) | Anti-washing |
| **Δ-P5-05** | **ADD** | Instrumentar `ownerUserId` / `delegateAgentId` nos eventos (quando P1.5 ativo) para co-touch / reliance | P0 Dual metrics 2C |
| **Δ-P5-06** | **DEFER** | Proactivity policy editor + whitelist UX → **P5.5** | SPEC 5B |
| **Δ-P5-07** | **HOOK** | P5.5 consome a mesma regra silent: métrica `room.ambient.wake_attempts` **deve ser 0** em piloto | D-10 |

### Smoke / DoD extras

| Check | Critério |
|-------|----------|
| ST-Δ-P5-01 | Room metrics API retorna campos necessários aos 7 KPIs P0 (ou null explícito) |
| ST-Δ-P5-02 | Zero ambient wakes em fixture de piloto (silent enforced) |

---

## Δ-P6 — GA + playbooks

**SPEC base:** [`../cycle-5-tech-specs/P6-ga-playbooks-SPEC.md`](../cycle-5-tech-specs/P6-ga-playbooks-SPEC.md)

### O que permanece

- Graduar `enableConferenceRoomChat`, Coolify checklist, playbooks SH + Support, guia Sofia, anti-washing.

### Deltas Path B+

| ID | Tag | Delta | Motivo B+ |
|----|-----|-------|-----------|
| **Δ-P6-01** | **OVERRIDE** | GA = **Path B+ completo** (Room **e** Hybrid Must: P1.5, P2.5, P4.5, P5.5) — não graduar só o chat | D-09 · 4C |
| **Δ-P6-02** | **ADD** | **Team management in P6:** docs + settings para membership room/company, convite Operator, papéis Board vs Sofia, link ao Team Panel (P2.5) | 4C GA · roster ops |
| **Δ-P6-03** | **ADD** | Checklist Coolify GA inclui: `adapter_wake` only, flags Room+Hybrid, routines **fora** da Room, budgets, Dual Insights reachable | 4C risks |
| **Δ-P6-04** | **ADD** | Playbooks SH/Support atualizam jornadas J1–J6 (Ask, Team Panel, Dual review, policy) — não só `@` na sala | 4C `01-operator-journeys-sofia.md` |
| **Δ-P6-05** | **ADD** | Guia Sofia PT-BR: seções Ask / “onde ver o time” / “onde ver custo da semana” / “o que a IA não faz sozinha” | Operator-first |
| **Δ-P6-06** | **OVERRIDE** | Anti-washing checklist **Must** banir: Autopilot-na-sala, agent-as-assignee Plane-style, “substitui o time”, ROAS mágico | D-10 · D-12 · beachhead |
| **Δ-P6-07** | **ADD** | Kill-switch: desligar Room **e** (opcional independente) Hybrid surfaces; documentar ordem de rollback | 4C rollout |
| **Δ-P6-08** | **ADD** | Template piloto 30d usa KPIs de [`../cycle-4c-hybrid-plan/02-kpi-and-success-metrics.md`](../cycle-4c-hybrid-plan/02-kpi-and-success-metrics.md) (não só métricas Room P5) | Success B+ |
| **Δ-P6-09** | **REINFORCE** | BizCursor desktop Room **fora** do GA crítico | 4C / Cycle 5 |
| **Δ-P6-10** | **ADD** | CHANGELOG fork: breaking changes Room **e** Hybrid (Work Request, Dual API, proactivity-policy schema) | Ops Board |

### Smoke / DoD extras

| Check | Critério |
|-------|----------|
| ST-Δ-P6-01 | Checklist Coolify B+ assinada (Room + Hybrid) |
| ST-Δ-P6-02 | Docs team mgmt linkam P2.5; Sofia encontra Ask + Insights sem jargão |
| ST-Δ-P6-03 | Anti-washing: review de pitch sem claims banidos |
| ST-Δ-P6-04 | Rollback flag Room restaura UI pré-Room; Hybrid flags documentadas |

---

## Matriz resumo — Room SPEC × impacto B+

| Fase Room | Spec | Impacto B+ (resumo) | Insert relacionado |
|-----------|------|---------------------|--------------------|
| P0 | `P0-foundation-SPEC.md` | `adapter_wake` obrigatório; mentions baseline; silent reforçado | → P5.5 policy |
| P1 | `P1-single-mention-SPEC.md` | Mentions composer Must; owner visível; hooks Ask | → **P1.5** |
| P2 | `P2-fanout-join-SPEC.md` | Owner≠delegate; trace≠dashboard; hooks capacity | → **P2.5** |
| P3 | `P3-peer-wait-hitl-SPEC.md` | HITL duration + interventions; sem auto-resolve | → P4 / P4.5 |
| P4 | `P4-costs-roles-SPEC.md` | **Cost dual hooks** ($ + HITL time); sem Dual no stream | → **P4.5** |
| P5 | `P5-memory-metrics-SPEC.md` | Metrics alimentam Dual; ambient=0; memória anti-claim | → **P5.5** / P4.5 |
| P6 | `P6-ga-playbooks-SPEC.md` | GA B+; **team mgmt**; playbooks J1–J6; anti-washing expandido | todos `.5` |

---

## Checklist de leitura do implementer (por PR Room)

Copiar no PR da fase Room:

```
- [ ] Li ../cycle-5-tech-specs/P{N}-*-SPEC.md
- [ ] Li cycle-5c P0-P6-ROOM-DELTAS.md seção Δ-P{N}
- [ ] Apliquei ADD/OVERRIDE/HOOK listados
- [ ] Não implementei DEFER (deixei para .5 / outra fase)
- [ ] Smokes ST-P{N}-* + ST-Δ-P{N}-* verdes (ou justificativa staging)
- [ ] Sem FORBIDDEN (CLI Coolify, JWT no browser, ambient Autopilot, ledger paralelo)
```

---

## O que este arquivo deliberadamente NÃO faz

1. **Não** duplica RF completos das SPECs Room ou 5B.  
2. **Não** redefine a ordem de fases (ver INDEX 5C + plano 4C).  
3. **Não** autoriza editar silenciosamente `cycle-5-tech-specs/` sem atualizar este delta.  
4. **Não** substitui smoke tests numerados nas SPECs originais — só **adiciona** ST-Δ-*.

---

## Handoff rápido → subagent-driven-development

Para cada tarefa Room `Pn`:

1. Dispatch implementer com paths absolutos da SPEC + **esta** seção `Δ-Pn`.  
2. Spec-reviewer valida: todo **ADD/OVERRIDE/HOOK** da seção aparece no diff ou tem DEFER explícito.  
3. Code-quality-reviewer no fork Paperclip.  
4. Só então marcar DoD da fase no plano 4C.

Skill: `subagent-driven-development` (two-stage review). Repo: `/Users/macbook/Projects/paperclip`.
