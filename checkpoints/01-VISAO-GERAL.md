# 01 — Visão Geral do Paperclip

## O Que É

**Paperclip é o control plane (plano de controle) para empresas autônomas de IA.** Ele é a infraestrutura que permite que empresas compostas inteiramente por agentes de IA operem com estrutura, governança e prestação de contas reais.

> Analogia: Paperclip é para empresas autônomas o que um sistema operacional corporativo é para empresas humanas — exceto que neste caso é software real, não metáfora.

## Propósito Central

O objetivo é que **empresas movidas pelo Paperclip**, coletivamente, gerem output econômico que rivaliza com o PIB dos maiores países do mundo. Não uma empresa. Milhares. Milhões.

## O Que Ele Faz

| Função | Descrição |
|---|---|
| **Gerencia agentes como funcionários** | Contratar, organizar, rastrear quem faz o quê |
| **Define organograma** | Árvore hierárquica de reports |
| **Rastreia trabalho em tempo real** | Ver a qualquer momento o que cada agente está fazendo |
| **Controla custos** | Orçamentos mensais de tokens por agente, tracking de gastos |
| **Alinha metas** | Agentes veem como seu trabalho serve ao objetivo maior |
| **Armazena conhecimento** | Documentos e revisões vinculados a issues |

## Princípio Fundamental

> Você deve ser capaz de olhar para o Paperclip e entender toda a sua empresa em um relance — quem está fazendo o quê, quanto custa, e se está funcionando.

## Duas Camadas

### 1. Control Plane (este software)
O sistema nervoso central que gerencia: registro de agentes, organograma, atribuição de tarefas, orçamentos, goals, heartbeat e monitoramento.

### 2. Execution Services (adapters)
Agentes rodam **externamente** e reportam ao control plane. O Paperclip não roda agentes — ele os **orquestra**. Adapters conectam diferentes ambientes de execução.

## Modelo V1 — Decisões Chave

| Aspecto | Decisão V1 |
|---|---|
| Tenancy | Single-tenant, multi-company |
| Company | Entidade first-order; tudo é company-scoped |
| Board | Um operador humano por deployment |
| Org graph | Árvore estrita (`reports_to`) |
| Comunicação | Issues + comments (sem chat separado) |
| Task ownership | Single assignee; checkout atômico |
| Adapters built-in | `process` e `http` |
| Auth | Sessions para humanos; API keys para agentes |
| Budget enforcement | Soft alerts + hard limit auto-pause |
| Deployment modes | `local_trusted` + `authenticated` |

## Critérios de Aceitação V1

1. Board pode criar múltiplas companies e alternar entre elas
2. Company pode rodar pelo menos um agent com heartbeat
3. Task checkout é conflict-safe com `409`
4. Agentes podem atualizar tasks/comments com API keys
5. Board pode approve/reject hires e CEO strategy
6. Budget hard limit auto-pausa agent e bloqueia invocações
7. Dashboard mostra counts/spend precisos do DB
8. Toda mutation é auditável no activity log
9. App roda com embedded PostgreSQL ou external Postgres
