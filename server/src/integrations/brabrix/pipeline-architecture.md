# Brabrix Task -> Agent Goal Pipeline

## Objetivo

Converter automaticamente uma `BrabrixTask` em `AgentGoal` com contexto operacional pronto para execução por agente, mantendo arquitetura modular e sem acoplamento com o core de multi-agent.

## Componentes

1. `server/src/integrations/brabrix/brabrix-client.ts`
   - Busca `ProjectContext` e `BrabrixTask` do Brabrix Dev.

2. `server/src/services/brabrix-task-goal-mapper.ts`
   - Converte `BrabrixTask` em `AgentGoal`.
   - Define metadados de execução (skills aplicadas, modelo preferido, estimativa de contexto).

3. `server/src/services/context-builder.ts`
   - Monta contexto modular para execução:
     - PRD
     - spec técnica
     - skills
     - stack
     - regras do projeto
     - critérios de aceite
   - Resolve perfil inicial de agente: `backend`, `frontend`, `qa`.

4. `server/src/services/brabrix-agent-sync.ts`
   - Orquestra a sincronização:
     - busca task
     - converte para goal/contexto
     - expõe bundle para etapa de execução
     - sincroniza logs/status com Brabrix.

## Fluxo

1. `fetchNextTask()` chama `getProjectContext()` e `getNextTask()`.
2. Se existir task:
   - chama `mapBrabrixTaskToAgentGoal(...)`
   - que internamente chama `buildBrabrixAgentContext(...)`
3. Serviço retorna um bundle:
   - `projectContext`
   - `task`
   - `goal`
   - `context`
4. Serviço registra logs estruturados com:
   - seções de contexto enviadas
   - tamanho estimado (`chars`, `tokens`)
   - skills aplicadas
   - perfil de agente selecionado
5. Em execução, `sendRunLogs()` e `syncStatus()/updateExecution()` mantêm status remoto no Brabrix.

## Exemplo de Entrada (BrabrixTask)

```json
{
  "taskId": "task_101",
  "title": "Implementar endpoint de faturamento",
  "description": "Criar API de cobranca com validacoes.",
  "priority": "high",
  "agentTypeHint": "backend",
  "prd": "Fluxo de cobranca recorrente com boleto e pix.",
  "technicalSpec": "POST /api/billing/invoices + idempotencia via header",
  "stack": ["Node.js", "PostgreSQL"],
  "projectRules": ["Nao quebrar contratos existentes"],
  "acceptanceCriteria": ["Retornar 201 para criacao valida"],
  "skillContext": [
    { "skillKey": "backend.api", "name": "Backend API" }
  ]
}
```

## Exemplo de Saída (AgentGoal)

```json
{
  "source": "brabrix",
  "sourceTaskId": "task_101",
  "sourceProjectId": "proj_1",
  "title": "Implementar endpoint de faturamento",
  "description": "Criar API de cobranca com validacoes.",
  "level": "task",
  "status": "planned",
  "agentProfile": "backend",
  "metadata": {
    "priority": "high",
    "skillsApplied": ["backend.api"],
    "preferredModel": "gpt-5.4",
    "allowedTools": ["read", "write", "edit", "search", "bash", "test", "http"]
  }
}
```

## Exemplo de Resumo de Contexto Gerado

```json
{
  "profile": {
    "key": "backend",
    "role": "Backend Agent"
  },
  "sections": ["task", "prd", "technical_spec", "skills", "stack", "project_rules", "acceptance_criteria"],
  "skillsApplied": ["backend.api"],
  "estimatedChars": 1640,
  "estimatedTokens": 410
}
```

## Extensão Futura

- Múltiplos providers: já suportado por `provider` no client/config.
- Multi-agent avançado: manter a mesma saída (`goal` + `context`) como contrato estável para futura orquestração.
- Novos perfis: adicionar em `BRABRIX_AGENT_PROFILES` sem alterar o fluxo base.
