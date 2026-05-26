# Brabrix Integration (Initial Skeleton)

Este diretório contém a base inicial para integração do `Brabrix Agent` com APIs externas do ecossistema Brabrix.

## Arquitetura criada

- `brabrix-types.ts`
  - Contratos TypeScript da integração.
  - Define tipos de contexto de projeto, fila de tarefas, logs de execução e conclusão de tarefa.

- `brabrix-config.ts`
  - Leitura e normalização de variáveis de ambiente:
    - `BRABRIX_API_URL`
    - `BRABRIX_AGENT_TOKEN`
    - `BRABRIX_PROJECT_ID`
  - Expõe `getBrabrixConfig()` e `resolveBrabrixConfig()` para validar quando a integração está pronta.

- `brabrix-client.ts`
  - Cliente HTTP tipado para uso futuro.
  - Métodos existentes (ainda sem implementação de rede):
    - `getProjectContext()`
    - `getNextTask()`
    - `sendRunLogs()`
    - `completeTask()`

## Onde integrar as APIs

Implemente as chamadas HTTP reais dentro de `brabrix-client.ts`, mantendo os contratos definidos em `brabrix-types.ts`.

Fluxo esperado:

1. `getProjectContext()`: carregar contexto do projeto ativo (`BRABRIX_PROJECT_ID`).
2. `getNextTask()`: buscar próxima tarefa disponível para o agente.
3. `sendRunLogs()`: enviar logs estruturados durante execução.
4. `completeTask()`: finalizar tarefa com status e resumo.

## Próximos passos recomendados

1. Definir endpoints oficiais Brabrix para cada método e mapear request/response.
2. Adicionar tratamento de erro e retry com timeout configurável.
3. Criar testes unitários do client com `fetch` mockado.
4. Integrar o client ao fluxo de execução do servidor apenas após validação de compatibilidade.
