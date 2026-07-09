# UX Design — Hybrid Team Panel (Path B+)

> **Ciclo:** 3C — Hybrid deep dive (agent #1)  
> **Data:** 2026-07-09  
> **Âncora:** somente claims **CONFIRMED** do Cycle 2C  
> **Supersede:** [`cycle-3b-clickup-deep-dive/02-hybrid-team-panel.md`](../cycle-3b-clickup-deep-dive/02-hybrid-team-panel.md) — estrutura útil, mas métricas/campos alinhados a 1C/2C  
> **Decisões LOCKED:** D-09 (Path B+), D-11 (performance fora do stream), D-12 (assign-as-delegate), **D-13 (roster+workload unificados)**  
> **Requisito promovido:** **R-03** — Unificar roster AI Hub-like + Workload-like (gap ClickUp)  
> **Implementação alvo (fork):** `/Users/macbook/Projects/paperclip/ui/src/features/hybrid-team/`  
> **Persona primária:** Sofia (Operator) · densidade secundária: Board (admin)

---

## 0. Por que este doc existe

Cycle 2C **confirmou** (Help Center ClickUp, 2026-07-09) que:

1. **AI Hub** lista Super Agents com colunas Schedules, Avg Cost (USD), # of Jobs, Jobs in Progress — **CONFIRMED** (Claim 3 / C2-D4-01).  
2. **Workload** modela capacidade **humana** (assignee + limits, green/yellow/red) e **não** unifica capacity de agentes de IA na mesma vista — **CONFIRMED** (Claim 4 / C2-D4-01).  
3. O gap de unificação é o diferencial Path B+: Paperclip vende **um** painel híbrido, não réplica de Workload-só-humano nem AI Hub-só-IA.

**R-03** (promovido no INDEX 2C) e **D-13** (LOCKED) travam o produto: *roster + workload unificados*.

**Não inventar:** este doc **não** afirma features ClickUp não confirmadas (ex.: drag-and-drop de capacity AI no Workload, CTA único “Request work from AI”, presence Slack-like no AI Hub). Onde ClickUp documenta ausência ou silêncio, tratamos como **gap** — oportunidade Paperclip.

---

## 1. Job-to-be-done

> “Ver **quem** (humano ou agente) está no time, **o que** cada um carrega, **custo/jobs** dos agentes, **carga** dos humanos, e **agir** (convidar, adicionar, pausar, rebalancear) sem abrir o stream da Room.”

| É | Não é |
|---|--------|
| Workforce canvas híbrido (R-03 / D-13) | Org Chart (hierarquia) |
| Gestão de capacidade + status | BoardChat / Room stream (D-11: métricas fora do stream) |
| Superfície de membership + ações Sofia | HRIS / payroll / time-tracking de horas |

---

## 2. Information architecture — aba Team

### 2.1 Posição no produto

| Decisão | Valor | Motivo 2C |
|---------|-------|-----------|
| Rota first-class | `/company/:id/team` | Unificar o que ClickUp separa (AI Hub ≠ Workload) |
| Sidebar | Item **Team** (ícone users+bot) | Distinto de Agents (só IA) e Company Access (só humanos) |
| Feature flag | `enableHybridTeamPanelV1` | Rollout experimental |
| Stream da Room | **Ausente** nesta página | D-11 LOCKED — performance/ops fora do stream |
| Link de escape | “Abrir sala” no header | Mentions/A2A continuam na Room (R-07) |

### 2.2 Layout canônico (duas zonas + drawer)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Team · Acme Co                    [Humano|Agente|Ambos] 🔍  [+ Convidar] [+ Agente]
│ Hybrid Cycle Time 2.1d · Co-touch 41%          (Insights strip — D-11 / P0 Room)
├──────────────────┬──────────────────────────────────────────────────────────┤
│ ROSTER           │ CAPACITY LANES                                           │
│ (lista unificada)│ (Workload-like humanos + AI Hub-like agentes)            │
│                  │                                                          │
│ ○ Sofia · owner  │ Sofia     ████████░░  4/5 WIP · CT p50 1.8d              │
│ ○ João · member  │ João      ██████░░░░  3/5                                │
│ ───────────────  │ ───────────────────────────────────────────────────────  │
│ ◉ @CEO · ceo     │ @CEO      ████░░░░░░  1/2 jobs · avg $12 · interv 0      │
│ ◉ @Dev · eng     │ @Dev      ██████████  2/2 jobs · avg $41 ⚠ · interv 2    │
│ ◉ @QA · qa       │ @QA       ██░░░░░░░░  0/2 jobs · avg $3                  │
│                  │                                                          │
├──────────────────┴──────────────────────────────────────────────────────────┤
│ DETAIL DRAWER (seleção)                                                     │
│ status · métricas P0 da lane · CTAs Sofia                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Zonas e responsabilidades

| Zona | Conteúdo | Fonte 2C |
|------|----------|----------|
| **Roster** | Lista unificada `human \| agent` com status + role | R-03; Claim 1 (agentes = identidades first-class) |
| **Capacity lanes** | Barras de carga por principal | Claim 4 (humano) + Claim 3 (agente) no **mesmo** canvas |
| **Insights strip** | 2–4 KPIs Room (Hybrid Cycle Time, Co-touch) | P0 Room; D-11 |
| **Detail drawer** | Card do selecionado + ações | Linear D-12 (owner humano + delegate) |

**Regra de ouro:** uma seleção no roster **sincroniza** a lane destacada e abre o drawer. Não há terceira navegação.

### 2.4 Filtros (toolbar)

| Filtro | Valores | Default |
|--------|---------|---------|
| Kind | Humano · Agente · Ambos | Ambos |
| Status | available · busy · overloaded · away · error | Todos |
| Busca | `displayName` / role label | — |
| Ordenação | Overload-first · Nome · WIP · Custo (Board) | Overload-first |

---

## 3. Human row vs Agent row

### 3.1 Modelo de linha (campos comuns)

| Campo | Tipo | Notas |
|-------|------|-------|
| `principalId` | `user:<id>` \| `agent:<id>` | Discriminador estável |
| `displayName` | string | Nome amigável Sofia |
| `kind` | `human` \| `agent` | Ícone distinto (não só cor) |
| `roleLabel` | string | owner/admin/member/viewer **ou** label de papel do agente |
| `status` | enum unificado (§3.3) | Texto + ícone + cor |
| `avatarUrl` | optional | Fallback iniciais |

### 3.2 Colunas / métricas por kind (somente P0 CONFIRMED)

| Célula | **Human row** | **Agent row** | Claim 2C |
|--------|---------------|---------------|----------|
| Capacidade | Capacity load (WIP vs limit) — green/yellow/red | Jobs in Progress vs `maxConcurrentRuns` | C2-D4-01 Claim 4 / Claim 3 |
| Flow | Cycle Time p50 (start→complete) | — (não misturar) | C2-D4-02 |
| Custo | — (não P0 humano) | Avg Cost / job (USD) | Claim 3 / C2-D4-01 |
| Volume | Contagem WIP aberta | # Jobs (janela) opcional Board; Jobs in Progress P0 | Claim 3 |
| HITL | — | Intervention count | C2-D4-05 |
| Schedules | — | Contagem / link routines (AI Hub-like) | Claim 3 “Schedules” |

**OUT do row P2.5 (PARTIAL / anti-métrica 2C):** TTFT, latency p95, raw tokens, ROAS, “# agents” vanity, Collab Score / Initiative Entropy como KPI de UI.

### 3.3 Status unificado (UI)

| Status UI | Humano | Agente | Sinal visual |
|-----------|--------|--------|--------------|
| `available` | Ativo, load < 70% | idle/active, jobs < cap | neutro |
| `busy` | load ≥ 70% | ≥1 job in progress | âmbar |
| `overloaded` | WIP > capacity limit | jobs > cap **ou** budget ≥ 80%* | vermelho |
| `away` | invite pending / sem atividade recente | `paused` | cinza |
| `error` | — | adapter/run fail | vermelho forte + texto |

\* Threshold 80% espelha alerta admin ClickUp Brain AI usage (Claim 5 CONFIRMED) — **governance de custo**, não inventar coluna Workload AI.

Agentes `terminated` / `pending_approval` **fora** do roster (mesmo filtro mental de Agents).

### 3.4 Anatomia visual — Human lane

```
[avatar] Sofia · owner · available
████████░░  Capacity 4/5
Cycle Time p50 · 1.8d
[Abrir perfil] [Criar pedido…]
```

### 3.5 Anatomia visual — Agent lane

```
[bot] @Dev · engineer · overloaded
██████████  Jobs in Progress 2/2
Avg Cost / job · $41   Interventions · 2
Schedules · 2 routines
[Pedir ao agente] [Pausar] [Abrir Room @Dev]
```

### 3.6 Accountability (D-12 / Linear CONFIRMED)

Na UI do painel:

- Humano permanece **owner / assignee accountable**.  
- Agente aparece como **delegate / executor** (não “assignee tradicional”).  
- Claim ClickUp Cursor (Claim 7): humano responsável pela conclusão — alinhar copy: “Delegado a @Dev · Owner Sofia”.

**Anti-padrão Plane** (CONFIRMED como contraste): não tratar agente como assignee “same as teammate” para accountability.

---

## 4. Fluxos Sofia (Operator)

### 4.1 F-T1 — Convidar humano

```
Sofia → Team → [+ Convidar]
  → modal CompanyInvites (reuso)
  → pending aparece no roster como away / “Convite pendente”
  → após accept: lane Capacity 0/N · available
```

| Passo | UI | A11y |
|-------|-----|------|
| Abrir | Botão toolbar “Convidar humano” | `aria-haspopup="dialog"` |
| Sucesso | Toast + foco no novo row | `aria-live="polite"` |
| Empty state | “Convide o primeiro colega” se só Board | CTA único no empty |

### 4.2 F-T2 — Adicionar agente

```
Sofia/Board → Team → [+ Agente]
  → NewAgent (reuso) OU deep-link Agents
  → agente idle entra no roster + lane 0/cap
  → build ≠ cobrança (Claim 6: criar não consome créditos; run consome)
```

Copy Sofia: “Criar agente não gasta créditos; cada job consome orçamento.”

### 4.3 F-T3 — Pausar agente

```
Roster mostra @Ops · error  OU  Sofia decide pausar overloaded
  → seleciona row → drawer → [Pausar]
  → status → away (paused)
  → Jobs in Progress param de aceitar novos
  → Insights strip atualiza (se intervention/error)
```

| Quem pode | Sofia (member+) | Board |
|-----------|-----------------|-------|
| Pausar / retomar | se policy company permitir | sempre |
| Ver adapter / runId | oculto | densidade Board |

### 4.4 F-T4 — Rebalance (sem DnD mágico)

ClickUp **não** confirmou unificação Workload+AI nem rebalance drag de agentes. Paperclip P2.5 oferece rebalance **explícito**:

```
Sofia vê @Dev overloaded (2/2 · $41)
  → seleciona @QA available
  → [Pedir ao agente] / [Criar pedido com delegate @QA]
  → owner = Sofia (D-12); delegate = @QA
  → opcional: Abrir Room com @QA pré-preenchido (R-05 anyone-can-@)
```

**Não** incluir em P2.5: drag-and-drop entre lanes, auto-scheduler ML, presence realtime estilo Slack.

### 4.5 F-T5 — Pedido progressivo (Claim 8)

ClickUp documenta intake **progressivo** (DM → @mention → assign → schedule/Automation) **sem** CTA único “Request work from AI”.

No Team Panel, o CTA “Pedir ao agente” é **diferencial Paperclip** (atalho), mas deve abrir o mesmo stack:

1. Prefill Ask / issue com delegate  
2. Ou deep-link Room com `@agent`  
3. Assign-as-delegate (não transferir ownership)

---

## 5. Acessibilidade — teclado e leitor de tela

### 5.1 Roster como estrutura semântica

| Padrão | Implementação |
|--------|----------------|
| Container | `role="listbox"` **ou** tabela `role="grid"` com `aria-rowcount` |
| Row | `role="option"` / `role="row"`; `aria-selected` |
| Kind | `aria-label` inclui “humano” ou “agente” (não só ícone) |
| Status | texto visível + `aria-label` (“sobrecarregado”); nunca cor sozinha |
| Lane progress | `role="progressbar"` + `aria-valuenow/min/max` + `aria-valuetext="4 de 5"` |

### 5.2 Teclado

| Tecla | Ação |
|-------|------|
| `Tab` | Toolbar → roster → lanes focáveis → drawer |
| `↑` / `↓` | Navegar rows do roster (roving tabindex) |
| `Enter` / `Space` | Selecionar row + abrir drawer |
| `Esc` | Fechar drawer; foco volta ao row |
| `Context menu` / `Shift+F10` | Menu de ações da linha |

### 5.3 Live regions

- Mudança de status (pause, overload): `aria-live="polite"`.  
- Erro de API de custos: banner `role="alert"`.  
- Toast de convite: polite.

### 5.4 Contraste e densidade

- Estados overload / error: WCAG AA (texto + ícone).  
- Densidade Sofia: esconder IDs técnicos; Board: monospace curto opcional.  
- Foco visível 2px no row selecionado.

### 5.5 Mentions / steer (R-05)

Anyone-can-@ / steer é da **Room** (Claude Tag CONFIRMED). No Team Panel, o deep-link “Abrir Room @Agent” deve preservar o contexto de menção — não exigir re-auth especial no painel.

---

## 6. Wireframe ASCII + lista de componentes Paperclip

### 6.1 Wireframe — viewport desktop

```
+===========================================================================+
| ≡  Paperclip          Acme Co ▾          [Board density]  Sofia ▾         |
+---------------------------------------------------------------------------+
| Nav: Home | Room | *Team* | Agents | Costs | Org | Settings               |
+---------------------------------------------------------------------------+
| TEAM                                                                      |
| [Filtro: Ambos ▾] [Status ▾] [Buscar…]     [Convidar humano] [+ Agente]  |
| Strip: Hybrid CT 2.1d · Co-touch 41% · Overload 1                         |
+---------------------+-----------------------------------------------------+
| ROSTER              | LANES                                               |
| > Sofia  available  | Sofia  [====----] 4/5  CT 1.8d                      |
|   João   busy       | João   [===-----] 3/5                               |
|  ----------------   | -------------------------------------------------   |
|   @CEO   available  | @CEO   [==------] 1/2  $12  i0                      |
|   @Dev   OVERLOAD   | @Dev   [========] 2/2  $41  i2  !                   |
|   @QA    available  | @QA    [=-------] 0/2  $3   i0                      |
+---------------------+-----------------------------------------------------+
| DRAWER @Dev                                                         [x]   |
| engineer · overloaded · Jobs 2/2 · Avg $41 · Interventions 2              |
| [Pedir ao agente] [Pausar] [Routines] [Custos] [Abrir Room @Dev]          |
+===========================================================================+
```

### 6.2 Wireframe — mobile (stack)

```
[ Team ]
Filtros · Convidar · +Agente
────────
Sofia  4/5  available
João   3/5  busy
@CEO   1/2  $12
@Dev   2/2  $41  !   ← tap → bottom sheet
@QA    0/2  $3
```

Lanes colapsam **dentro** do row (não duas colunas). Drawer vira bottom sheet.

### 6.3 Componentes (vertical slice ≤6 arquivos)

```
/Users/macbook/Projects/paperclip/ui/src/features/hybrid-team/
  HybridTeamPage.tsx           # shell, toolbar, insights strip, empty states
  RosterList.tsx               # listbox/grid + HumanRow/AgentRow
  CapacityLanes.tsx            # progressbars + métricas P0 por kind
  PrincipalDetailDrawer.tsx    # drawer/sheet + CTAs Sofia
  use-hybrid-roster.ts         # merge members + agents + WIP + costs summary
  hybrid-team.types.ts         # Zod na fronteira UI↔API
```

Rota fina: `pages/HybridTeam.tsx` → re-export do feature.

### 6.4 Reuso (não reinventar)

| Capacidade | Origem no fork |
|------------|----------------|
| Lista agentes | `Agents.tsx` / AgentDetail |
| Convites | CompanyInvites / CompanyAccess |
| New agent | `NewAgent.tsx` |
| Runs ativas | ActiveAgentsPanel (dados, não UI) |
| Custos | Costs summary read-only |
| Ask / pedido | P1.5 work-request affordances |
| Org | link “Ver organograma” — não embutir |

---

## 7. MoSCoW — escopo P2.5

### Must (P2.5)

| ID | Item | Âncora 2C |
|----|------|-----------|
| M1 | Aba/página Team com roster unificado human+agent | R-03, D-13 |
| M2 | Capacity lanes humanas (WIP vs limit, G/Y/R) | Claim 4 |
| M3 | Lanes agentes: Jobs in Progress + Avg Cost / job | Claim 3, C2-D4-01 |
| M4 | Status unificado + filtros kind/status | R-03 |
| M5 | Drawer com Pausar agente + Pedir ao agente | Claim 1 affordances; F-T3/T4 |
| M6 | Convidar humano + adicionar agente (reuso) | membership gap Agents≠Access |
| M7 | Owner humano + delegate agente na copy/ações | D-12, Linear Claim 1–2 |
| M8 | Métricas densas **fora** do stream da Room | D-11 |
| M9 | A11y: teclado roster + progressbar + status textual | R-05 espírito acessível |

### Should

| ID | Item | Nota |
|----|------|------|
| S1 | Intervention count na lane/drawer agente | P0-Ag-3 CONFIRMED |
| S2 | Insights strip Room (Hybrid CT + Co-touch) | P0 Room; pode ser stub se telemetria incompleta |
| S3 | Schedules / link Routines (AI Hub-like) | Claim 3 |
| S4 | Densidade Board (adapter, ids curtos, $ cents) | Sofia vs Board |
| S5 | Alertas 80/90/100% budget (banner admin) | Claim 5 |

### Could

| ID | Item | Nota |
|----|------|------|
| C1 | Cycle Time p50 na lane humana | P0-Hu-1; depende de telemetria issues |
| C2 | Ordenar por custo (Board) | nice-to-have |
| C3 | Filtro por projeto (WIP humano scoped) | |
| C4 | CTA “Pedir” como diferencial (Claim 8 diz ClickUp não tem CTA único) | |

### Won’t (P2.5)

| ID | Item | Motivo |
|----|------|--------|
| W1 | Unificar inventando feature ClickUp inexistente | Claim 4 = gap; não fingir paridade |
| W2 | Drag-and-drop rebalance | não confirmado; F-T4 explícito basta |
| W3 | Dual performance charts densos | P4.5 |
| W4 | TTFT / latency / ROAS / #agents vanity | OUT 2C PARTIAL |
| W5 | Editar Org Chart no panel | Org permanece separado |
| W6 | Presence realtime Slack-like | não confirmado no AI Hub |
| W7 | Time tracking horas humanas | fora Path B+ P2.5 |
| W8 | Plane-style agent-as-assignee accountability | anti-padrão D-12 |

---

## 8. Citações de grade Cycle 2C (R-03, D-13)

### 8.1 R-03 — requisito promovido

Fonte: [`cycle-2c-hybrid-confirmation/00-INDEX.md`](../cycle-2c-hybrid-confirmation/00-INDEX.md)

| Campo | Valor |
|-------|-------|
| **ID** | R-03 |
| **Texto** | Unificar roster AI Hub-like + Workload-like (gap ClickUp) |
| **Fonte** | ClickUp + D-13 |
| **Status** | PROMOTED (CONFIRMED only) |

Evidência de suporte:

- Claim 3 **CONFIRMED** — AI Hub: Schedules, Avg Cost, # of Jobs, Jobs in Progress.  
- Claim 4 **CONFIRMED** — Workload = capacidade humana; docs oficiais **não** unificam AI capacity.  
- C2-D4-01 **CONFIRMED** — gap AI Hub ≠ Workload no mesmo view.  
- Verticals C5 **CONFIRMED** — “Paperclip vende roster/workload híbrido”.

### 8.2 D-13 — decisão travada

Fonte: mesmo INDEX 2C, seção “Decisões travadas para Cycle 3/4”

| Campo | Valor |
|-------|-------|
| **ID** | D-13 |
| **Texto** | roster+workload unificados |
| **Status** | **LOCKED** |

Implicação de design: **uma** superfície Team; duas *lanes semânticas* (human vs agent) dentro dela — não duas páginas espelhando ClickUp.

### 8.3 Grades relacionadas (contexto, não inventar)

| ID | Grade | Uso neste doc |
|----|-------|---------------|
| ClickUp Claim 3 | CONFIRMED | Colunas agente |
| ClickUp Claim 4 | CONFIRMED | Lanes humanas + gap |
| ClickUp Claim 5 | CONFIRMED | Thresholds 80/90/100 Should |
| ClickUp Claim 6 | CONFIRMED | Copy build vs run |
| ClickUp Claim 7 | CONFIRMED | Humano responsável |
| ClickUp Claim 8 | CONFIRMED | Intake progressivo; CTA único = diferencial |
| C2-D4-01 | CONFIRMED | Dual panel obrigatório |
| Linear Claim 1–2 | CONFIRMED | Owner + delegate (D-12) |
| D-09 / D-11 / D-12 | LOCKED | Path B+, métricas fora stream, assign-as-delegate |

---

## 9. Estados vazios e erro

| Estado | UI Sofia |
|--------|----------|
| Zero agentes | “Adicione o primeiro agente” → NewAgent |
| Zero humanos (além do Board) | “Convide colegas” → Convidar |
| Costs API down | Lanes sem rail $; banner “Custo indisponível” |
| Agent error | Badge error + Pausar / Ver detalhes |
| Flag off | 404 / redirect Agents |
| Só overloaded | Ordenação default já destaca; empty de “available” com hint rebalance |

---

## 10. Critérios de pronto (UX research → P2.5)

- [ ] Board explica o panel a Sofia em ≤30s (“humanos à esquerda/cima, agentes abaixo, mesma página”).  
- [ ] Dá para distinguir human vs agent **sem** ler a palavra kind (ícone + aria).  
- [ ] Overload de agente por **Jobs in Progress** e sinal de **custo** são ambos visíveis.  
- [ ] Capacity humana G/Y/R visível sem abrir Costs.  
- [ ] Nenhuma métrica P0 vive **só** dentro do stream da Room (D-11).  
- [ ] CTAs respeitam owner humano + delegate (D-12); não Plane-assignee.  
- [ ] Teclado percorre roster completo; Esc fecha drawer.  
- [ ] MoSCoW Must M1–M9 implementáveis sem claims não confirmadas.

---

## 11. Relação com docs vizinhos

| Doc | Relação |
|-----|---------|
| 3B `02-hybrid-team-panel.md` | Antecessor; este 3C **supersede** com grades 2C explícitas |
| 2C `01-clickup-claims-confirm.md` | Claims 3–4–5–6–7–8 |
| 2C `04-dual-performance-confirm.md` | P0 metric set |
| 2C `00-INDEX.md` | R-03, D-13 |
| P2.5 SPEC (5B) | Contrato de implementação; este doc é UX research |

---

## 12. Metadados de entrega

| Campo | Valor |
|-------|-------|
| **Path** | `docs/research/slack-a2a-room/cycle-3c-hybrid-deep-dive/01-hybrid-team-panel-ux.md` |
| **Agente** | Cycle 3 Deep Dive #1 (Path B+) |
| **Idioma** | PT-BR |
| **Inventou feature ClickUp?** | Não — só gap CONFIRMED + diferencial Paperclip rotulado |
| **Próximo** | Wire → P2.5 SPEC refresh se MoSCoW divergir; Cycle 4 plan consome R-03/D-13 |
