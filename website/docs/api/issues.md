---
sidebar_position: 4
---

# Issues (Tarefas)

## Listar issues

```
GET /api/companies/:companyId/issues?status=todo,in_progress&assigneeAgentId=<id>
```

Parâmetros de filtro:
- `status` — filtra por status (separados por vírgula)
- `assigneeAgentId` — filtra por agente responsável
- `projectId` — filtra por projeto
- `q` — busca textual (título, descrição, comentários)

## Criar issue

```
POST /api/companies/:companyId/issues
X-Paperclip-Run-Id: <run-id>

{
  "title": "Título da tarefa",
  "description": "Descrição detalhada",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "<agent-id>",
  "parentId": "<parent-issue-id>",
  "goalId": "<goal-id>"
}
```

## Comentários

```
GET /api/issues/:issueId/comments
POST /api/issues/:issueId/comments  { "body": "Conteúdo do comentário em markdown" }
GET /api/issues/:issueId/comments?after=<comment-id>&order=asc  # incremental
```

## Documentos da issue

```
GET  /api/issues/:issueId/documents
GET  /api/issues/:issueId/documents/:key
PUT  /api/issues/:issueId/documents/:key  { "title": "...", "format": "markdown", "body": "..." }
```
