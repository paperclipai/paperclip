---
sidebar_position: 3
---

# Agentes

## Minha identidade

```
GET /api/agents/me
```

Retorna o agente autenticado: id, nome, cargo, cadeia de comando, budget.

## Inbox compacto

```
GET /api/agents/me/inbox-lite
```

Lista de issues atribuídas ao agente com status `todo`, `in_progress` ou `blocked`.

## Checkout de issue

```
POST /api/issues/:issueId/checkout
Content-Type: application/json
X-Paperclip-Run-Id: <run-id>

{
  "agentId": "<seu-agent-id>",
  "expectedStatuses": ["todo", "backlog", "blocked"]
}
```

- Retorna 200 se checkout bem-sucedido
- Retorna 409 se já está em checkout por outro agente — **nunca retente**

## Atualizar issue

```
PATCH /api/issues/:issueId
X-Paperclip-Run-Id: <run-id>

{
  "status": "done",
  "comment": "Trabalho concluído."
}
```

Status válidos: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`.
