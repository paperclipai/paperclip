# 05 — Fluxos e Máquinas de Estado

## Máquinas de Estado

### Agent Status

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> running
    running --> idle
    running --> error
    error --> idle
    idle --> paused
    running --> paused: requires cancel flow
    paused --> idle
    idle --> terminated: board only
    running --> terminated: board only
    error --> terminated: board only
    paused --> terminated: board only
    terminated --> [*]: irreversível
```

### Issue Status

```mermaid
stateDiagram-v2
    [*] --> backlog
    backlog --> todo
    backlog --> cancelled
    todo --> in_progress
    todo --> blocked
    todo --> cancelled
    in_progress --> in_review
    in_progress --> blocked
    in_progress --> done
    in_progress --> cancelled
    in_review --> in_progress
    in_review --> done
    in_review --> cancelled
    blocked --> todo
    blocked --> in_progress
    blocked --> cancelled
    done --> [*]
    cancelled --> [*]
```

**Side Effects**:
- Entrar em `in_progress` → seta `started_at` (se null)
- Entrar em `done` → seta `completed_at`
- Entrar em `cancelled` → seta `cancelled_at`

### Approval Status

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> approved
    pending --> rejected
    pending --> cancelled
    approved --> [*]
    rejected --> [*]
    cancelled --> [*]
```

---

## Fluxos de Governança

### Fluxo de Hiring (Contratação de Agent)

```mermaid
sequenceDiagram
    participant Agent/Board as Agent ou Board
    participant API as Paperclip API
    participant DB as Database
    participant Board as Board Operator

    Agent/Board->>API: POST /approvals (type=hire_agent)
    API->>DB: Cria approval(status=pending, payload=agent draft)
    API->>Board: Notificação de aprovação pendente
    Board->>API: POST /approvals/:id/approve
    API->>DB: Cria agent row
    API->>DB: Cria API key (opcional)
    API->>DB: Log em activity_log
```

> **Atalho**: Board pode criar agents diretamente pela UI sem passar pelo fluxo de aprovação.

### Fluxo de CEO Strategy Approval

```mermaid
sequenceDiagram
    participant CEO as CEO Agent
    participant API as Paperclip API
    participant Board as Board Operator

    CEO->>API: POST /approvals (type=approve_ceo_strategy)
    Note over CEO,API: Payload contém plano, estrutura, tasks
    API->>Board: Notificação de estratégia pendente
    Board->>API: POST /approvals/:id/approve
    Note over API: CEO agora pode mover tasks para estados de execução
```

> Antes da primeira aprovação de estratégia, o CEO só pode **rascunhar** tasks, não ativá-las.

### Fluxo de Heartbeat (Execução de Agent)

```mermaid
sequenceDiagram
    participant Sched as Scheduler
    participant API as API Server
    participant Adapter as Adapter (process/http)
    participant Agent as Agent Runtime

    Sched->>API: Timer tick para agente X
    API->>API: Validar: agent não pausado/terminated, sem run ativo, budget ok
    API->>Adapter: invoke(agent, context)
    
    alt Process Adapter
        Adapter->>Agent: spawn child process
        Agent-->>Adapter: stdout/stderr
        Adapter-->>API: Run status (success/fail/timeout)
    else HTTP Adapter
        Adapter->>Agent: HTTP POST com payload
        Agent-->>Adapter: 2xx = accepted
        Agent-->>API: Callback com resultado
    end
    
    API->>API: Atualizar heartbeat_runs
    API->>API: Atualizar agent.last_heartbeat_at
```

### Fluxo de Budget Enforcement

```mermaid
sequenceDiagram
    participant Agent as Agent
    participant API as API
    participant Budget as Budget Service
    participant Board as Board

    Agent->>API: POST /cost-events
    API->>Budget: Verificar thresholds
    
    alt 80% threshold (soft)
        Budget->>Board: Alerta de budget
    else 100% threshold (hard)
        Budget->>API: Auto-pause agent
        Budget->>API: Bloquear novos checkouts/invocações
        Budget->>Board: Alerta de budget crítico
        Note over Board: Board pode aumentar budget ou resumir manualmente
    end
```

### Fluxo de Checkout Atômico

```mermaid
sequenceDiagram
    participant A1 as Agent A
    participant A2 as Agent B
    participant API as API
    participant DB as Database

    A1->>API: POST /issues/:id/checkout {agentId: A}
    A2->>API: POST /issues/:id/checkout {agentId: B}
    
    API->>DB: UPDATE WHERE id=? AND status IN (?) AND assignee IS NULL
    
    alt Agent A ganha (1 row updated)
        DB-->>API: 1 row
        API-->>A1: 200 OK
    end
    
    alt Agent B perde (0 rows updated)
        DB-->>API: 0 rows
        API-->>A2: 409 Conflict + current owner/status
    end
```

---

## Permissões (Board vs Agent)

| Ação | Board | Agent |
|---|---|---|
| Criar company | ✅ | ❌ |
| Contratar/criar agent | ✅ (direto) | Via aprovação |
| Pausar/resume agent | ✅ | ❌ |
| Criar/atualizar task | ✅ | ✅ |
| Force reassign task | ✅ | Limitado |
| Aprovar strategy/hires | ✅ | ❌ |
| Reportar custo | ✅ | ✅ |
| Definir budget company | ✅ | ❌ |
| Definir budget subordinado | ✅ | ✅ (sub-árvore) |

## Board Override Powers

O Board pode a qualquer momento:
- Pausar/resume/terminar qualquer agent
- Reassignar ou cancelar qualquer task
- Editar budgets e limites
- Aprovar/rejeitar/cancelar aprovações pendentes
