# P3 — Peer Wait, HITL Cards e Quorum

> **Versão:** 1.0  
> **Data:** 2026-07-09  
> **Ciclo:** 5 — Tech specs  
> **Repo de implementação:** fork `/Users/macbook/Projects/paperclip` (`QuadriniL/paperclip`)  
> **Pré-requisitos:** P0 (foundation + flag), P1 (Slack-mode MVP: `@`, silent-until-@, human owner), P2 (bridge room → A2A fan-out + `waitAllSec`)  
> **BizCursor desktop:** fora de escopo (produto só no fork; cherry-pick de padrões HITL/trace opcional depois)  
> **Confiança:** Alta nos paths do fork; média em Magentic (padrão, não API)

---

## 1. Contexto

### 1.1 Por que P3 existe

P2 entrega fan-out `@A @B` com join via `wait:false` + `waitAllSec` (barreira com timeout). Isso cobre o caso “todos terminam ou o timer estoura”, mas **não** cobre três padrões confirmados na pesquisa (Cycles 1–3):

| Padrão | Fonte | Gap pós-P2 |
|--------|-------|------------|
| **Peer wait** | Co-Gym `WaitTeammateContinue` | Agente A precisa **esperar o colega B** (não o humano) sem fechar o join cedo nem busy-poll |
| **HITL / input-required** | A2A `input-required` + Paperclip issue-thread interactions | Agente pausa pedindo **humano**; UI precisa de **cards** acionáveis na sala (não só comentário solto) |
| **Quorum opcional** | Aegean | Barrier cego “100% dos filhos” é anti-padrão; join parcial por **quorum** ou timeout |

Sem P3, a sala vira GroupChat com barreira rígida: caro, frágil a um filho lento, e sem gate humano auditável no thread (anti-hype Gartner/McKinsey).

### 1.2 Decisões já tomadas (não reabrir)

1. Path **B / Slack+@**; produto **só no fork**.
2. Motor A2A = `run-delegation` existente — **não** segundo waiter registry.
3. Humano **nunca** recebe agent JWT no WebView; HITL responde via Board session / board API key.
4. Default orquestração: **SAS → cascade** (Gao); paralelo só com política explícita + timeout/quorum.
5. Mentions `agent://` sozinhas ≠ join A2A (permanece verdade).

### 1.3 Personas

| Persona | Job em P3 |
|---------|-----------|
| **Sofia (Operator)** | Ver “Dev aguardando QA…” / “Precisa de você” e responder no card sem abrir Issues |
| **Board** | Auditar `waiting_peer` / `input-required`, cancelar hop, ver política quorum vs barrier |
| **Agente** | Declarar peer wait ou pedir input humano via contrato tipado; retomar após resolução |

### 1.4 Glossário

| Termo | Definição |
|-------|-----------|
| **Peer wait** | Run/hop A fica `awaiting_peer` até hop B atingir estado terminal (ou timeout) |
| **HITL card** | UI na sala para `ask_user_questions` / `request_confirmation` / A2A `input-required` |
| **Quorum** | Join sucede quando ≥ `k` de `N` filhos terminam com sucesso (Aegean-style) |
| **Barrier (`waitAllSec`)** | Join espera **todos** os filhos até T segundos (já no fork) |
| **Co-Gym pattern** | “Esperar colega continuar” — padrão de produto, **não** dependência de lib Co-Gym |
| **Magentic pattern** | Orquestrador magentic-one-like: planner + specialists + human gate; inspiração de **turn policy**, não port do framework |

---

## 2. Requisitos funcionais (RF-P3-XX)

| ID | Requisito | MoSCoW |
|----|-----------|--------|
| **RF-P3-01** | Agente em run pode declarar **peer wait** por `targetAgentId` ou `targetChildRunId` (esperar colega do mesmo fan-out / mesma room orchestration) | Must |
| **RF-P3-02** | Peer wait **não** busy-poll: usa waiter registry / continuation wake (mesmo espírito de `waitAllSec`) | Must |
| **RF-P3-03** | Timeout de peer wait configurável (default ≤ `DELEGATION_WAIT_TIMEOUT_MAX_SEC`); ao estourar → estado `peer_timeout` + mensagem de sistema na sala | Must |
| **RF-P3-04** | UI da sala mostra chip/status **“Aguardando @B…”** no hop A enquanto peer wait ativo | Must |
| **RF-P3-05** | Quando um hop entra em A2A `input-required` (ou cria issue-thread interaction), a sala renderiza **HITL card** inline no thread | Must |
| **RF-P3-06** | HITL cards reutilizam kinds existentes: `ask_user_questions`, `request_confirmation` (e approval board quando aplicável) | Must |
| **RF-P3-07** | Resposta ao card (accept / answer / cancel) **retoma** o agente requester via wake existente (`PAPERCLIP_APPROVAL_*` / thread interaction answered) | Must |
| **RF-P3-08** | Política de join da room orchestration aceita `join: "all" \| "quorum"`; se `quorum`, campo `quorumCount` (1 ≤ k ≤ N) | Must |
| **RF-P3-09** | Com `join: "all"`, comportamento = `waitAllSec` atual (compatível P2) | Must |
| **RF-P3-10** | Com `join: "quorum"`, parent settle quando k filhos `succeeded` **ou** timeout; filhos restantes podem continuar ou ser cancelados conforme `onQuorumMet: "leave_running" \| "cancel_rest"` | Should |
| **RF-P3-11** | Skill `paperclip-room` documenta: peer wait vs barrier vs quorum; proíbe “esperar todos para sempre” | Must |
| **RF-P3-12** | Cancel do owner humano cancela peer waits e HITL pendentes do grafo daquela orquestração (cascata já existente + extensão) | Must |
| **RF-P3-13** | Magentic-like: modo `orchestration.mode: "cascade"` permanece default; peer wait é opt-in do agente, não round-robin automático | Should |
| **RF-P3-14** | Board density: painel técnico mostra `awaiting_peer`, `input-required`, quorum k/N | Should |
| **RF-P3-15** | Métricas mínimas emitidas (eventos): `room.peer_wait.started/resolved/timeout`, `room.hitl.card.shown/answered`, `room.join.quorum_met` | Could |

---

## 3. Requisitos não funcionais (RNF-P3-XX)

| ID | Requisito | Métrica |
|----|-----------|---------|
| **RNF-P3-01** | Diff mínimo no control plane | Estender `run-delegation` / room-orchestrator; **não** novo motor de wait |
| **RNF-P3-02** | Latência de ack de peer wait na UI | &lt; 2 s até chip “Aguardando @B” |
| **RNF-P3-03** | Latência de HITL card após `input-required` | &lt; 2 s até card visível (SSE/poll) |
| **RNF-P3-04** | Sem agent JWT no browser | 100% das respostas HITL via Board auth |
| **RNF-P3-05** | Caps inalterados | `maxDepth` 3, `maxChildren` 5 (hard caps existentes) |
| **RNF-P3-06** | Testes | Unit + integration no server; UI card smoke |
| **RNF-P3-07** | Compatibilidade P2 | Fan-out `join: "all"` + `waitAllSec` sem regressão |

---

## 4. MoSCoW (resumo)

| Must | Should | Could | Won't (P3) |
|------|--------|-------|------------|
| Peer wait event-driven + UI | `onQuorumMet` cancel_rest | Métricas de evento | Cliente A2A JSON-RPC |
| HITL cards na sala (reuse interactions) | Board density detalhada | Magentic planner agent dedicado | Cross-company peer wait |
| Quorum opcional vs barrier | Skill room atualizada | — | Round-robin GroupChat obrigatório |
| Cascata de cancel | — | — | Dependência runtime Co-Gym/Magentic |

---

## 5. UX

### 5.1 Peer wait (Sofia)

```
@Dev: preciso do resultado do @QA antes de abrir PR
→ chip no hop Dev: “Aguardando @QA…”
→ quando QA posta/termina: chip some; Dev retoma (wake)
→ se timeout: “@QA não respondeu a tempo” + ações [Cancelar hop] [Estender espera]
```

### 5.2 HITL card (input-required)

Reutilizar visual de `IssueThreadInteractionCard` / `ApprovalCard` **dentro** do stream da Conference Room:

| Kind | UI Sofia | Ações |
|------|----------|-------|
| `ask_user_questions` | Card com perguntas tipadas | Enviar respostas |
| `request_confirmation` | Card “Confirma plano X?” | Aceitar / Rejeitar / Comentar (supersede) |
| `request_board_approval` | Card de approval | Approve / Deny (Board) |

**Regras:**

- Card **sticky** no thread até resolução ou cancel.
- Só **owner** / approver com permissão responde (reuse `access` / authz).
- Sofia **não** vê JSON de payload cru; Board pode expandir.

### 5.3 Quorum vs barrier (composer / advanced)

| Modo | Label UI | Default |
|------|----------|---------|
| `all` + `waitAllSec` | “Esperar todos (até Ts)” | Sim (P2) |
| `quorum` | “Quorum k de N” | Opt-in advanced |

Empty state Board: tooltip “Barrier cego é caro — prefira quorum ou cascade”.

### 5.4 Anti-padrões de UX (recusar)

- Spinner modal bloqueando o canal inteiro.
- Auto-aprovar HITL por timeout.
- Esconder “precisa de você” só em Issues fora da sala.

---

## 6. Arquitetura (paths no fork)

### 6.1 Diagrama

```
Humano / Agente
    │
    ▼
room-orchestrator / run-delegation
    │
    ├── join: all     → waitAllSec (existente)
    ├── join: quorum  → quorumSettler (P3)
    ├── peer wait     → peerWaitRegistry (P3, mesmo event bus de child-terminal)
    └── input-required → issue-thread-interactions + room HITL surface (P3)
              │
              ▼
BoardChat / IssueChatThread surface + IssueThreadInteractionCard
```

### 6.2 Arquivos — REUSAR

| Área | Path absoluto |
|------|---------------|
| Delegação / waitAllSec | `/Users/macbook/Projects/paperclip/server/src/services/run-delegation.ts` |
| Heartbeat wiring | `/Users/macbook/Projects/paperclip/server/src/services/heartbeat.ts` |
| Issue thread interactions | `/Users/macbook/Projects/paperclip/server/src/services/issue-thread-interactions.ts` |
| Schema interactions | `/Users/macbook/Projects/paperclip/packages/db/src/schema/issue_thread_interactions.ts` |
| Approvals | `/Users/macbook/Projects/paperclip/server/src/services/approvals.ts` |
| Access / authz | `/Users/macbook/Projects/paperclip/server/src/services/access.ts`, `.../authorization.ts` |
| UI interaction card | `/Users/macbook/Projects/paperclip/ui/src/components/IssueThreadInteractionCard.tsx` |
| UI approval card | `/Users/macbook/Projects/paperclip/ui/src/components/ApprovalCard.tsx` |
| Validators delegation | `/Users/macbook/Projects/paperclip/packages/shared/src/validators/delegation.ts` |
| Spec A2A | `/Users/macbook/Projects/paperclip/doc/spec/agent-delegation-a2a.md` |
| Skill agente | `/Users/macbook/Projects/paperclip/skills/paperclip/SKILL.md` |

### 6.3 Arquivos — ADAPTAR / CONSTRUIR

| Área | Path absoluto proposto |
|------|------------------------|
| Room orchestrator | `/Users/macbook/Projects/paperclip/server/src/services/room-orchestrator.ts` |
| Room policy (quorum defaults) | `/Users/macbook/Projects/paperclip/server/src/services/room-policy.ts` |
| Peer wait helper (slice no mesmo serviço ou arquivo irmão) | `/Users/macbook/Projects/paperclip/server/src/services/peer-wait.ts` |
| Validators room | `/Users/macbook/Projects/paperclip/packages/shared/src/validators/room-orchestration.ts` |
| Rotas room / HITL bridge | `/Users/macbook/Projects/paperclip/server/src/routes/board-room.ts` |
| OpenAPI | `/Users/macbook/Projects/paperclip/server/src/routes/openapi.ts` |
| BoardChat surface | `/Users/macbook/Projects/paperclip/ui/src/pages/BoardChat.tsx` |
| HITL na sala (thin wrapper) | `/Users/macbook/Projects/paperclip/ui/src/components/RoomHitlCard.tsx` |
| Skill room | `/Users/macbook/Projects/paperclip/skills/paperclip-room/SKILL.md` |
| Testes | `/Users/macbook/Projects/paperclip/server/src/__tests__/peer-wait.test.ts`, `room-quorum.test.ts`, `room-hitl.test.ts` |

### 6.4 Contrato de política (alvo)

```ts
type JoinPolicy =
  | { join: "all"; waitAllSec: number }
  | {
      join: "quorum";
      waitAllSec: number;
      quorumCount: number;
      onQuorumMet: "leave_running" | "cancel_rest";
    };

type PeerWaitRequest = {
  parentRunId: string;
  waiterRunId: string;
  targetChildRunId: string;
  timeoutSec: number;
};
```

### 6.5 Mapeamento A2A

| Estado A2A | Room |
|------------|------|
| `working` | “Trabalhando…” |
| `input-required` | HITL card |
| `completed` / `failed` / `canceled` | Terminal no hop |
| (extensão) peer wait | Chip “Aguardando peer” (metadado Paperclip; não inventar estado A2A oficial) |

---

## 7. Smoke tests (ST-P3-XX)

| ID | Cenário | Esperado |
|----|---------|----------|
| **ST-P3-01** | Fan-out `@A @B`, `join: all`, `waitAllSec=60` | Join quando ambos terminam (regressão P2) |
| **ST-P3-02** | Fan-out 3 agentes, `join: quorum`, `quorumCount=2` | Parent settle após 2 successes; UI mostra 2/3 |
| **ST-P3-03** | A declara peer wait em B | Chip “Aguardando @B”; A não terminal até B ou timeout |
| **ST-P3-04** | Peer wait timeout | Mensagem sistema + hop A `peer_timeout`; sem busy-poll CPU |
| **ST-P3-05** | A cria `ask_user_questions` | Card na sala; Sofia responde; A retoma |
| **ST-P3-06** | `request_confirmation` + supersede por comentário | Outcome `superseded_by_comment`; card fecha |
| **ST-P3-07** | Owner cancela orquestração com peer wait + HITL pendente | Filhos + waits + cards cancelados |
| **ST-P3-08** | Browser DevTools: sem agent JWT em network da resposta HITL | Só session/board auth |
| **ST-P3-09** | Coolify: mesmo fluxo sem `spawn(claude)` | Via adapter wake (P1/P2 path) |

---

## 8. Definição de pronto (DoD)

- [ ] RF-P3-01..12 Must implementados e cobertos por teste ou smoke
- [ ] Quorum documentado como **opt-in**; default permanece `all` + `waitAllSec` ou cascade
- [ ] HITL cards na Conference Room reutilizam interactions existentes (sem segundo schema paralelo)
- [ ] Skill `paperclip-room` atualizada com peer wait / quorum / anti-barrier
- [ ] ST-P3-01..08 passam em ambiente local; ST-P3-09 em Coolify staging
- [ ] Sem regressão nos testes de `run-delegation-integration`
- [ ] OpenAPI atualizado para campos de join/quorum e peer wait (se expostos)
- [ ] Nota de research: Co-Gym/Magentic = padrões, não deps

---

## 9. Riscos

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Duplicar waiter registry | Deadlocks / wakes duplicados | Estender `run-delegation` only |
| Quorum cancela trabalho útil | Perda de resultado tardio | Default `onQuorumMet: "leave_running"` |
| HITL só em Issues, não na sala | Sofia não vê | `RoomHitlCard` obrigatório no BoardChat stream |
| Peer wait vira deadlock A↔B | Hang | Timeout obrigatório + cancel owner |
| Agente finge peer wait via sleep | Custo | Skill + detecção: só API tipada conta |
| Confundir mention wake com peer wait | Join falso | Docs + UI: peer wait só com `targetChildRunId` do fan-out |
| Magentic over-engineering | Escopo explode | Won't: sem port de framework |

---

## 10. Dependências e ordem

```
P2 (fan-out + waitAllSec + human API)
  → P3 (peer wait + HITL cards + quorum)
    → P4 (custo por hop/sessão — precisa estados estáveis de hop)
```

**Referências Cycle 3:** `01-protocol-and-orchestration.md` §3.2.3–3.2.5, §5.1; `04-paperclip-gap-analysis.md` §3.1–3.3; `02-ux-slack-room.md` §1.4.
