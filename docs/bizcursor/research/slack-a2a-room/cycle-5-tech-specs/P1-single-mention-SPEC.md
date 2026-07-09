# P1 — Single Mention: @Agent → Host Run + Thread Reply
> Versão: 1.0 | Duração estimada: 1,5–2 semanas | Pré-requisitos: **P0 DoD** (silent-until-@, MarkdownEditor mentions, Coolify adapter_wake path)  
> **Repo de implementação:** `/Users/macbook/Projects/paperclip`  
> **Data:** 2026-07-09

## 1. Contexto e visão ampla

Com P0, a Conference Room já é silent-until-@ e Coolify-safe. **P1** completa o loop Slack 1:1: quando o humano menciona **um** agente (beachhead: **CEO**), o control plane cria um **host run** via wakeup de adapter, o agente responde **no mesmo thread** da sala (comentário com `authorAgentId`), e a UI mostra **cost pill** + estado da run.

Ainda **não** há fan-out `@A @B` (isso é P2). Multi-mention continua `400 FANOUT_NOT_ENABLED` (decisão P0).

### 1.1 Problema

Mention wake em issues (`issue_comment_mentioned`) dispara runs **independentes** por agente — não há "host" da sala, nem join A2A, nem UX de custo no BoardChat. P1 introduz o **room-orchestrator**: um serviço que, a partir de `roomMessageId` + um `targetAgentId`, cria o host run e correlaciona replies.

### 1.2 Escopo

| Dentro P1 | Fora P1 |
|-----------|---------|
| `@Agent` único → host run real (CEO) | Fan-out N agents + `wait:false` (P2) |
| Reply do agente no thread da sala | DelegationTrace UI (P2 cherry-pick) |
| Cost pill por turn/run | Budget caps F3 / BizCursor |
| Thread replies (comment parent / same issue stream) | Humano POST `/delegate` (continua agent-JWT only) |
| room-orchestrator service | Reimplementar `run-delegation` |

### 1.3 Cenário canônico

```
Sofia @ Coolify Conference Room:
  [@CEO](agent://ceo-uuid) resumir status dos goals da semana

  → P1 room-orchestrator:
       1. Persiste comment humano (roomMessageId)
       2. Valida single mention
       3. heartbeat.wakeup(CEO, reason=conference_room_mentioned, roomMessageId)
       4. Host run executa no adapter (opencode_local / cursor_cloud)
       5. Agente posta reply na Board Operations issue (mesmo thread)
  → UI:
       bubble CEO + cost pill ($X.XX) + link run
```

### 1.4 Premissas

- P0 entregue: mentions `agent://`, silent path, sem CLI Coolify.
- CEO (ou agente alvo) invokable; org chain válida.
- Adapters: `cursor_cloud`, `opencode_local` (BizCursor constraint — fork pode ter outros, beachhead usa estes).
- Agent Cards já existem: `GET /api/agents/:id/agent-card`.

---

## 2. Relação com o resto do projeto

### 2.1 Diagrama

```
┌──────────────┐   single @    ┌─────────────────────┐
│  BoardChat   │──────────────▶│  room-orchestrator  │
│  (P0+P1 UI)  │               │  (NEW service)      │
└──────▲───────┘               └──────────┬──────────┘
       │ reply comment                    │
       │                                  ▼
       │                       ┌─────────────────────┐
       │                       │  heartbeat.wakeup   │
       │                       │  (host run)         │
       │                       └──────────┬──────────┘
       │                                  │
       │                                  ▼
       │                       ┌─────────────────────┐
       └───────────────────────│  adapter runtime    │
         addComment(agent)     │  cursor_cloud /     │
                               │  opencode_local      │
                               └─────────────────────┘
```

### 2.2 Upstream / downstream

| Direção | Artefato | Uso P1 |
|---------|----------|--------|
| Upstream | P0 `room-message` + mentions | Entrada |
| Upstream | `heartbeat.wakeup` / `POST /api/agents/:id/wakeup` | Host run |
| Upstream | Issue comments + Board Operations | Thread |
| Upstream | `visibleRunCostUsd` / costs services | Cost pill |
| Upstream | Agent Cards | Descoberta / skills (read-only) |
| Downstream | P2 | Host run vira parent de fan-out `paperclipDelegate` |
| Downstream | Beachhead software house | SH-1 single-agent triage |

### 2.3 Por que room-orchestrator (não só issue mention wake)

| Issue mention wake | Room orchestrator P1 |
|--------------------|----------------------|
| N wakes independentes | 1 host run explícito |
| Sem contrato de sala | `roomMessageId` correlation |
| Batching/defer rules de issue | Reason dedicado + política de sala |
| Sem cost pill no BoardChat | UI sala first-class |

Reusar primitives (`wakeup`, `addComment`, `findMentionedAgents`) — **não** copiar JSON-RPC A2A.

---

## 3. Requisitos funcionais (RF-P1-XX)

### 3.1 Room orchestrator — single mention

**RF-P1-01** — Criar serviço `room-orchestrator` que recebe:
```ts
{
  companyId: string;
  issueId: string;          // Board Operations
  roomMessageId: string;    // commentId humano
  body: string;
  actor: { type: "user"|"board"; id: string };
}
```

**RF-P1-02** — Extrair `mentionedAgentIds = await findMentionedAgents(companyId, body)`.

**RF-P1-03** — Se `length === 0`: não deve chegar aqui (P0 silent). Se chegar, no-op / 409.

**RF-P1-04** — Se `length > 1`: `400 { code: "FANOUT_NOT_ENABLED", message: "…" }` (P2).

**RF-P1-05** — Se `length === 1`: criar host run:
```ts
await heartbeat.wakeup(targetAgentId, {
  source: "on_demand",
  triggerDetail: "manual",
  reason: "conference_room_mentioned",
  payload: {
    issueId,
    commentId: roomMessageId,
    roomMessageId,
  },
  requestedByActorType: "user",
  requestedByActorId: actor.id,
  contextSnapshot: {
    issueId,
    taskId: issueId,
    commentId: roomMessageId,
    wakeCommentId: roomMessageId,
    wakeReason: "conference_room_mentioned",
    source: "board_chat.mention",
    roomMessageId,
    forceFreshSession: true,
  },
});
```

**RF-P1-06** — Resposta API ao BoardChat:
```json
{
  "mode": "host_run",
  "issueId": "…",
  "roomMessageId": "…",
  "hostAgentId": "…",
  "hostRunId": "…",
  "status": "queued" | "running" | "skipped"
}
```

**RF-P1-07** — Idempotência: `idempotencyKey = \`room:${roomMessageId}:host\`` (ou equivalente) para retries de rede não duplicarem host run.

**RF-P1-08** — Se agent não invokable / paused / invalid org chain: 409 com mensagem acionável (não 500).

### 3.2 Prompt / contexto do host

**RF-P1-09** — No wakeup, o agente deve receber contexto de sala contendo no mínimo:
- Texto da mensagem humana (body)
- `roomMessageId` / issue id
- Instrução: responder **postando comentário na issue da sala** (Board Operations), não só stdout efêmero
- Lista curta de peers (Agent Cards names) **sem** auto-delegar em P1 (delegação espontânea via MCP ok se CEO já souber; fan-out orquestrado pela sala = P2)

**RF-P1-10** — Preferir handoff markdown existente (`paperclipSessionHandoffMarkdown` / comment wake context) em vez de inventar canal paralelo.

**RF-P1-11** — Atualizar skill/instructions do CEO (board-facing) com parágrafo Conference Room:
> When woken with `wakeReason: conference_room_mentioned`, treat the wake comment as a Slack-style @mention in the company Conference Room. Reply in the same issue thread. Do not require a child issue unless the work needs tracking.

### 3.3 Thread replies

**RF-P1-12** — Resposta do agente deve aparecer como `issue_comments` com `authorAgentId = hostAgentId` na mesma `issueId`.

**RF-P1-13** — Se o modelo de comments suportar `parentCommentId` / thread reply, setar `parentCommentId = roomMessageId`. Se não existir coluna, documentar flat stream na mesma issue (aceitável P1) e abrir follow-up schema.

**RF-P1-14** — BoardChat deve refetch/poll comments (React Query invalidate + short poll enquanto `hostRun` non-terminal) para mostrar a reply sem reload manual.

**RF-P1-15** — Typing / status UI: enquanto host run `queued|running`, mostrar TypingBubble ou status "CEO está respondendo…" (nome resolvido).

**RF-P1-16** — Em falha de run: bubble de erro amigável + link para run detail (Board).

### 3.4 Cost pill

**RF-P1-17** — Para cada reply de agente correlacionada a `hostRunId`, renderizar **cost pill** usando `visibleRunCostUsd(usage, result)` de `/Users/macbook/Projects/paperclip/ui/src/lib/utils.ts`.

**RF-P1-18** — Formato: `$0.00` com 2–4 casas; tooltip com tokens in/out se disponíveis.

**RF-P1-19** — Se `billingType === subscription_included` ou cost 0: mostrar `—` ou ocultar pill (preferir pill `included` / muted, não mentir $0 se desconhecido — usar "n/d").

**RF-P1-20** — Cost pill só no BoardChat (P1); não bloquear em ausência de finance tables.

### 3.5 Correlação roomMessageId

**RF-P1-21** — Persistir correlação host:
- Opção preferida: metadata em `heartbeat_runs.contextSnapshot` (`roomMessageId`, `hostForRoom: true`)
- Opcional tabela leve `conference_room_turns(room_message_id, host_run_id, host_agent_id, status)` se queries UI precisarem — só se contextSnapshot for insuficiente

**RF-P1-22** — API read (Board):
`GET /api/board/chat/turns/:roomMessageId` → `{ hostRunId, hostAgentId, status, costUsd? }`  
ou embutir no poll de comments via join client-side (run list by issue). Preferir endpoint fino se poll de runs por issue já existir.

**RF-P1-23** — UI associa cost pill ao bubble do agente via `runId` no comment (se comments já carregam `runId`) — reusar campos existentes de IssueChatThread quando possível.

### 3.6 Integração board-chat route

**RF-P1-24** — Evoluir P0 `adapter_wake_pending` → `host_run` quando single mention + wakeup ok.

**RF-P1-25** — Manter silent path inalterado.

**RF-P1-26** — Auth: Board/user com acesso à company (mesmo `assertCompanyAccess`).

### 3.7 Agent Cards (read)

**RF-P1-27** — Room-orchestrator **pode** ler `GET` agent-card do host para validar que agente existe e expor `name` na resposta; **não** implementar JSON-RPC A2A client.

**RF-P1-28** — Não exigir skill `paperclip.delegate` em P1 (só em P2 para fan-out).

---

## 4. Requisitos não-funcionais (RNF)

| ID | Requisito |
|----|-----------|
| RNF-P1-01 | Host wakeup p95 enqueue &lt; 1s |
| RNF-P1-02 | Poll UI ≤ 2s interval enquanto running; parar no terminal |
| RNF-P1-03 | Sem `any`; Zod nos bodies novos |
| RNF-P1-04 | Sem secrets de adapter no JSON da sala |
| RNF-P1-05 | Compat Coolify authenticated |
| RNF-P1-06 | Não quebrar mention wakes de issues clássicas |
| RNF-P1-07 | Testes com mock heartbeat; 1 integration test embedded PG se padrão do repo |

---

## 5. MoSCoW

| Prioridade | Item |
|------------|------|
| **Must** | Single @ → host run; reply no thread; cost pill; FANOUT_NOT_ENABLED; roomMessageId |
| **Should** | parentCommentId se schema permitir; status typing; idempotency; CEO skill update |
| **Could** | Endpoint GET turn; coach bare-name |
| **Won't** | Fan-out; waitAllSec join; DelegationTrace; concierge CLI |

---

## 6. UX

### 6.1 Turno single-mention

1. User envia `@CEO …`
2. Optimistic bubble user
3. Status: "Acordando CEO…" → "CEO está trabalhando… Xs"
4. Reply bubble com header agente (já existe `AgentBubbleHeader` em BoardChat)
5. Cost pill no rodapé do bubble (ao lado de timestamp / actions)

### 6.2 Erros

| Código | UX |
|--------|-----|
| `FANOUT_NOT_ENABLED` | "Em breve: mencione um agente por vez, ou aguarde fan-out." |
| Agent paused | "CEO está pausado — retome o agente nas settings." |
| Run failed | "CEO não conseguiu responder." + Retry (re-send cria novo roomMessageId) |

### 6.3 Human owner

- Sempre claro que o humano iniciou o turno (bubble user acima).
- Nenhum auto-merge / side-effect fora do thread sem menção.

### 6.4 A11y

- Cost pill: texto acessível `aria-label="Custo da resposta: 0,12 dólares"`.
- Status live region `aria-live="polite"` durante run.

---

## 7. Arquitetura (arquivos absolutos)

### 7.1 Criar

| Arquivo | Responsabilidade |
|---------|------------------|
| `/Users/macbook/Projects/paperclip/server/src/services/room-orchestrator.ts` | Single-mention → host wakeup + correlation |
| `/Users/macbook/Projects/paperclip/server/src/__tests__/room-orchestrator.test.ts` | Unit: 0/1/N mentions, idempotency, errors |
| `/Users/macbook/Projects/paperclip/ui/src/components/conference-room/RunCostPill.tsx` | Cost pill reusando `visibleRunCostUsd` |
| `/Users/macbook/Projects/paperclip/ui/src/components/conference-room/HostRunStatus.tsx` | Status line enquanto host run ativa |
| `/Users/macbook/Projects/paperclip/ui/src/hooks/useHostRunForRoomMessage.ts` | Poll host run by roomMessageId / runId |
| `/Users/macbook/Projects/paperclip/server/src/__tests__/board-chat-host-run.test.ts` | Route integration |

### 7.2 Modificar

| Arquivo | Mudança |
|---------|---------|
| `/Users/macbook/Projects/paperclip/server/src/services/room-message.ts` | Chamar room-orchestrator no branch single mention |
| `/Users/macbook/Projects/paperclip/server/src/routes/board-chat.ts` | Retornar `mode:"host_run"` + ids |
| `/Users/macbook/Projects/paperclip/ui/src/pages/BoardChat.tsx` | Host status, cost pill, poll, erros FANOUT |
| `/Users/macbook/Projects/paperclip/server/src/services/heartbeat.ts` | Se necessário: tratar `conference_room_mentioned` como comment-wake (fresh session, defer rules) — **auditar** helpers `issue_comment_mentioned` |
| `/Users/macbook/Projects/paperclip/skills/paperclip/SKILL.md` e/ou default agent instructions | Parágrafo Conference Room |
| `/Users/macbook/Projects/paperclip/server/src/routes/openapi.ts` | Documentar host_run response |
| `/Users/macbook/Projects/paperclip/packages/shared/src/validators/board-chat.ts` | Response schemas |

### 7.3 Reusar

| Artefato | Path |
|----------|------|
| Mentions | `/Users/macbook/Projects/paperclip/packages/shared/src/project-mentions.ts` |
| findMentionedAgents | `/Users/macbook/Projects/paperclip/server/src/services/issues.ts` |
| wakeup | `/Users/macbook/Projects/paperclip/server/src/services/heartbeat.ts` |
| wake route ref | `/Users/macbook/Projects/paperclip/server/src/routes/agents.ts` `POST /agents/:id/wakeup` |
| Cost helper | `/Users/macbook/Projects/paperclip/ui/src/lib/utils.ts` `visibleRunCostUsd` |
| Agent bubbles | `/Users/macbook/Projects/paperclip/ui/src/pages/BoardChat.tsx` |
| Agent Cards | `/Users/macbook/Projects/paperclip/server/src/routes/agents.ts` `GET .../agent-card` |
| run-delegation | **não chamar em P1** (só P2) |
| paperclipDelegate MCP | agente pode usar espontaneamente; sala não orquestra |

### 7.4 Sequência

```
POST /api/board/chat/stream { message with one @ }
  room-message.persist
  room-orchestrator.orchestrateSingleMention
    → wakeup host
  return { mode: host_run, hostRunId, roomMessageId }
UI polls GET /api/heartbeat-runs/:hostRunId (board auth)
  on agent comment appear → show bubble + cost from run usage/result
```

---

## 8. Qualidade / smoke tests

### 8.1 Automatizados

| ID | Caso |
|----|------|
| ST-P1-01 | Single mention → wakeup chamado 1× com `conference_room_mentioned` + `roomMessageId` |
| ST-P1-02 | Dual mention → 400 `FANOUT_NOT_ENABLED`; zero wakeup |
| ST-P1-03 | Idempotent retry mesmo `roomMessageId` → mesmo `hostRunId` |
| ST-P1-04 | Agent paused → 409 |
| ST-P1-05 | Silent path ainda sem wakeup (regressão P0) |
| ST-P1-06 | Cost pill: usage com `costUsd: 0.12` → mostra `$0.12` |
| ST-P1-07 | Cost pill: `subscription_included` → não mostra valor enganoso |
| ST-P1-08 | UI status some quando run terminal |

### 8.2 Smoke manual Coolify

| ID | Passo | Esperado |
|----|-------|----------|
| ST-P1-M01 | `@CEO diga oi em uma frase` | Reply do CEO no thread &lt; 2 min (adapter healthy) |
| ST-P1-M02 | Ver cost pill | Valor ou n/d |
| ST-P1-M03 | `@CEO @Dev …` | Erro FANOUT claro |
| ST-P1-M04 | Mensagem sem @ | Continua silent |
| ST-P1-M05 | Abrir run link | Host run com contextSnapshot.roomMessageId |

### 8.3 Comandos

```bash
cd /Users/macbook/Projects/paperclip
pnpm test --filter @paperclipai/server -- room-orchestrator
pnpm test --filter @paperclipai/server -- board-chat-host-run
pnpm test --filter @paperclipai/ui -- RunCostPill
```

---

## 9. Pesquisa / referências

| Ref | Onde |
|-----|------|
| P0 SPEC | `docs/research/slack-a2a-room/cycle-5-tech-specs/P0-foundation-SPEC.md` |
| Cycle 3 beachhead SH | `.../cycle-3-deep-dive/03-verticals-and-value.md` §2 |
| Issue mention wakes | `/Users/macbook/Projects/paperclip/server/src/routes/issues.ts` |
| Wake schema | `/Users/macbook/Projects/paperclip/packages/shared/src/validators/agent.ts` `wakeAgentSchema` |
| Delegation (P2) | `/Users/macbook/Projects/paperclip/doc/spec/agent-delegation-a2a.md` |
| UX: Linear/Claude Tag | Cycle 2 confirmation |

---

## 10. Entregáveis

1. `room-orchestrator.ts` + testes.
2. Board-chat `host_run` mode end-to-end.
3. BoardChat UI: status + cost pill + error FANOUT.
4. Instruções CEO / skill paragraph.
5. OpenAPI atualizado.
6. Smoke Coolify ST-P1-M*.
7. Handoff P1→P2.

---

## 11. Definição de pronto (DoD)

- [ ] `@CEO` em Coolify produz host run real + reply no thread
- [ ] `roomMessageId` correlaciona comment↔run
- [ ] Cost pill visível (ou n/d honesto)
- [ ] Multi-@ → `FANOUT_NOT_ENABLED`
- [ ] Silent-until-@ regressão zero
- [ ] ST-P1-01…08 passando
- [ ] ST-P1-M01…M05 Coolify
- [ ] Sem fan-out orquestrado / DelegationTrace (scope guard)
- [ ] Handoff P2 escrito

---

## 12. Riscos / handoff

### 12.1 Riscos

| Risco | Prob. | Impacto | Mitigação |
|-------|-------|---------|-----------|
| `conference_room_mentioned` herdando defer rules erradas | Alta | Alto | Auditar heartbeat helpers; espelhar allowlist de `issue_comment_mentioned` onde fizer sentido |
| Agente responde só no transcript, não comenta na issue | Alta | Alto | Instruções explícitas + verificar adapter comment path |
| Cost fields ausentes em alguns adapters | Média | Baixo | Pill n/d |
| CEO espontaneamente chama paperclipDelegate | Baixa | Médio | Aceitável; trace completo só P2 |
| Poll agressivo | Baixa | Médio | Backoff; parar no terminal |

### 12.2 Handoff → P2

Entregar:

1. Host run estável com `contextSnapshot.roomMessageId` + `hostRunId` na resposta API.
2. Política single-mention enforced.
3. UI hooks de poll reusáveis para N children.
4. Confirmação de que host agent JWT pode chamar `POST .../delegate` (pré-req P2).
5. Decisão: fan-out orquestrado **pelo room-orchestrator** (server-side delegate as host) vs pedir ao CEO via MCP — **P2 SPEC manda server-side via run-delegation API usando identidade do host run** (ver P2).

**Critério de handoff:** demo gravada `@CEO` → reply + cost em Coolify.

---

## 13. Open questions

1. `parentCommentId` existe no schema atual de `issue_comments`? Se não, flat stream P1 é OK?
2. Host agent default quando mention é Dev (não CEO): permitir qualquer agent invokable ou só reports do board? (**Decisão sugerida:** qualquer agent da company invokable.)
3. Retry UX: botão "Tentar de novo" reusa body ou novo comment?
4. Se CEO já está mid-run em outra issue: defer vs parallel — seguir regras heartbeat existentes e documentar.

---

*Documento Cycle 5 — P1 single-mention. Implementação no fork Paperclip.*
