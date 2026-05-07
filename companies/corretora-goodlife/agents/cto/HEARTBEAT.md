# HEARTBEAT — CTO

Frequência:
- Status resumido diário; heartbeat detalhado a cada 6 horas enquanto ativo.

Payload exemplo:
{
  "agent": "cto",
  "timestamp": "2026-05-07T12:00:00Z",
  "status": "ok|degraded|issue",
  "focus": "descrição curta da tarefa/PR",
  "notes": "observações"
}

Checks:
- Estado dos pipelines CI
- Disponibilidade do Openclaw/Ollama
- Backlog de issues de segurança

Escalonamento:
- `degraded` → notificar `devops` e `pentester`.
- `issue` → reunião de emergência e criar issue com label `blocker`.
