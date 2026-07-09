# UX — Hybrid Team Panel (humanos + agentes)

> **Ciclo:** 3B — ClickUp deep dive  
> **Data:** 2026-07-09  
> **Decisões:** D-09 (Path B+), D-11 (Insights fora do stream), D-13 (roster + lanes)  
> **Implementação alvo:** `/Users/macbook/Projects/paperclip/ui/src/features/hybrid-team/`  
> **Personas:** Sofia (Operator) e Board (admin) — mesma superfície, densidades diferentes

---

## 1. Job-to-be-done

> “Ver **quem** (humano ou agente) está no time, **o que** cada um está carregando, **se** está saudável, e **pedir** trabalho sem sair do painel.”

Não é Org Chart (hierarquia). Não é Agents (só bots). Não é Company Access (só ACL). É o **workforce canvas** híbrido.

---

## 2. IA da informação

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Team                                          [Humano|Agente|Ambos] 🔍  │
├──────────────┬──────────────────────────────────────────────────────────┤
│ ROSTER       │ CAPACITY LANES                                           │
│              │                                                          │
│ ○ Sofia      │ Sofia    ████████░░  4/5 WIP                             │
│ ○ Board Dev  │ João     ██████░░░░  3/5                                 │
│ ─────────    │ ─────────────────────────────────────                    │
│ ◉ @CEO       │ @CEO     ████░░░░░░  1/2 runs   $12 / $50                │
│ ◉ @Dev       │ @Dev     ██████████  2/2 runs   $41 / $50 ⚠              │
│ ◉ @QA        │ @QA      ██░░░░░░░░  0/2 runs   $3 / $50                 │
│              │                                                          │
├──────────────┴──────────────────────────────────────────────────────────┤
│ DETAIL DRAWER (seleção)     │  INSIGHTS STRIP (compacto)                │
│ status · role · actions     │  Reliance 62% · Cost sem. · Overload 1    │
└─────────────────────────────────────────────────────────────────────────┘
```

| Zona | Conteúdo | Sofia vê | Board vê |
|------|----------|----------|----------|
| **Roster** | Lista unificada com tipo `human` \| `agent` | Nome, papel, status amigável | + adapter, agentId curto |
| **Capacity lanes** | Barras de carga | WIP / “ocupado” | + runs, budget window, queue |
| **Detail drawer** | Card do selecionado | Pedir / pausar (se permitido) | Config, routines, costs link |
| **Insights strip** | 3–4 KPIs | Linguagem simples | Números + deep-link Costs |

**Regra:** o stream da Room **não** aparece aqui. Link “Abrir sala” no header.

---

## 3. Roster — modelo de linha

### 3.1 Campos comuns

| Campo | Tipo | Fonte Paperclip |
|-------|------|-----------------|
| `principalId` | `user:<id>` \| `agent:<id>` | members + agents |
| `displayName` | string | UserProfile / Agent.name |
| `kind` | `human` \| `agent` | discriminador |
| `roleLabel` | string | human role / `AGENT_ROLE_LABELS` |
| `status` | enum unificado (abaixo) | membership + agent.status + run liveness |
| `avatarUrl` | optional | profile / AgentIcon |

### 3.2 Status unificado (UI)

| Status UI | Humano | Agente | Cor |
|-----------|--------|--------|-----|
| `available` | Ativo, WIP < 70% cap | `idle`/`active`, runs < cap | neutro |
| `busy` | WIP ≥ 70% | ≥1 run `running` | âmbar |
| `overloaded` | WIP > cap | runs > cap **ou** budget ≥ 80% | vermelho |
| `away` | Invited/pending / sem login recente | `paused` | cinza |
| `error` | — | `error` / adapter fail | vermelho forte |
| `offline` | Sem presença (se houver) | terminated hidden | oculto |

Agentes `terminated` / `pending_approval` **não** entram no roster (mesmo filtro de `Agents.tsx`).

### 3.3 Roles

| Kind | Roles Phase 1 | Onde vive hoje |
|------|---------------|----------------|
| Humano | `owner` / `admin` / `member` / `viewer` (normalizar via `company-member-roles`) | `/Users/macbook/Projects/paperclip/server/src/services/company-member-roles.ts` |
| Agente | labels `AGENT_ROLE_LABELS` (ceo, engineer, …) + `reportsTo` | Org chart / agents |

**UX:** chip de role ao lado do nome; hierarquia completa continua em `OrgChart` (link “Ver organograma”).

### 3.4 Ações por linha (menu)

| Ação | Humano | Agente | Quem pode |
|------|:------:|:------:|-----------|
| Abrir perfil | ✓ | ✓ (AgentDetail) | todos autenticados |
| Pedir trabalho… | — | ✓ | member+ |
| Assign issue existente | ✓ | ✓ (como delegate) | member+ |
| Pausar / retomar | — | ✓ | admin / Board |
| Ver routines | — | ✓ | member+ |
| Ver custos | — | ✓ | admin / Board density |
| Remover / desativar | ✓ (access) | ✓ (terminate flow) | admin |

---

## 4. Capacity lanes

### 4.1 Anatomia de uma lane

```
[@Dev]  engineer · busy
████████████░░░░  2/2 runs
Budget  $41 / $50  (82%)  ⚠
Fila: 1  ·  Última: há 4 min  ·  Routines: 2
[Pedir] [Abrir agente] [Routines]
```

### 4.2 Regras de cálculo

| Kind | Capacidade | Carga | Fonte |
|------|------------|-------|-------|
| Humano | `wipLimit` (company default 5; override por user depois) | Count issues onde `ownerUserId` = user e status ∈ open | `issues` service |
| Agente | `maxConcurrentRuns` (default 2; override em agent config) | Count heartbeat runs `running`+`queued` | heartbeats / runs |
| Agente (custo) | Budget window do agente/company | `costCents` na janela | `costs` + `budgets` |

**Overload composto (agente):** `runsOver || budgetOver` → status `overloaded`.

### 4.3 Ordenação default

1. Overloaded  
2. Busy  
3. Available  
4. Away / error  

Toggle: ordenar por nome | por custo (Board) | por WIP.

### 4.4 Filtros

- Kind: Humano | Agente | Ambos  
- Status  
- Role / reportsTo subtree (Board)  
- Projeto (issues do projeto contam na lane humana)

---

## 5. Detail drawer

### 5.1 Humano selecionado

| Bloco | Conteúdo |
|-------|----------|
| Header | Nome, role, status |
| WIP | Lista das issues owner (máx 5 + “ver todas”) |
| Delegações | Issues onde é owner e há `delegateAgentId` |
| CTA | “Criar pedido com delegate…” → fluxo doc 03 |

### 5.2 Agente selecionado

| Bloco | Conteúdo |
|-------|----------|
| Header | Nome, role label, status, adapter (Board) |
| Runs | Ativos + últimos 5 |
| Cost | Janela atual + link Costs |
| Routines | Contagem + link |
| CTA primário | **Pedir ao agente** (doc 03) |
| CTA secundário | Abrir na Room com `@` pré-preenchido |

---

## 6. Navegação e IA no produto

### 6.1 Onde mora

| Opção | Recomendação |
|-------|--------------|
| Nova rota `/company/:id/team` | **Sim** — página first-class |
| Aba dentro de Agents | Não — Agents continua “só agentes” |
| Substituir Org | Não — Org = hierarquia; Team = capacidade |

**Sidebar:** item **Team** (ícone users+bot), gated por company access; feature flag `enableHybridTeamPanel` (experimental, espelha padrão da Room).

### 6.2 Densidade Sofia vs Board

| Elemento | Sofia | Board |
|----------|-------|-------|
| Adapter / model | oculto | visível |
| agentId / runId | oculto | monospace curto |
| Budget $ | “nesta semana ≈ R$ X” | cents + tokens |
| Error stack | “Agente com problema — avise o Board” | link Activity / run log |
| Insights strip | 3 KPIs outcome/reliance | + cost burn + error rate |

Toggle global já concebido na Room (“Board density”) — **reusar** o mesmo preference store.

---

## 7. Estados vazios e erros

| Estado | UI |
|--------|-----|
| Zero agentes | Empty: “Contrate o primeiro agente” → NewAgent |
| Zero humanos além do Board | Empty parcial: convidar membros (CompanyInvites) |
| API costs falhou | Lanes sem rail de $; banner “Custo indisponível” |
| Agent error | Badge + CTA “Ver detalhes” |
| Flag off | Rota 404 / redirect Agents |

---

## 8. Acessibilidade

- Roster = `listbox` ou tabela com `aria-rowcount`; lanes = `progressbar` com `aria-valuenow`.  
- Status não só por cor — texto + ícone.  
- Drawer focável; Esc fecha.  
- Ações do menu alcançáveis por teclado.  
- Contraste WCAG AA nos estados overload.

---

## 9. Componentes sugeridos (slice)

Vertical slice ≤6 arquivos:

```
/Users/macbook/Projects/paperclip/ui/src/features/hybrid-team/
  HybridTeamPage.tsx          # page shell + filters
  RosterList.tsx              # roster rows
  CapacityLanes.tsx           # lanes
  PrincipalDetailDrawer.tsx   # drawer
  use-hybrid-roster.ts        # fetch+merge humans+agents
  hybrid-team.types.ts        # Zod types na fronteira
```

Página de rota fina:

- `/Users/macbook/Projects/paperclip/ui/src/pages/HybridTeam.tsx` → re-export do feature

---

## 10. Fluxos críticos

### F-T1 — Sofia vê sobrecarga e pede a outro agente

1. Abre Team → filtro Ambos.  
2. Vê `@Dev` overloaded.  
3. Seleciona `@QA` available → **Pedir ao agente**.  
4. Template “Revisão de PR” → cria issue owner=Sofia, delegate=`@QA` **ou** abre Room com `@QA`.

### F-T2 — Board pausa agente com erro

1. Roster mostra `@Ops` error.  
2. Drawer → Pausar.  
3. Lane some de “available”; Insights strip atualiza error count.

### F-T3 — Convidar humano e ver lane vazia

1. Empty humanos → Convidar.  
2. Após accept, lane `0/5` available.

---

## 11. Fora de escopo (Phase 1)

- Drag-and-drop rebalance.  
- Presence realtime estilo Slack (opcional depois).  
- Edição de org chart no panel.  
- Time tracking humano (horas).  
- Comparador ClickUp import.

---

## 12. Critérios de pronto (UX research)

- [ ] Um Board consegue explicar o panel em 30s a Sofia.  
- [ ] Dá para distinguir humano vs agente sem ler o kind.  
- [ ] Overload de agente por **runs** e por **budget** são ambos visíveis.  
- [ ] Nenhuma métrica dual vive só dentro da Room.  
- [ ] CTAs de pedido alinham com [03-work-request-affordances.md](./03-work-request-affordances.md).
