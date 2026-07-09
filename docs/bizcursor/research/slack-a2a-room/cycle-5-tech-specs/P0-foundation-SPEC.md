# P0 — Foundation: Silent-until-@ + Conference Room Coolify
> Versão: 1.0 | Duração estimada: 1–1,5 semanas | Pré-requisitos: Cycle 1–3 research; fork `QuadriniL/paperclip` em `/Users/macbook/Projects/paperclip` com `enableConferenceRoomChat` + `run-delegation` já existentes  
> **Repo de implementação:** `/Users/macbook/Projects/paperclip` (não BizCursor desktop)  
> **Data:** 2026-07-09

## 1. Contexto e visão ampla

A Conference Room (`BoardChat`) hoje é um **concierge sempre-ligado**: qualquer mensagem dispara `POST /api/board/chat/stream`, que só funciona em `deploymentMode: local_trusted` via spawn do CLI `claude`. Em Coolify (`authenticated`) o endpoint retorna `403 DEPLOYMENT_MODE_UNSUPPORTED`. Não há `@mentions` no composer da sala.

**P0** transforma a sala no modelo Slack: **silent-until-@** — mensagens sem menção estruturada a agente **não** acordam ninguém; o composer passa a usar `MarkdownEditor` com autocomplete de agentes; o path de execução em Coolify deixa de depender do CLI local e passa a usar **adapter wake** (`POST /api/agents/:id/wakeup`) quando houver `@`.

### 1.1 Problema

| Hoje | Desejado (P0) |
|------|----------------|
| Toda mensagem → concierge CLI | Sem `@` → só persiste comentário (silêncio) |
| Composer = `ChatComposer` textarea | Composer = `MarkdownEditor` + mentions (`agent://`) |
| Coolify bloqueado (`local_trusted` only) | Coolify: wake via adapters Paperclip |
| Flag experimental oculta a nav | Flag `enableConferenceRoomChat` continua gate; P0 assume ON em staging |

### 1.2 Escopo explícito

| Dentro P0 | Fora P0 |
|-----------|---------|
| Silent-until-@ no BoardChat | Wake de agente real com resposta no thread (→ **P1**) |
| Mentions no composer (`MarkdownEditor`) | Fan-out `@A @B` + join (→ **P2**) |
| Desligar always-concierge quando não há `@` | Cost pill / DelegationTrace UI |
| Path `adapter_wake` para Coolify (authenticated) | Concierge LLM remoto em Coolify (opcional residual) |
| Gate `enableConferenceRoomChat` intacto | BizCursor desktop changes |

### 1.3 Cenário canônico P0

```
Humano (Coolify Board, flag ON):
  1. Abre Conference Room
  2. Digita "bom dia equipe" sem @  → comentário persiste; NENHUM wake; NENHUM stream concierge
  3. Digita "@" → autocomplete lista agentes da company (CEO, Dev, …)
  4. Seleciona CEO → markdown `[@CEO](agent://<uuid>) …`
  5. Envia → P0 persiste + detecta mention; NÃO exige CLI local
     (wake real + reply do agente = P1; P0 só garante o path e o contrato)
```

### 1.4 Premissas

- Paperclip Coolify: `deploymentMode: authenticated`, HTTPS, Board API key / session.
- Agentes `cursor_cloud` e/ou `opencode_local` já provisionados na company.
- Mentions estruturadas usam `agent://` via `buildAgentMentionHref` / `extractAgentMentionIds` em `@paperclipai/shared`.
- Issue âncora "Board Operations" continua sendo o storage da conversa da sala.

---

## 2. Relação com o resto do projeto

### 2.1 Diagrama

```
┌─────────────────────────────────────────────────────────────────────────┐
│  UI BoardChat (P0)                                                      │
│  MarkdownEditor + mentions ──▶ extractAgentMentionIds(body)             │
│         │                                                               │
│         ├─ mentions.length === 0 ──▶ POST persist-only (silent)         │
│         └─ mentions.length >= 1 ──▶ POST room message + adapter_wake    │
│                                      path (contrato; wake host = P1)    │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS Board auth
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Paperclip server                                                       │
│  enableConferenceRoomChat gate                                          │
│  board-chat routes:                                                     │
│    - local_trusted + no @:  (legacy concierge OPCIONAL / OFF default)   │
│    - authenticated + @:     adapter_wake (heartbeat.wakeup)             │
│    - authenticated + no @:  persist comment only                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Upstream / downstream

| Direção | Artefato | Uso P0 |
|---------|----------|--------|
| Upstream | `enableConferenceRoomChat` | Gate API + nav |
| Upstream | `MarkdownEditor`, `MentionOption` | Composer mentions |
| Upstream | `extractAgentMentionIds`, `buildAgentMentionHref` | Parse/emit mentions |
| Upstream | `issueService.addComment` / Board Operations issue | Persistência |
| Upstream | `POST /api/agents/:id/wakeup` | Path Coolify (sem CLI) |
| Downstream | **P1** | Host run + reply do agente mencionado |
| Downstream | **P2** | Fan-out N mentions |
| Downstream | BizCursor F2 DelegationTrace | Cherry-pick só em P2 |

### 2.3 Decisão de produto (Cycle 1–3)

Path **B/Slack+@** no fork Paperclip. Beachhead: software houses. P0 é fundação UX + deploy path; valor medido começa em P1.

---

## 3. Requisitos funcionais (RF-P0-XX)

### 3.1 Feature flag

**RF-P0-01** — Manter gate `enableConferenceRoomChat` em:
- UI: `/Users/macbook/Projects/paperclip/ui/src/hooks/useConferenceRoomChatEnabled.ts`
- API: `/Users/macbook/Projects/paperclip/server/src/routes/board-chat.ts` (403 `FEATURE_DISABLED` se off)
- Settings: `/Users/macbook/Projects/paperclip/ui/src/pages/InstanceExperimentalSettings.tsx`

**RF-P0-02** — Com flag OFF: zero regressão (nav oculta, API 403). Com flag ON: comportamento P0 abaixo.

### 3.2 Silent-until-@

**RF-P0-03** — Mensagem cujo body, após `extractAgentMentionIds(body)`, retorna `[]`:
1. Persiste como comentário humano na issue "Board Operations" (ou `taskId` existente).
2. **Não** spawna CLI `claude`.
3. **Não** chama `heartbeat.wakeup`.
4. Resposta HTTP síncrona JSON (não SSE concierge): `{ issueId, commentId, mode: "silent" }`.

**RF-P0-04** — Texto cru `@CEO` **sem** link `agent://` **não** conta como mention (alinhar a `issues-service` / `project-mentions.test.ts`).

**RF-P0-05** — Placeholder do composer deve comunicar o modelo: ex. `Mensagem a sala… use @ para chamar um agente`.

### 3.3 Mentions no BoardChat

**RF-P0-06** — Substituir (ou embrulhar) o `ChatComposer` bare textarea em BoardChat por `MarkdownEditor` com `mentions: MentionOption[]` derivados de `agentsApi.list(companyId)` (kind `"agent"`, `agentId`, `name`, `agentIcon`).

**RF-P0-07** — Inserção de mention deve emitir markdown canônico:
```md
[@NomeDoAgente](agent://<agentUuid>)
```
via `buildAgentMentionHref(agentId, icon)`.

**RF-P0-08** — Autocomplete `@` filtra por nome; teclado (↑↓ Enter Esc) igual ao IssueChatThread.

**RF-P0-09** — Manter send-on-Enter / Shift+Enter newline compatível com a sala (ou documentar mudança se MarkdownEditor exigir ⌘+Enter — preferir Enter submit se já suportado por `onSubmit` do editor).

### 3.4 Desligar always-concierge

**RF-P0-10** — Default P0: **nunca** auto-invocar concierge CLI em mensagem sem `@`, em qualquer `deploymentMode`.

**RF-P0-11** — Path legado `local_trusted` + spawn `claude`:
- **Opção A (preferida):** remover do hot path; manter código morto atrás de flag interna `enableBoardConciergeCli` default `false`, ou deletar se testes e2e forem atualizados.
- **Opção B:** só permitir concierge CLI se mensagem contiver mention a um sentinel especial (fora de escopo — não implementar em P0).

**RF-P0-12** — Atualizar copy UI que fala em "board concierge" para "Conference Room" / silent-until-@ onde o usuário vê (empty state, erros).

### 3.5 Path `adapter_wake` (Coolify)

**RF-P0-13** — Em `deploymentMode === "authenticated"` (Coolify), `POST` da sala **não** retorna `DEPLOYMENT_MODE_UNSUPPORTED` para mensagens com ou sem `@`.

**RF-P0-14** — Contrato do endpoint da sala (evoluir `board-chat.ts` ou novo route sibling):

| Condição | Resposta |
|----------|----------|
| Flag off | 403 `FEATURE_DISABLED` |
| Sem `@` | 200 `{ mode: "silent", issueId, commentId }` |
| Com `@` (P0) | 200/202 `{ mode: "adapter_wake_pending", issueId, commentId, mentionedAgentIds }` — **persist + validar mentions**; wake host run é **P1**, mas P0 deve expor o branch e **não** exigir CLI |

**RF-P0-15** — Validar `mentionedAgentIds` com a mesma lógica de `issueService.findMentionedAgents(companyId, body)` (só IDs da company).

**RF-P0-16** — Em P0, se a implementação já puder chamar `heartbeat.wakeup` sem quebrar Coolify, pode enfileirar wake com:
```ts
{
  source: "on_demand", // ou "automation"
  triggerDetail: "manual",
  reason: "conference_room_mentioned", // novo reason documentado
  payload: { issueId, commentId, roomMessageId: commentId },
  contextSnapshot: {
    issueId,
    taskId: issueId,
    commentId,
    wakeCommentId: commentId,
    wakeReason: "conference_room_mentioned",
    source: "board_chat.mention",
    roomMessageId: commentId,
    forceFreshSession: true,
  },
}
```
Se wakeup completo for arriscado sem reply path, P0 mínimo = persist + contrato `adapter_wake_pending` + testes do branch; P1 completa o host run. **Documentar no PR qual dos dois foi entregue.** Preferência: wakeup real se smoke Coolify passar.

**RF-P0-17** — Proibido spawn `claude` / `child_process` no path authenticated.

### 3.6 Persistência e correlação

**RF-P0-18** — Continuar usando standing issue "Board Operations" (criar se ausente) como hoje em `board-chat.ts`.

**RF-P0-19** — Todo comentário da sala deve ter `commentId` estável retornado ao cliente (`roomMessageId` = `commentId` para P1/P2).

**RF-P0-20** — Comentários de agente (quando existirem) continuam com `authorAgentId` setado; UI já distingue bubbles (`BoardChat` `isUser` check).

### 3.7 Observabilidade mínima

**RF-P0-21** — Log estruturado (sem PII de body completo em prod se possível): `{ companyId, issueId, commentId, mode, mentionedCount, deploymentMode }`.

**RF-P0-22** — Activity log opcional: `board_chat.message_silent` / `board_chat.message_mention`.

---

## 4. Requisitos não-funcionais (RNF)

| ID | Requisito |
|----|-----------|
| RNF-P0-01 | TypeScript strict; sem `any` novo |
| RNF-P0-02 | Mentions só via schema `agent://` (shared package) |
| RNF-P0-03 | Latência silent path p95 &lt; 500ms (persist only) |
| RNF-P0-04 | Compatível com proxy Coolify (sem SSE obrigatório no silent path) |
| RNF-P0-05 | Testes unitários + route tests; e2e flag ON |
| RNF-P0-06 | Não expor secrets do adapter no WebView/logs |
| RNF-P0-07 | Vertical slice: mudanças concentradas em board-chat + BoardChat UI |

---

## 5. MoSCoW

| Prioridade | Item |
|------------|------|
| **Must** | Silent-until-@; MarkdownEditor mentions; Coolify sem CLI; flag gate; RF-P0-03/06/13/14 |
| **Should** | Wake real `conference_room_mentioned` já em P0; copy UX; activity log |
| **Could** | Coach de bare `@Name` → chip (como IssueChatThread) |
| **Won't** | Fan-out; cost pill; DelegationTrace; concierge remoto LLM |

---

## 6. UX

### 6.1 Composer

- Autocomplete `@` com avatar/ícone do agente.
- Chips de mention visuais (reuse mention-chip decoration do MarkdownEditor).
- Empty/hint: silêncio até `@`.

### 6.2 Feedback silent

- Após send sem `@`: mensagem aparece no histórico; **sem** typing bubble / "Thinking…".
- Toast opcional (uma vez / session): "Nenhum agente mencionado — mensagem só na sala."

### 6.3 Feedback com `@` (P0)

- Se só contrato pending: status curto "Menção registrada" (sem fingir resposta de agente).
- Se wake enfileirado: "Acordando @CEO…" (P1 refinará streaming/reply).

### 6.4 A11y

- Lista de mentions: `role="listbox"` / option (já no MarkdownEditor — não regredir).
- Erros com `role="alert"`.

### 6.5 Personas

- **Board:** liga flag experimental, testa Coolify.
- **Sofia (operator via Board UI):** entende que precisa `@` para chamar agente (beachhead software house).

---

## 7. Arquitetura (arquivos absolutos no fork)

### 7.1 Criar

| Arquivo | Responsabilidade |
|---------|------------------|
| `/Users/macbook/Projects/paperclip/server/src/services/room-message.ts` | Parse mentions, decide `silent` vs `adapter_wake`, persist comment, (opcional) enqueue wakeup |
| `/Users/macbook/Projects/paperclip/server/src/__tests__/room-message.test.ts` | Unit: extract + mode selection |
| `/Users/macbook/Projects/paperclip/server/src/__tests__/board-chat-silent-until-at.test.ts` | Route: silent / mention / flag / authenticated |
| `/Users/macbook/Projects/paperclip/ui/src/pages/BoardChat.mentions.test.tsx` | Composer mentions + silent send UI |
| `/Users/macbook/Projects/paperclip/packages/shared/src/validators/board-chat.ts` | Zod body: `companyId`, `message`, `taskId?` |

### 7.2 Modificar

| Arquivo | Mudança |
|---------|---------|
| `/Users/macbook/Projects/paperclip/server/src/routes/board-chat.ts` | Remover hard-block `local_trusted`; branch silent vs mention; sem spawn CLI no authenticated; integrar `room-message` |
| `/Users/macbook/Projects/paperclip/server/src/__tests__/board-chat-route-feature-flag.test.ts` | Atualizar expectativas `DEPLOYMENT_MODE_UNSUPPORTED` |
| `/Users/macbook/Projects/paperclip/ui/src/pages/BoardChat.tsx` | MarkdownEditor + mentions; `sendMessage` consome JSON silent/pending; sem SSE obrigatório no silent |
| `/Users/macbook/Projects/paperclip/ui/src/components/ChatComposer.tsx` | Só se ainda usado como shell — preferir MarkdownEditor direto |
| `/Users/macbook/Projects/paperclip/server/src/routes/openapi.ts` | Documentar novo contrato de resposta |
| `/Users/macbook/Projects/paperclip/tests/e2e/conference-room-typing-intro.spec.ts` | Ajustar se send path mudou |
| `/Users/macbook/Projects/paperclip/packages/shared/src/index.ts` | Export validator board-chat se novo |

### 7.3 Reusar (não reimplementar)

- `/Users/macbook/Projects/paperclip/packages/shared/src/project-mentions.ts` — `extractAgentMentionIds`, `buildAgentMentionHref`
- `/Users/macbook/Projects/paperclip/ui/src/components/MarkdownEditor.tsx`
- `/Users/macbook/Projects/paperclip/server/src/services/issues.ts` — `findMentionedAgents`, `addComment`
- `/Users/macbook/Projects/paperclip/server/src/services/heartbeat.ts` — `wakeup`
- `/Users/macbook/Projects/paperclip/server/src/services/instance-settings.ts` — experimental flag
- Pattern de mention wake em `/Users/macbook/Projects/paperclip/server/src/routes/issues.ts` (~L5710–5736)

### 7.4 Fluxo de dados

```
BoardChat.send(message)
  → POST /api/board/chat/stream  (ou renomear para /api/board/chat/message — se renomear, alias compat)
  → roomMessage.handle({ companyId, message, taskId, actor, deploymentMode })
       → ensureBoardOperationsIssue()
       → comment = addComment(...)
       → ids = findMentionedAgents(...)
       → if ids.empty → { mode: "silent", ... }
       → else → { mode: "adapter_wake_pending", mentionedAgentIds: ids, ... }
                (+ optional wakeup each id — prefer 1 host in P1)
  → UI invalida comments query
```

**Nota de naming:** manter path `/board/chat/stream` em P0 por compat UI, mesmo quando a resposta for JSON não-SSE; ou aceitar dual: SSE só legado CLI (se retained). Preferir JSON único + atualizar `BoardChat.tsx` fetch parser.

---

## 8. Qualidade / smoke tests

### 8.1 Automatizados

| ID | Caso |
|----|------|
| ST-P0-01 | Flag OFF → 403 `FEATURE_DISABLED` |
| ST-P0-02 | Authenticated + mensagem sem `@` → 200 `mode:"silent"`; zero `spawn`; zero wakeup |
| ST-P0-03 | Authenticated + `[@CEO](agent://…)` → 200/202 `adapter_wake_pending` com `mentionedAgentIds` |
| ST-P0-04 | `@CEO` texto cru sem link → tratado como silent |
| ST-P0-05 | Mention de agentId fora da company → filtrado (lista vazia ou 400) |
| ST-P0-06 | UI: MarkdownEditor renderiza options de agents |
| ST-P0-07 | UI: send sem `@` não mostra TypingBubble infinito |
| ST-P0-08 | `extractAgentMentionIds` regressão (shared tests existentes passam) |

### 8.2 Smoke manual Coolify

| ID | Passo | Esperado |
|----|-------|----------|
| ST-P0-M01 | Flag ON no Instance Experimental | Nav Conference Room visível |
| ST-P0-M02 | Mensagem "ping" sem @ | Aparece no histórico; nenhum agente roda |
| ST-P0-M03 | Digitar `@` | Lista CEO/Dev |
| ST-P0-M04 | Enviar mention | Sem erro 403 deployment; comment persistido |
| ST-P0-M05 | Network tab | Sem tentativa de stream CLI local |

### 8.3 Comandos sugeridos

```bash
cd /Users/macbook/Projects/paperclip
pnpm test --filter @paperclipai/server -- board-chat-silent
pnpm test --filter @paperclipai/ui -- BoardChat.mentions
```

---

## 9. Pesquisa / referências

| Ref | Onde |
|-----|------|
| Cycle 1 discovery | `docs/research/slack-a2a-room/cycle-1-discovery/00-INDEX.md` |
| Cycle 2 gaps BoardChat | `docs/research/slack-a2a-room/cycle-2-confirmation/00-INDEX.md` |
| Cycle 3 P0 na matriz GTM | `docs/research/slack-a2a-room/cycle-3-deep-dive/03-verticals-and-value.md` §8.A |
| Mentions issues | `/Users/macbook/Projects/paperclip/server/src/routes/issues.ts` |
| Delegation (não P0) | `/Users/macbook/Projects/paperclip/doc/spec/agent-delegation-a2a.md` |
| UX indústria | Claude Tag / Linear Agents / Teams @ (Cycle 2) |

---

## 10. Entregáveis

1. SPEC este arquivo (aprovado).
2. `room-message` service + testes.
3. `board-chat.ts` Coolify-safe + silent-until-@.
4. `BoardChat.tsx` com MarkdownEditor mentions.
5. OpenAPI / contrato documentado.
6. E2E/smoke ST-P0-* verdes em staging Coolify.
7. Nota de handoff P0→P1 (seção 12).

---

## 11. Definição de pronto (DoD)

- [ ] Flag `enableConferenceRoomChat` ainda gateia API+UI
- [ ] Mensagem sem `@` → silent persist only (Coolify + local)
- [ ] Composer com `@` autocomplete de agentes da company
- [ ] Mentions estruturadas `agent://` apenas
- [ ] `deploymentMode: authenticated` não retorna `DEPLOYMENT_MODE_UNSUPPORTED` para a sala
- [ ] Zero spawn `claude` no path authenticated
- [ ] ST-P0-01…08 passando
- [ ] ST-P0-M01…M05 em Coolify staging
- [ ] Sem fan-out / cost / DelegationTrace (scope guard)
- [ ] Handoff P1 escrito

---

## 12. Riscos / handoff

### 12.1 Riscos

| Risco | Prob. | Impacto | Mitigação |
|-------|-------|---------|-----------|
| UI ainda assume SSE forever | Alta | Médio | Refatorar `sendMessage` para JSON primeiro |
| E2E typing-intro quebra | Média | Baixo | Atualizar specs |
| Wake sem reply confunde usuário | Média | Médio | Copy "menção registrada"; completar em P1 rápido |
| Duplicate wakes se reusar issue mention path cegamente | Média | Alto | Reason dedicado `conference_room_mentioned`; não passar por assignee wake |
| MarkdownEditor Enter vs submit | Baixa | Médio | Alinhar `onSubmit` IssueChatThread |

### 12.2 Handoff → P1

Entregar a P1:

1. Contrato `mode: "adapter_wake_pending" | "silent"` estável + `roomMessageId` (= commentId).
2. Lista `mentionedAgentIds` validada.
3. Composer mentions production-ready.
4. Preferência de host: **primeiro mention** = candidato a host run (CEO beachhead).
5. Sem fan-out ainda — se N mentions em P0, ou rejeitar com 400 `MULTI_MENTION_REQUIRES_P2`, ou aceitar só o primeiro e ignorar resto com warning no JSON (`ignoredAgentIds`). **Decisão P0:** aceitar N no parse mas só documentar; wake de N = P2. Em P0/P1 single-mention: se `mentionedAgentIds.length > 1`, retornar `400 { code: "FANOUT_NOT_ENABLED" }` **ou** processar só `[0]` com `warning`. Preferir **400** para forçar UX clara até P2.

**Critério de handoff:** Sofia em Coolify posta sem `@` (silêncio) e com `@CEO` (contrato pending / wake enfileirado) sem erro de deployment mode.

---

## 13. Open questions

1. Renomear endpoint `/board/chat/stream` → `/board/chat/message` agora ou em P1?
2. Concierge CLI `local_trusted`: deletar ou feature-flag interna?
3. Multi-mention em P0/P1: 400 vs first-only? (SPEC recomenda **400 `FANOUT_NOT_ENABLED`** até P2.)
4. `wakeReason` string final: `conference_room_mentioned` vs reusar `issue_comment_mentioned`? (Preferir novo para não herdar batching/defer rules indesejadas — validar em heartbeat.)

---

*Documento Cycle 5 — implementação no fork Paperclip. Alterações breaking: bump versão no header.*
