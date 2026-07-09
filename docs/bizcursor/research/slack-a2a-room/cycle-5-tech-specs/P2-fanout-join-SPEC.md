# P2 — Fan-out + Join: @A @B → wait:false + waitAllSec + DelegationTrace
> Versão: 1.0 | Duração estimada: 2 semanas | Pré-requisitos: **P1 DoD** (host run single-mention + roomMessageId + cost pill)  
> **Repo de implementação:** `/Users/macbook/Projects/paperclip`  
> **Cherry-pick UI referência:** `/Users/macbook/Projects/bizcursor/apps/bizcursor/src/features/delegation-trace/`  
> **Data:** 2026-07-09

## 1. Contexto e visão ampla

**P2** fecha o produto Slack+A2A da Conference Room: o humano menciona **dois ou mais** agentes (`@A @B`), o control plane cria um **host run** (orquestrador da sala — tipicamente CEO ou o primeiro mention designado) e dispara **fan-out paralelo** via delegação nativa já existente (`wait: false` por filho), depois faz **join** com `waitAllSec` / settle `delegation_child_completed`. A UI mostra **DelegationTrace** (cherry-pick do BizCursor F2) correlacionado por `roomMessageId`.

Isto **não** reimplementa A2A JSON-RPC. Reusa:
- `/Users/macbook/Projects/paperclip/server/src/services/run-delegation.ts`
- MCP `paperclipDelegate` / `paperclipGetDelegation` (path agente)
- Agent Cards
- `extractAgentMentionIds`

### 1.1 Problema

| Gap Cycle 2 | Solução P2 |
|-------------|------------|
| Mentions ≠ A2A join | Room-orchestrator chama delegate N× `wait:false` sob host run |
| Sem peer wait na sala | Join via `getDelegationState({ waitAllSec })` + continuation wake |
| Sem trace na Conference Room | DelegationTrace UI no BoardChat |
| Humano não pode POST delegate | Server orquestra **como** o host run (agent JWT / internal enqueue) |

### 1.2 Escopo

| Dentro P2 | Fora P2 |
|-----------|---------|
| `@A @B` (+N até cap) fan-out | Quorum parcial Aegean (join = allSettled existente) |
| Host run + children via run-delegation | JSON-RPC A2A externo |
| `waitAllSec` join (server e/ou host agent) | BizCursor desktop shipping (só cherry-pick código) |
| DelegationTrace no BoardChat | Cost budget enforcement (P3 GTM / F3) |
| `roomMessageId` em toda a árvore | Cascade SAS obrigatório (default = paralelo; cascade = follow-up) |

### 1.3 Cenário canônico (SH-2 spike)

```
Humano:
  [@researcher](agent://…) [@coder](agent://…) avaliar OAuth vs cookies; deadline sexta

Room-orchestrator P2:
  1. Persist human comment (roomMessageId)
  2. Create HOST run (policy: CEO se mencionado, senão first mention, senão company.defaultRoomHostAgentId)
  3. For each non-host mention (or all targets if host is synthetic CEO):
       runDelegation.delegate(hostRunId, { targetAgentId, task, wait: false, clientKey, … })
  4. Join: getDelegationState(hostRunId, { waitAllSec: 120 }) OR exit host + delegation_child_completed
  5. Host (opcional) sintetiza reply final no thread
UI:
  DelegationTrace sob a mensagem humana / host bubble
  Cost pills: host + Σ children (se disponível)
```

### 1.4 Premissas

- P0+P1 Done.
- `run-delegation` production-ready (spec `doc/spec/agent-delegation-a2a.md`).
- Org policy: target must be **report** of source — **crítico**: se humano menciona peers que não reportam ao host, delegate falha 409. Mitigações na §3.4.
- Caps: `DELEGATION_MAX_CHILDREN_PER_RUN` (default 5).

---

## 2. Relação com o resto do projeto

### 2.1 Diagrama

```
 Human @A @B
      │
      ▼
 room-message (persist)
      │
      ▼
 room-orchestrator.orchestrateFanout
      │
      ├─► heartbeat.wakeup(HOST)  ── hostRunId
      │         │
      │         ├─► POST delegate wait:false → child A
      │         └─► POST delegate wait:false → child B
      │
      ├─► (optional) waitAllSec join while host alive
      │         OR host exits → delegation_child_completed wake
      │
      ▼
 BoardChat: DelegationTrace(hostRunId) + roomMessageId correlation
```

### 2.2 Upstream / downstream

| Direção | Artefato | Uso P2 |
|---------|----------|--------|
| Upstream | P1 host run + roomMessageId | Âncora |
| Upstream | `run-delegation.ts` | Fan-out/join |
| Upstream | MCP paperclipDelegate | Path alternativo in-agent |
| Upstream | Agent Cards directory | Validar targets |
| Upstream | BizCursor DelegationTrace | Cherry-pick UI |
| Downstream | GTM P3 cost/roles | Budget por thread |
| Downstream | Beachhead spikes paralelos | Cycle 3 SH-2 |

### 2.3 Decisão de orquestração (normativa)

**Server-side fan-out sob o host run** (room-orchestrator chama a mesma lógica de `runDelegationService.delegate` com o `hostRunId` ativo), **não** exigir que o LLM do host lembre de chamar MCP.

Justificativa: determinismo, idempotência (`clientKey`), e humano não tem agent JWT. O host agent ainda pode receber wake de síntese com `delegationResults` agregados.

Path B (opcional fallback): se host já estiver `running` com MCP, instruções podem pedir `paperclipDelegate` — mas DoD P2 exige path server-side.

---

## 3. Requisitos funcionais (RF-P2-XX)

### 3.1 Detecção fan-out

**RF-P2-01** — Se `mentionedAgentIds.length >= 2`: entrar no path fan-out (remover 400 `FANOUT_NOT_ENABLED` do P1).

**RF-P2-02** — Se `length === 1`: manter comportamento P1.

**RF-P2-03** — Se `length === 0`: silent P0.

**RF-P2-04** — Se `length > maxChildren` (min(company override, `DELEGATION_MAX_CHILDREN_PER_RUN`)): `400 { code: "TOO_MANY_MENTIONS", max }`.

### 3.2 Seleção do HOST

**RF-P2-05** — Política de host (configurável, defaults nesta ordem):

1. Se a company tem `defaultRoomHostAgentId` (CEO) **e** está na lista de mentions **ou** flag `alwaysUseCeoHost: true` → HOST = CEO.
2. Senão se CEO está nas mentions → HOST = CEO; children = demais.
3. Senão HOST = `mentionedAgentIds[0]`; children = resto.
4. Documentar no JSON: `{ hostAgentId, childAgentIds }`.

**RF-P2-06** — Beachhead default recomendado: `alwaysUseCeoHost: true` para software houses (CEO orquestra mesmo se não @mencionado). Se CEO não @mencionado mas é host, o task text deve incluir a mensagem humana completa + lista de peers.

**RF-P2-07** — Open question fechada aqui como default: **P2 v1 usa `alwaysUseCeoHost: true`** quando CEO existe e invokable; senão fallback RF-P2-05.3.

### 3.3 Fan-out via run-delegation

**RF-P2-08** — Para cada `childAgentId`, chamar delegate equivalente a:
```ts
await runDelegation.delegate(hostRunId, {
  targetAgentId: childAgentId,
  task: buildRoomFanoutTask({ humanBody, roomMessageId, peerIds }),
  wait: false,
  createChildIssue: false, // sala-first; issues opcionais Could
  clientKey: `room:${roomMessageId}:child:${childAgentId}`,
  expectedOutput: "Post a concise reply in the Conference Room issue thread; return a short summary.",
});
```

**RF-P2-09** — Reusar `/Users/macbook/Projects/paperclip/server/src/services/run-delegation.ts` — **não** duplicar waiter registry.

**RF-P2-10** — `wakeReason` dos children: `a2a_delegate` (já wired). Incluir `roomMessageId` no handoff markdown / contextSnapshot do child.

**RF-P2-11** — Idempotência: retries com mesmo `clientKey` retornam child existente (já no serviço).

**RF-P2-12** — Resposta imediata ao UI:
```json
{
  "mode": "fanout",
  "issueId": "…",
  "roomMessageId": "…",
  "hostAgentId": "…",
  "hostRunId": "…",
  "childRunIds": ["…", "…"],
  "delegationStatus": "pending"
}
```

### 3.4 Org policy / reportsTo

**RF-P2-13** — Antes do fan-out, validar `isReportOf(child, host)` (export existente em run-delegation). Se algum child falhar:

| Estratégia P2 v1 | Comportamento |
|------------------|---------------|
| **strict** (default) | 409 `DELEGATION_NOT_IN_ORG` listando ids inválidos; zero children spawned |
| soft | skip inválidos + warning (Could; não default) |

**RF-P2-14** — Documentar setup beachhead: Dev/Researcher reportam ao CEO.

**RF-P2-15** — Agent Cards: opcionalmente pré-checar `GET /api/companies/:id/agent-cards` para nomes na UI de erro.

### 3.5 Join (`waitAllSec`)

**RF-P2-16** — Após enfileirar todos `wait:false`, o room-orchestrator **deve** escolher uma estratégia documentada:

| Estratégia | Quando | Mecânica |
|------------|--------|----------|
| **A — in-run join** | Host adapter permite wait longo | `getDelegationState(hostRunId, { waitAllSec: N })` com N default 120 (cap server) |
| **B — continuation** | Preferida se host não deve bloquear HTTP | Host run finaliza após fan-out; settle dispara `delegation_child_completed`; host re-wake sintetiza |

**RF-P2-17** — Default P2: **B (continuation)** para não segurar request HTTP Board além de ~30s; o POST da sala retorna `fanout` pending imediatamente (RF-P2-12). Join observável via `GET .../delegation` + UI poll.

**RF-P2-18** — Expor para Board (read):
`GET /api/heartbeat-runs/:hostRunId/delegation` (já existe) — UI DelegationTrace consome isto.

**RF-P2-19** — Opcional long-poll Board-facing:
`GET /api/board/chat/turns/:roomMessageId/delegation?waitAllSec=30` que resolve `hostRunId` via correlação e proxy o getDelegationState (auth board).

**RF-P2-20** — Não busy-poll no server além do waiter event-driven já implementado.

### 3.6 Correlação `roomMessageId`

**RF-P2-21** — Gravar em todos os nós:
- Host `contextSnapshot.roomMessageId`
- Cada child handoff / contextSnapshot `roomMessageId`
- Tabela opcional `conference_room_turns` se P1 não criou:
  ```
  room_message_id PK
  host_run_id
  host_agent_id
  child_run_ids jsonb
  mode: single|fanout
  created_at
  ```

**RF-P2-22** — Comments de children na issue da sala devem preferir `parentCommentId = roomMessageId` quando schema permitir.

**RF-P2-23** — API: `GET /api/board/chat/turns/:roomMessageId` retorna host + children + delegationStatus.

### 3.7 Síntese do host (pós-join)

**RF-P2-24** — No wake `delegation_child_completed`, host deve postar **um** comentário de síntese no thread (instruções skill).

**RF-P2-25** — Se todos children failed: síntese de falha + cost ainda visível.

**RF-P2-26** — Cancel: `POST .../delegations/:childRunId/cancel` acessível ao board? **Could** — P2 Must = cancel via cancel host run (já propaga).

### 3.8 DelegationTrace UI (cherry-pick)

**RF-P2-27** — Portar para o fork UI (adaptando imports Paperclip, sem Tauri):

Fonte BizCursor:
- `/Users/macbook/Projects/bizcursor/apps/bizcursor/src/features/delegation-trace/DelegationTrace.tsx`
- `/Users/macbook/Projects/bizcursor/apps/bizcursor/src/features/delegation-trace/HopRow.tsx`
- `/Users/macbook/Projects/bizcursor/apps/bizcursor/src/features/delegation-trace/use-delegation-trace.ts`
- `/Users/macbook/Projects/bizcursor/apps/bizcursor/src/lib/paperclip-client/delegation.ts` (Zod parse)

Destino Paperclip (sugerido):
- `/Users/macbook/Projects/paperclip/ui/src/components/conference-room/DelegationTrace.tsx`
- `/Users/macbook/Projects/paperclip/ui/src/components/conference-room/HopRow.tsx`
- `/Users/macbook/Projects/paperclip/ui/src/hooks/useDelegationTrace.ts`
- `/Users/macbook/Projects/paperclip/ui/src/lib/delegation-state.ts`

**RF-P2-28** — Integrar em `BoardChat.tsx` abaixo do bubble humano (ou host) quando `mode === "fanout"` ou quando `hostRunId` tem children.

**RF-P2-29** — Dois modos de display:
- **Operator/narrative** (default Conference Room): frases "Researcher está trabalhando…"
- **Board/JSON** (toggle): lista hops com status + link run (como BizCursor board mode)

**RF-P2-30** — Se `childRuns.length === 0`, componente retorna `null` (zero ruído).

**RF-P2-31** — Estilos: usar tokens Tailwind/shadcn do Paperclip UI (não copiar CSS Tauri do BizCursor cegamente).

**RF-P2-32** — i18n: strings EN no fork (Paperclip UI é EN); PT só se já houver i18n infra — não adicionar sistema i18n só por isto.

### 3.9 Cost

**RF-P2-33** — Manter cost pill P1 no host; **Should:** pill agregado `host + Σ children` no header do DelegationTrace.

**RF-P2-34** — Não bloquear fan-out se cost ausente.

### 3.10 paperclipDelegate / Agent Cards

**RF-P2-35** — Documentar equivalência: server fan-out ≡ N× `paperclipDelegate({ wait:false })` + `paperclipGetDelegation({ waitAllSec })`.

**RF-P2-36** — Não remover MCP tools; skills do host devem mencionar que a **sala** pode já ter fan-outado — evitar double-delegate (checar delegation state before delegating).

**RF-P2-37** — Listar Agent Cards no erro/empty states da sala (nomes mentionáveis).

---

## 4. Requisitos não-funcionais (RNF)

| ID | Requisito |
|----|-----------|
| RNF-P2-01 | Fan-out enqueue de N≤5 children p95 &lt; 2s |
| RNF-P2-02 | HTTP POST sala retorna &lt; 30s (continuation model) |
| RNF-P2-03 | UI poll delegation ≤ 2s; stop when terminal |
| RNF-P2-04 | Reusar waiter registry; sem novo busy-loop |
| RNF-P2-05 | Strict TS; Zod boundaries |
| RNF-P2-06 | Testes espelhando `/Users/macbook/Projects/paperclip/server/src/__tests__/run-delegation-integration.test.ts` patterns |
| RNF-P2-07 | Slice ≤6 arquivos novos core (+ tests); cherry-pick UI conta no budget do slice conference-room |

---

## 5. MoSCoW

| Prioridade | Item |
|------------|------|
| **Must** | Fan-out wait:false; host+children; roomMessageId; DelegationTrace; org strict; GET delegation UI; continuation join |
| **Should** | alwaysUseCeoHost; cost agregado; board proxy waitAllSec; anti double-delegate skill note |
| **Could** | createChildIssue; soft org skip; cancel child na UI; parentCommentId threads |
| **Won't** | Quorum parcial; JSON-RPC A2A; BizCursor desktop release; marketing ROAS claims |

---

## 6. UX

### 6.1 Fan-out turn

1. User envia `@researcher @coder …`
2. Optimistic user bubble
3. Status: "Disparando 2 agentes…"
4. DelegationTrace expande com 2 hops (pending → running → done/fail)
5. Replies dos agents aparecem no stream (order = completion)
6. Síntese do CEO (se host) ao final
7. Cost: pills por hop + total

### 6.2 Erros

| Código | UX |
|--------|-----|
| `TOO_MANY_MENTIONS` | "Máximo N agentes por mensagem." |
| `DELEGATION_NOT_IN_ORG` | "X não reporta a Y — ajuste o org chart." + link Org |
| Child timeout | Hop "timed out" + recovery via delegation GET |

### 6.3 A11y

- Trace: `aria-expanded` no header (já no BizCursor).
- Status hops anunciáveis.
- Links de run com texto descritivo.

### 6.4 Anti-hype (Cycle 3)

Messaging na UI vazia / docs internas: valor = **ciclo auditável no thread**, não "autonomia 80%".

---

## 7. Arquitetura (arquivos absolutos)

### 7.1 Criar

| Arquivo | Responsabilidade |
|---------|------------------|
| `/Users/macbook/Projects/paperclip/server/src/services/room-orchestrator-fanout.ts` | Ou métodos novos em `room-orchestrator.ts` — preferir **estender** o arquivo P1 se &lt;400 linhas |
| `/Users/macbook/Projects/paperclip/server/src/__tests__/room-orchestrator-fanout.test.ts` | Fan-out, org fail, caps, idempotency |
| `/Users/macbook/Projects/paperclip/ui/src/components/conference-room/DelegationTrace.tsx` | Cherry-pick adaptado |
| `/Users/macbook/Projects/paperclip/ui/src/components/conference-room/HopRow.tsx` | Cherry-pick adaptado |
| `/Users/macbook/Projects/paperclip/ui/src/hooks/useDelegationTrace.ts` | Poll `GET /api/heartbeat-runs/:id/delegation` |
| `/Users/macbook/Projects/paperclip/ui/src/lib/delegation-state.ts` | Zod parse (de BizCursor delegation.ts) |
| `/Users/macbook/Projects/paperclip/server/src/routes/board-chat-turns.ts` | GET turn by roomMessageId (se não couber em board-chat.ts) |

### 7.2 Modificar

| Arquivo | Mudança |
|---------|---------|
| `/Users/macbook/Projects/paperclip/server/src/services/room-orchestrator.ts` | Branch N≥2 → fanout |
| `/Users/macbook/Projects/paperclip/server/src/routes/board-chat.ts` | `mode:"fanout"` response |
| `/Users/macbook/Projects/paperclip/ui/src/pages/BoardChat.tsx` | Render DelegationTrace; remover tratamento FANOUT_NOT_ENABLED como erro terminal |
| `/Users/macbook/Projects/paperclip/server/src/services/run-delegation.ts` | Só se precisar propagar `roomMessageId` no handoff (mínimo diff) |
| `/Users/macbook/Projects/paperclip/skills/paperclip/SKILL.md` | Anti double-delegate + conference room fan-out |
| `/Users/macbook/Projects/paperclip/server/src/routes/openapi.ts` | fanout response + turns |
| `/Users/macbook/Projects/paperclip/packages/shared/src/validators/board-chat.ts` | schemas |
| `/Users/macbook/Projects/paperclip/doc/spec/agent-delegation-a2a.md` | Seção "Conference Room fan-out" (link) |

### 7.3 Reusar (obrigatório)

| Artefato | Path absoluto |
|----------|---------------|
| run-delegation | `/Users/macbook/Projects/paperclip/server/src/services/run-delegation.ts` |
| Delegation tests | `/Users/macbook/Projects/paperclip/server/src/__tests__/run-delegation*.ts` |
| MCP paperclipDelegate | `/Users/macbook/Projects/paperclip/packages/mcp-server/src/tools.ts` |
| extractAgentMentionIds | `/Users/macbook/Projects/paperclip/packages/shared/src/project-mentions.ts` |
| Agent Cards routes | `/Users/macbook/Projects/paperclip/server/src/routes/agents.ts` |
| Spec A2A delegation | `/Users/macbook/Projects/paperclip/doc/spec/agent-delegation-a2a.md` |
| BizCursor trace | `/Users/macbook/Projects/bizcursor/apps/bizcursor/src/features/delegation-trace/*` |
| BizCursor parse | `/Users/macbook/Projects/bizcursor/apps/bizcursor/src/lib/paperclip-client/delegation.ts` |

### 7.4 Pseudocódigo room-orchestrator fan-out

```ts
async function orchestrateFanout(input: RoomInput): Promise<FanoutResult> {
  const ids = await findMentionedAgents(input.companyId, input.body);
  if (ids.length < 2) throw new Error("use single-mention path");
  if (ids.length > maxChildren) throw tooMany();

  const hostAgentId = selectHost(ids, company);
  const childAgentIds = ids.filter((id) => id !== hostAgentId);
  // if alwaysUseCeoHost and CEO not in ids, children = ids, host = CEO

  assertAllReportsOf(childAgentIds, hostAgentId); // strict

  const hostRun = await heartbeat.wakeup(hostAgentId, {
    reason: "conference_room_mentioned",
    contextSnapshot: {
      roomMessageId: input.roomMessageId,
      issueId: input.issueId,
      wakeReason: "conference_room_mentioned",
      roomFanout: true,
      plannedChildAgentIds: childAgentIds,
    },
    // ...
  });

  const childRunIds: string[] = [];
  for (const childId of childAgentIds) {
    const res = await runDelegation.delegate(hostRun.id, {
      targetAgentId: childId,
      task: buildTask(input),
      wait: false,
      clientKey: `room:${input.roomMessageId}:child:${childId}`,
      createChildIssue: false,
    });
    childRunIds.push(res.childRunId);
  }

  // Do not block HTTP on waitAllSec (strategy B).
  await persistTurn({ roomMessageId, hostRunId: hostRun.id, childRunIds, mode: "fanout" });
  return { mode: "fanout", hostRunId: hostRun.id, childRunIds, … };
}
```

**Nota de implementação:** `delegate` hoje exige parent `status === running` e actor agent JWT em HTTP. Room-orchestrator deve chamar o **service** in-process (como heartbeat faz) com permissões internas, não o route HTTP board. Se o service exigir run running, garantir wakeup iniciou run antes do loop (await running ou enqueue children no mesmo tick que o adapter start — seguir padrão interno já usado por automation).

---

## 8. Qualidade / smoke tests

### 8.1 Automatizados

| ID | Caso |
|----|------|
| ST-P2-01 | 2 mentions → 1 host wakeup + 2× delegate `wait:false` |
| ST-P2-02 | `clientKey` estável por `(roomMessageId, childAgentId)` |
| ST-P2-03 | Child fora do org → 409; zero delegates |
| ST-P2-04 | 6 mentions com max 5 → 400 `TOO_MANY_MENTIONS` |
| ST-P2-05 | Single mention ainda path P1 (1 wakeup, 0 delegate) |
| ST-P2-06 | Silent path intacto |
| ST-P2-07 | `getDelegationState` após children terminal → aggregate completed |
| ST-P2-08 | DelegationTrace retorna null sem children |
| ST-P2-09 | DelegationTrace lista 2 hops com statuses |
| ST-P2-10 | roomMessageId presente no contextSnapshot host + handoff child |

### 8.2 Smoke manual Coolify

| ID | Passo | Esperado |
|----|-------|----------|
| ST-P2-M01 | `@researcher @coder` pergunta curta | 2 child runs + trace na sala |
| ST-P2-M02 | Aguardar join | Hops terminal + síntese host (se CEO) |
| ST-P2-M03 | Org quebrado (peer sem reportsTo) | Erro claro, sem runs órfãs |
| ST-P2-M04 | Cost pills | Host e/ou children |
| ST-P2-M05 | Recarregar página | Trace reidrata via hostRunId / turn API |

### 8.3 Comandos

```bash
cd /Users/macbook/Projects/paperclip
pnpm test --filter @paperclipai/server -- room-orchestrator-fanout
pnpm test --filter @paperclipai/server -- run-delegation
pnpm test --filter @paperclipai/ui -- DelegationTrace
```

---

## 9. Pesquisa / referências

| Ref | Onde |
|-----|------|
| P0 / P1 SPECs | `docs/research/slack-a2a-room/cycle-5-tech-specs/` |
| Cycle 2: fan-out+join exists | `docs/research/slack-a2a-room/cycle-2-confirmation/00-INDEX.md` |
| Cycle 3 SH-2 paralelo | `docs/research/slack-a2a-room/cycle-3-deep-dive/03-verticals-and-value.md` §2.3 |
| Delegation spec | `/Users/macbook/Projects/paperclip/doc/spec/agent-delegation-a2a.md` |
| Skills parallel fan-out | `/Users/macbook/Projects/paperclip/skills/paperclip/SKILL.md` |
| BizCursor F2 handoff | `/Users/macbook/Projects/bizcursor/docs/handoffs/2026-07-07-f2-native-delegation.md` |
| A2A protocol note | Fan-out é app-level (Cycle 1 D1) — confirmado |

---

## 10. Entregáveis

1. Fan-out path no room-orchestrator (server-side delegate).
2. Correlação `roomMessageId` host+children (+ turn API).
3. DelegationTrace + HopRow + hook no Paperclip UI.
4. Skill/docs anti double-delegate.
5. OpenAPI + seção na spec de delegation.
6. ST-P2-* + smoke Coolify.
7. Handoff GTM P3 (cost/roles) notes.

---

## 11. Definição de pronto (DoD)

- [ ] `@A @B` em Coolify cria host + 2 children `wait:false`
- [ ] Join observável (delegation GET / continuation) sem busy-poll novo
- [ ] DelegationTrace visível e reidratável após reload
- [ ] `roomMessageId` correlaciona árvore
- [ ] Org strict com erro acionável
- [ ] P0 silent + P1 single-mention sem regressão
- [ ] ST-P2-01…10 passando
- [ ] ST-P2-M01…M05 Coolify
- [ ] Sem JSON-RPC A2A client novo
- [ ] Messaging anti-hype respeitado em copy de erro/empty

---

## 12. Riscos / handoff

### 12.1 Riscos

| Risco | Prob. | Impacto | Mitigação |
|-------|-------|---------|-----------|
| Delegate in-process antes de host `running` | Alta | Alto | Sequenciar start; ou enfileirar children no hook pós-start do host |
| Org chart beachhead incompleto | Alta | Alto | Doc setup + 409 claro |
| Double fan-out (sala + CEO MCP) | Média | Médio | Skill note + check pending delegation |
| HTTP timeout se escolher strategy A | Média | Médio | Default strategy B |
| Cherry-pick Tauri APIs no HopRow (`openUrl`) | Média | Baixo | Trocar por `<a href>` Paperclip |
| Caps children vs UX | Baixa | Baixo | Mensagem TOO_MANY |

### 12.2 Handoff → GTM P3 / F3

1. Turn API estável para cost aggregation por `roomMessageId`.
2. Trace UI pronto para budget warnings.
3. Roles/approvals (F5) podem gatear fan-out depois.
4. Não portar BizCursor desktop — produto vive no fork Board.

**Critério de handoff:** demo SH-2 `@researcher @coder` com trace + join em Coolify.

---

## 13. Open questions

1. `alwaysUseCeoHost: true` fixo vs setting experimental por company?
2. Children devem postar na Board Operations **e** child issues? (Default P2: só sala.)
3. Host sintetiza sempre ou só se CEO? (Default: sempre que host ≠ unique worker.)
4. Expor cancel child na Conference Room UI em P2 ou P3?
5. Precisamos migration `conference_room_turns` ou contextSnapshot basta? (Preferir snapshot + índice se query lenta.)

---

## Apêndice A — Mapa de modos da sala (P0–P2)

| Mentions | mode | Comportamento |
|----------|------|---------------|
| 0 | `silent` | Persist only |
| 1 | `host_run` | P1 wakeup + reply + cost |
| 2..max | `fanout` | P2 host + N delegate wait:false + trace |
| >max | error | `TOO_MANY_MENTIONS` |

## Apêndice B — Checklist cherry-pick DelegationTrace

- [ ] Remover `@tauri-apps/plugin-opener` → `window.open` / React Router link
- [ ] Remover i18n BizCursor → strings EN locais
- [ ] Trocar `Agent` type BizCursor → tipo agents Paperclip UI
- [ ] `baseUrl` → relative `/api` ou origin atual
- [ ] Testes RTL mínimos HopRow status classes
- [ ] CSS: classes `delegation-trace*` → Tailwind utility no Paperclip

---

*Documento Cycle 5 — P2 fan-out+join. Implementação no fork Paperclip; UI trace originada do BizCursor F2.*
