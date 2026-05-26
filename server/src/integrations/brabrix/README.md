# Brabrix Agent Integration

Este diretório contém a integração HTTP do fork com APIs do Brabrix Dev, mantendo desacoplamento para não alterar a lógica principal dos agentes nesta etapa.

## Arquitetura

### `brabrix-types.ts`
Contratos tipados de domínio da integração:

- `ProjectContext`
- `BrabrixTask`
- `AgentRun`
- `SkillContext`
- payloads para envio de logs e conclusão (`BrabrixSendRunLogsInput`, `BrabrixCompleteTaskInput`)

### `brabrix-config.ts`
Leitura e normalização de configuração via ambiente:

- `BRABRIX_API_URL`
- `BRABRIX_AGENT_TOKEN`
- `BRABRIX_PROJECT_ID`
- `BRABRIX_AGENT_ID`
- `BRABRIX_PROVIDER`
- `BRABRIX_PROJECT_CONTEXT_ENDPOINT`
- `BRABRIX_NEXT_TASK_ENDPOINT`
- `BRABRIX_SEND_RUN_LOGS_ENDPOINT`
- `BRABRIX_COMPLETE_TASK_ENDPOINT`
- `BRABRIX_HTTP_TIMEOUT_MS`
- `BRABRIX_HTTP_MAX_RETRIES`
- `BRABRIX_HTTP_RETRY_DELAY_MS`

`resolveBrabrixConfig()` retorna `null` quando a integração não está pronta, permitindo modo seguro de no-op.

### `brabrix-client.ts`
Cliente HTTP tipado com `fetch`:

- Métodos implementados:
  - `getProjectContext()`
  - `getNextTask()`
  - `sendRunLogs()`
  - `completeTask()`
- Retry simples para falhas transitórias (rede/timeout e status retryable)
- Timeout configurável por env
- Logs estruturados por request (status, tentativa, duração, endpoint)
- Suporte a endpoint template com parâmetros (`/v1/projects/{projectId}/...`)

### `server/src/services/brabrix-agent-sync.ts`
Serviço de orquestração da integração:

- `fetchNextTask()`: busca contexto + próxima task + converte para `AgentGoal` + contexto de execução
- `sendRunLogs()`: envia logs de execução
- `syncStatus()`: sincroniza status explícito da task
- `updateExecution()`: envia logs e conclui task quando status do run é terminal (`completed|failed|canceled`)
- `isEnabled()`: indica se configuração está pronta

### `server/src/services/brabrix-task-goal-mapper.ts`
Mapper tipado para converter `BrabrixTask -> AgentGoal` automaticamente:

- mapeia título, descrição, prioridade e origem da task
- define perfil inicial do agente (`backend`, `frontend`, `qa`)
- anexa metadados para execução (skills, modelo preferido, allowed tools, estimativa de contexto)

### `server/src/services/context-builder.ts`
Builder modular de prompt/contexto:

- inclui PRD, spec técnica, skills, stack, regras e critérios de aceite
- remove duplicações de listas de contexto
- calcula estimativa de tamanho (`chars`, `tokens`) para observabilidade

## Fluxo da integração

1. Inicializar config por `getBrabrixConfig()`.
2. Validar com `resolveBrabrixConfig()`.
3. Se habilitado:
   - carregar `ProjectContext`
   - buscar `BrabrixTask` pendente
   - converter task em `AgentGoal`
   - montar contexto modular para execução do agente
   - enviar logs periódicos de execução
   - concluir task no término do run
4. Se não habilitado:
   - operar em no-op (sem quebrar execução principal)

## Payloads esperados

### `getProjectContext()`
Resposta esperada (aceita variações como `projectContext`, `context`, `data.projectContext`):

```json
{
  "projectContext": {
    "projectId": "proj_123",
    "name": "Brabrix Agent Core",
    "description": "Projeto principal",
    "providers": ["brabrix-dev", "openai"],
    "defaultProvider": "brabrix-dev",
    "skills": [
      {
        "skillKey": "coding.fullstack",
        "name": "Fullstack Coding",
        "version": "1.0.0",
        "provider": "brabrix-dev"
      }
    ],
    "metadata": {
      "segment": "saas"
    }
  }
}
```

### `getNextTask()`
Resposta esperada (aceita variações como `task`, `nextTask`, `data.task`):

```json
{
  "nextTask": {
    "taskId": "task_001",
    "title": "Integrar endpoint de execução",
    "description": "Conectar sync de logs",
    "projectId": "proj_123",
    "priority": "high",
    "skillContext": [
      {
        "skillKey": "backend.integration",
        "name": "Backend Integration"
      }
    ],
    "payload": {
      "branch": "feat/brabrix-sync"
    }
  }
}
```

### `sendRunLogs()`
Request:

```json
{
  "projectId": "proj_123",
  "provider": "brabrix-dev",
  "taskId": "task_001",
  "runId": "run_777",
  "agentRun": {
    "runId": "run_777",
    "agentId": "agent_codegen",
    "provider": "brabrix-dev",
    "status": "running"
  },
  "context": {
    "workspace": "repo-core"
  },
  "logs": [
    {
      "timestamp": "2026-05-25T19:30:00.000Z",
      "level": "info",
      "message": "starting execution",
      "metadata": {
        "step": "plan"
      }
    }
  ]
}
```

### `completeTask()`
Request:

```json
{
  "projectId": "proj_123",
  "provider": "brabrix-dev",
  "taskId": "task_001",
  "runId": "run_777",
  "agentRun": {
    "runId": "run_777",
    "agentId": "agent_codegen",
    "provider": "brabrix-dev",
    "status": "completed"
  },
  "status": "completed",
  "summary": "Entrega finalizada com sucesso",
  "output": {
    "filesChanged": 6
  }
}
```

## Extensibilidade prevista

- Múltiplos agentes:
  - `agentId` propagado por header e payload (`x-brabrix-agent-id`, `agentRun.agentId`)
  - perfis iniciais suportados: `backend`, `frontend`, `qa`
- Múltiplos providers:
  - `provider` configurável por env e enviado em header/payload
- Skills futuras:
  - `SkillContext` em `ProjectContext` e `BrabrixTask`

## Pipeline Arquitetural

Para visão completa da pipeline de conversão `BrabrixTask -> AgentGoal -> Contexto`, veja:

- `server/src/integrations/brabrix/pipeline-architecture.md`

## Onde integrar APIs reais adicionais

- Adicionar novos métodos somente em `brabrix-client.ts`
- Expor orquestração de negócio em `brabrix-agent-sync.ts`
- Manter contratos evolutivos em `brabrix-types.ts`

Com isso, a integração permanece incremental, compatível com upstream e sem acoplamento prematuro à lógica central de agentes.
