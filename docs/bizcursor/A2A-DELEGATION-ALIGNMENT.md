# BizCursor F2 × Paperclip A2A Delegation Alignment

Status: Decision record  
Date: 2026-07-04

## Decision

**BizCursor F2 should consume `POST /api/heartbeat-runs/:runId/delegate` as the primary delegation path** when the CEO run is backed by a Paperclip heartbeat with `PAPERCLIP_RUN_ID`.

The desktop orchestrator remains responsible for **trace UI** (parent/child run tree, streaming status), not for emulating delegation via ad-hoc `POST /agents/:id/wakeup` unless the target agent has no Paperclip runtime.

## Rationale

| Approach | Pros | Cons |
|----------|------|------|
| Parser de bloco `delegation` no texto do CEO | Rápido sem server | Frágil, sem policy org, sem cancel propagation |
| Proxy wakeup no desktop (F2 híbrido) | Funciona sem API nova | Loop persiste no Paperclip puro; desktop precisa estar aberto |
| **Paperclip delegate API (este fork)** | Resolve loop na fonte; funciona em Coolify/API/chat | Requer `PAPERCLIP_RUN_ID` no CEO |

## Integration contract

1. CEO chat wake inicia run com `PAPERCLIP_RUN_ID` injetado no adapter/MCP.
2. Quando o CEO precisar delegar ao Dev:
   - **Preferir** `paperclipDelegate` MCP com `{ targetAgentId, task, wait: true }`.
   - BizCursor trace subscreve `GET /api/heartbeat-runs/:childId/events` para UI.
3. Se Dev não tiver endpoint Paperclip (legado): fallback F2 `POST /agents/:id/wakeup` documentado em RF-F2-16 — **somente** nesse caso.
4. Issue filha: deixar `createChildIssue: true` (default) para auditoria no board.

## Não duplicar

- Não manter dois sistemas de trace (desktop synthetic tree + server `parentRunId`) para o mesmo delegação.
- Remover parser de delegação por texto quando MCP delegate estiver disponível no CEO adapter.

## Verificação

- CEO delega com `wait: true` → 1 child run com `parentRunId` + parent `delegationStatus: completed` sem heartbeats extras de polling.
- Cancel CEO → child runs cancelados (`cancelChildDelegations`).
