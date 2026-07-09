# Conference Room Product Ladder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subir Conference Room da média ~5 (barra produto) para ~6–8 ligando a sala a A2A/live UX/HITL/NUX, sem reinventar o motor.

**Architecture:** Waves incrementais. Wave 1 desbloqueia `@A @B` (multi-wake paralelo + contrato `fanout`) e latência via LiveUpdates; Wave 2 adiciona HITL cards + transcript; Wave 3 playbooks/GA. Fan-out A2A completo (delegate sob host running) é Wave 1.5 quando reportsTo permitir.

**Tech Stack:** Express/Drizzle (server), React Query + LiveUpdates WS (UI), validators Zod em `packages/shared`, specs em `docs/bizcursor/.../P2-fanout-join-SPEC.md` e `P3-peer-wait-hitl-SPEC.md`.

**Barra de sucesso:** scores alvo Integração ≥6, Perf ≥6, Onboarding ≥6, Qualidade ≥5.5 (média ≥6).

**NotebookLM:** GO (Paperclip-only).

---

## File map

| Área | Arquivos |
|------|----------|
| Fan-out prepare/commit | `server/src/services/room-message.ts`, `room-orchestrator.ts`, `routes/board-chat.ts` |
| Contratos | `packages/shared/src/validators/board-chat.ts` |
| Live WS | `ui/src/context/LiveUpdatesProvider.tsx` |
| UI sala | `ui/src/pages/BoardChat.tsx`, `board-chat/*` |
| HITL | `IssueThreadInteractionCard.tsx` (reuse), BoardChat |
| Tests | `board-chat-silent-until-at.test.ts`, `room-message.test.ts`, `BoardChat*.test.tsx` |

---

## Wave 1 — →6 (fan-out MVP + live + NUX)

### Task 1: NUX chips com `@CEO` + copy leiga

**Files:**
- Modify: `ui/src/pages/BoardChat.tsx` (chips ~1170)
- Modify: `ui/src/pages/board-chat/BoardChatComposer.tsx` (hint se necessário)
- Test: `ui/src/pages/BoardChat.test.tsx` / mentions test

- [x] **Step 1:** Prefixar cada chip prompt com mention markdown do CEO (`[@Name](agent://id)` ou formato que `findMentionedAgents` já resolve).
- [x] **Step 2:** Se não houver CEO, chips usam primeiro agente ativo ou desabilitam com tooltip.
- [x] **Step 3:** Atualizar notice silent para PT leiga: “Mencione um agente com @ para ele responder.”
- [x] **Step 4:** Teste: chip click inclui `agent://` no input.
- [x] **Step 5:** Verificar vitest UI.

### Task 2: LiveUpdates reconhece `/board-chat`

**Files:**
- Modify: `ui/src/context/LiveUpdatesProvider.tsx` (`resolveVisibleIssueRouteContext`)
- Modify: `ui/src/pages/BoardChat.tsx` (reduzir poll quando live cobrir)
- Test: se houver teste de LiveUpdates; senão smoke manual + BoardChat tests

- [x] **Step 1:** Quando pathname contém `board-chat`, resolver `boardIssueId` do React Query cache (`queryKeys.issues.list` board-ops / sessionStorage / query data BoardChat já seta).
- [x] **Step 2:** Popular `issueRefs` com esse id para invalidar comments/liveRuns/runs/interactions.
- [x] **Step 3:** Em BoardChat, com turn path + live: manter turn poll 2s só como fallback; comments idle 30s ok.
- [x] **Step 4:** Verificar typecheck/tests.

### Task 3: Fan-out multi-wake (MVP P2-lite)

> Spec P2 completa = CEO host + `delegateFromRun` wait:false. **MVP Wave 1:** acordar **todos** os mentioned agents em paralelo via `wakeHost` (idempotency `room:{roomMessageId}:agent:{agentId}`), mode `fanout`. Wave 1.5 liga A2A real.

**Files:**
- Modify: `server/src/services/room-message.ts` — remover throw fan-out; cap `TOO_MANY_MENTIONS` (max 5)
- Modify: `server/src/services/room-orchestrator.ts` — `wakeHosts` / loop
- Modify: `server/src/routes/board-chat.ts` — response fanout; rate-limit por wake batch
- Modify: `packages/shared/src/validators/board-chat.ts` — schema `mode: "fanout"`
- Modify: `server/src/routes/openapi.ts`
- Modify: `ui/src/pages/BoardChat.tsx` — handle fanout (múltiplos hostRunIds / typing)
- Test: `room-message.test.ts`, `board-chat-silent-until-at.test.ts`

- [x] **Step 1:** Teste falhando: 2 mentions → não lança FanoutNotEnabled; retorna prepared com 2 ids.
- [x] **Step 2:** Implementar prepare (cap 5 → TOO_MANY_MENTIONS).
- [x] **Step 3:** Route: para N≥2, commit uma vez, wake N agents, return `{ mode: "fanout", hostRuns: [{agentId, runId}], roomMessageId, issueId }`.
- [x] **Step 4:** Rate limit: contar 1 “batch” por POST (não N× user limit) OU N× com cap — preferir 1 batch = 1 slot do user limit.
- [x] **Step 5:** UI: mode fanout → set sending até todos terminais (poll turns ou liveRuns); mensagem PT se parcial.
- [x] **Step 6:** Remover/atualizar copy “Fan-out chega na P2”.
- [x] **Step 7:** Testes server + UI verdes.

### Task 4: `listComments` com limit na sala

**Files:** `ui/src/pages/BoardChat.tsx`

- [x] **Step 1:** Passar `limit: 100` (ou API equivalente) ao listar comments do Board Ops.
- [x] **Step 2:** Teste/smoke.

---

## Wave 1.5 — Fan-out A2A real (após MVP estável)

### Task 5: CEO host + delegate wait:false

**Files:** `room-orchestrator.ts`, `run-delegation.ts` (reuse), board-chat route

- [ ] Wake CEO (ou first mention) como host.
- [ ] Quando host `running` (job async ou continuation), `delegateFromRun` por child com `clientKey: room:{id}:child:{agentId}`.
- [ ] Strict org policy 409 `DELEGATION_NOT_IN_ORG`.
- [ ] UI mínima: lista childRunIds + link “Ver runs” (DelegationTrace full = Wave 2).

---

## Wave 2 — →7 (HITL + transcript)

### Task 6: HITL cards na sala

- [x] `useQuery(interactions)` no Board Ops issue.
- [x] Render `IssueThreadInteractionCard` no timeline.
- [x] LiveUpdates invalida interactions no path board-chat.

### Task 7: Transcript preview no host bubble

- [ ] `useLiveRunTranscripts` com host (+ children se fanout).
- [ ] Mostrar chunks sob typing bubble (reuse IssueChatThread pattern).

### Task 8: Reavaliar `forceFreshSession`

- [ ] Resume session quando mesmo agent + mesma Board Ops issue (exceto mudança de modelo).

---

## Wave 3 — →8 (qualidade + onboarding GA)

### Task 9: Playbook mínimo enforceável

- [ ] Documento `room_playbook` (issue doc ou company setting) injetado no wake contextSnapshot.
- [ ] Skill paperclip-board referencia playbook.

### Task 10: Flag GA / discoverability

- [ ] Toggle mais visível ou default-on em dev; empty state “Como ativar” se off.
- [ ] History/New chat: esconder até existir OU implementar reset de view local.

---

## Verification (cada wave)

```sh
pnpm exec vitest run \
  server/src/__tests__/room-message.test.ts \
  server/src/__tests__/board-chat-silent-until-at.test.ts \
  server/src/__tests__/board-chat-route-feature-flag.test.ts \
  server/src/__tests__/room-orchestrator.test.ts \
  ui/src/pages/BoardChat.mentions.test.tsx \
  ui/src/pages/BoardChat.test.tsx
```

Antes de PR: `pnpm -r typecheck` no escopo tocado.

---

## Out of scope (Won't nesta ladder)

- MCP picker board-side (→9–10)
- Idempotency Redis/DB (→9)
- Quorum Aegean completo (P3 partial)
- plane.so Work Request full (P1.5)
