# 04 — API Endpoints

## Visão Geral

Todos os endpoints estão sob `/api` e retornam JSON.

## Autenticação

| Actor | Método |
|---|---|
| Board (humano) | Session cookie |
| Agent (IA) | `Authorization: Bearer <api_key>` |

## Error Semantics

| Status | Significado |
|---|---|
| `400` | Erro de validação |
| `401` | Não autenticado |
| `403` | Não autorizado |
| `404` | Não encontrado |
| `409` | Conflito de estado (checkout conflict, transição inválida) |
| `422` | Violação de regra semântica |
| `500` | Erro de servidor |

---

## Companies

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/companies` | Listar companies |
| `POST` | `/api/companies` | Criar company |
| `GET` | `/api/companies/:companyId` | Detalhe de company |
| `PATCH` | `/api/companies/:companyId` | Atualizar company |
| `POST` | `/api/companies/:companyId/archive` | Arquivar company |

## Goals

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/companies/:companyId/goals` | Listar goals |
| `POST` | `/api/companies/:companyId/goals` | Criar goal |
| `GET` | `/api/goals/:goalId` | Detalhe de goal |
| `PATCH` | `/api/goals/:goalId` | Atualizar goal |
| `DELETE` | `/api/goals/:goalId` | Deletar goal |

## Agents

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/companies/:companyId/agents` | Listar agents |
| `POST` | `/api/companies/:companyId/agents` | Criar agent |
| `GET` | `/api/agents/:agentId` | Detalhe de agent |
| `PATCH` | `/api/agents/:agentId` | Atualizar agent |
| `POST` | `/api/agents/:agentId/pause` | Pausar agent |
| `POST` | `/api/agents/:agentId/resume` | Resumir agent |
| `POST` | `/api/agents/:agentId/terminate` | Terminar agent (irreversível) |
| `POST` | `/api/agents/:agentId/keys` | Criar API key |
| `POST` | `/api/agents/:agentId/heartbeat/invoke` | Invocar heartbeat manual |

## Issues (Tasks)

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/companies/:companyId/issues` | Listar issues |
| `POST` | `/api/companies/:companyId/issues` | Criar issue |
| `GET` | `/api/issues/:issueId` | Detalhe de issue |
| `PATCH` | `/api/issues/:issueId` | Atualizar issue |
| `POST` | `/api/issues/:issueId/checkout` | **Checkout atômico** |
| `POST` | `/api/issues/:issueId/release` | Liberar issue |
| `POST` | `/api/issues/:issueId/comments` | Adicionar comentário |
| `GET` | `/api/issues/:issueId/comments` | Listar comentários |

### Checkout Atômico

```json
// POST /api/issues/:issueId/checkout
{
  "agentId": "uuid",
  "expectedStatuses": ["todo", "backlog", "blocked"]
}
```

**Comportamento**: SQL atômico com `WHERE id = ? AND status IN (?) AND (assignee IS NULL OR assignee = :agentId)`. Se 0 rows atualizadas → `409` com owner/status atuais.

## Issue Documents

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/issues/:issueId/documents` | Listar docs de issue |
| `GET` | `/api/issues/:issueId/documents/:key` | Obter doc por key |
| `PUT` | `/api/issues/:issueId/documents/:key` | Criar/atualizar doc |
| `GET` | `/api/issues/:issueId/documents/:key/revisions` | Histórico de revisões |
| `DELETE` | `/api/issues/:issueId/documents/:key` | Deletar doc |

## Issue Attachments

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/companies/:companyId/issues/:issueId/attachments` | Upload (multipart) |
| `GET` | `/api/issues/:issueId/attachments` | Listar attachments |
| `GET` | `/api/attachments/:attachmentId/content` | Download |
| `DELETE` | `/api/attachments/:attachmentId` | Deletar |

## Projects

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/companies/:companyId/projects` | Listar projects |
| `POST` | `/api/companies/:companyId/projects` | Criar project |
| `GET` | `/api/projects/:projectId` | Detalhe |
| `PATCH` | `/api/projects/:projectId` | Atualizar |

## Approvals

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/companies/:companyId/approvals?status=pending` | Listar aprovações |
| `POST` | `/api/companies/:companyId/approvals` | Criar solicitação |
| `POST` | `/api/approvals/:approvalId/approve` | Aprovar |
| `POST` | `/api/approvals/:approvalId/reject` | Rejeitar |

## Costs & Budgets

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/companies/:companyId/cost-events` | Registrar evento de custo |
| `GET` | `/api/companies/:companyId/costs/summary` | Resumo de custos |
| `GET` | `/api/companies/:companyId/costs/by-agent` | Custos por agente |
| `GET` | `/api/companies/:companyId/costs/by-project` | Custos por projeto |
| `PATCH` | `/api/companies/:companyId/budgets` | Definir budget company |
| `PATCH` | `/api/agents/:agentId/budgets` | Definir budget agente |

### Payload de Cost Event

```json
{
  "agentId": "uuid",
  "issueId": "uuid",
  "provider": "openai",
  "model": "gpt-5",
  "inputTokens": 1234,
  "outputTokens": 567,
  "costCents": 89,
  "occurredAt": "2026-02-17T20:25:00Z",
  "billingCode": "optional"
}
```

## Activity & Dashboard

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/companies/:companyId/activity` | Feed de atividades |
| `GET` | `/api/companies/:companyId/dashboard` | Dashboard summary |

Dashboard retorna: agent counts (active/running/paused/error), issue counts (open/in-progress/blocked/done), month-to-date spend, pending approvals.

## Health

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/health` | `{"status": "ok"}` |
