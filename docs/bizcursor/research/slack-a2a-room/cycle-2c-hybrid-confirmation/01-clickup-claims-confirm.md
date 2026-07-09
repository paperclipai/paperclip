# Cycle 2C — Confirmação de claims ClickUp (Path B+ hybrid)

> **Data:** 2026-07-09  
> **Fonte das claims:** `cycle-1c-hybrid-discovery/01-clickup-ai-human-sources.md` (Top 8)  
> **Método:** WebFetch das URLs PRIMARY do Help Center; quotes literais ≤40 palavras; sem quotes inventadas  
> **Confiança geral:** Alta (Help Center oficial ClickUp)

## Summary table

| # | Claim (curta) | Grade | Primary URL(s) fetched |
|---|---------------|-------|------------------------|
| 1 | Super Agents = users; @mention / DM / assign | **CONFIRMED** | privacy + triggers |
| 2 | Autopilot location/trigger vs Super adaptive cross-location | **CONFIRMED** | Autopilot + Super Agents |
| 3 | AI Hub: Schedules, Avg Cost, # of Jobs, Jobs in Progress | **CONFIRMED** | AI Hub |
| 4 | Workload = capacidade humana; sem unificar AI capacity | **CONFIRMED** | Workload + capacity limits |
| 5 | Alertas admin AI usage 80% / 90% / 100% | **CONFIRMED** | Brain AI usage |
| 6 | Build não consome créditos; run ~100–300 Super Credits | **CONFIRMED** | AI Super Credits |
| 7 | Cursor assign/@mention; não assignee tradicional; humano responsável | **CONFIRMED** | Cursor AI agents |
| 8 | Intake progressivo DM → @mention → assign → schedule/Automation; sem CTA único “Request work from AI” | **CONFIRMED** | help your team + Chat Agents |

**Score: 8/8 CONFIRMED**

---

## Claim 1

**Claim:** Super Agents são tratados como users ClickUp e podem ser acionados por `@mention`, DM e assign de task como assignee.

**Primary URLs:**
- https://help.clickup.com/hc/en-us/articles/36926065055127-Super-Agent-privacy-security-and-permissions
- https://help.clickup.com/hc/en-us/articles/37092796379927-Super-Agent-instructions-triggers-skills-knowledge-and-memory

**Fetch:** OK (ambos)

**Quote (users):**
> “Super Agents are treated as ClickUp users.”

**Quote (triggers):**
> “Mention… Direct Message… Assign task: Set the Super Agent as a task assignee to trigger it.”

**Grade:** CONFIRMED

**Implicação Path B+:** Paperclip deve modelar agentes como identidades first-class (roster/permissions), com os mesmos affordances de pedido de trabalho que humanos: mention, DM e assign — não só webhook/Automation.

---

## Claim 2

**Claim:** Autopilot Agents são location-scoped e trigger/condition-driven; Super Agents são teammates adaptativos cross-Workspace com interação human-like.

**Primary URLs:**
- https://help.clickup.com/hc/en-us/articles/37045015737111-What-are-Autopilot-Agents
- https://help.clickup.com/hc/en-us/articles/31010910371991-What-are-Super-Agents

**Fetch:** OK (ambos)

**Quote (Autopilot):**
> “Autopilot Agents run in specific locations… Only take action when triggered by specific events, and only if the specified conditions are met.”

**Quote (Super vs Autopilot):**
> “Autopilot Agents perform actions based on defined triggers and conditions, rather than adaptive, human-like interactions.”

**Quote (cross-location):**
> “If you need an Agent to do intelligent work across locations with more flexibility, try building a Super Agent!”

**Grade:** CONFIRMED

**Implicação Path B+:** Separar dois modos de agente: (A) Autopilot-like = scoped a room/list + regras; (B) Super-like = teammate adaptativo cross-surface. Path B+ deve priorizar (B) na room Slack/A2A, sem colapsar tudo em Automations.

---

## Claim 3

**Claim:** O AI Hub lista o roster de Super Agents com colunas Schedules, Avg Cost (USD), # of Jobs e Jobs in Progress.

**Primary URL:**
- https://help.clickup.com/hc/en-us/articles/36954958035863-AI-Hub

**Fetch:** OK

**Quote:**
> “Schedules… Avg Cost… shown in USD… # of Jobs… Jobs in Progress… number of currently active jobs.”

**Grade:** CONFIRMED

**Implicação Path B+:** Hybrid Team Panel / AI Hub equivalente precisa de roster com schedules, custo médio, contagem de jobs e jobs ativos — métricas de operação do agente, não só status online/offline.

---

## Claim 4

**Claim:** Workload view modela capacidade **humana** (assignee + limits); a documentação oficial não unifica capacity de agentes de IA na mesma vista.

**Primary URLs:**
- https://help.clickup.com/hc/en-us/articles/6310449699735-Use-Workload-view
- https://help.clickup.com/hc/en-us/articles/30799771936279-Set-capacity-limits-in-Workload-view

**Fetch:** OK (ambos; Workload view OK no segundo fetch após timeout inicial)

**Quote (humano / assignee):**
> “Set limits for each person… You can only set capacity limits when grouping by assignee.”

**Quote (Workload framing):**
> “Visualize your team's work and capacity over time… each person's capacity is displayed in shades of red, yellow, or green.”

**Nota de ausência:** Nenhum dos dois artigos PRIMARY menciona Super Agents, Autopilot Agents ou AI capacity na Workload view.

**Grade:** CONFIRMED

**Implicação Path B+:** Dual performance é gap real — capacity humana (Workload) e custo/jobs de IA (AI Hub) ficam em superfícies separadas. Paperclip Path B+ deve planejar unificação explícita (painel híbrido), não assumir que o modelo ClickUp já resolve.

---

## Claim 5

**Claim:** Admins recebem alertas de uso de AI Super Credits em 80%, 90% e 100% do limite mensal.

**Primary URL:**
- https://help.clickup.com/hc/en-us/articles/34741383911959-Track-your-Workspace-s-Brain-AI-usage

**Fetch:** OK

**Quote:**
> “Admins are notified via a banner and in the Agents and Automations menus… when your Workspace is at 80%, 90%, and 100% of your AI usage.”

**Grade:** CONFIRMED

**Implicação Path B+:** Governance de custo precisa de thresholds escalonados (80/90/100) com notificação a admins — padrão de produto a espelhar em alertas de créditos/tokens Paperclip.

---

## Claim 6

**Claim:** Construir um Super Agent não consome créditos; execução de jobs/ações consome AI Super Credits (faixa tipicamente 100–300 por uso de Agent).

**Primary URL:**
- https://help.clickup.com/hc/en-us/articles/37837088720151-ClickUp-AI-add-on-availability-and-limits

**Fetch:** OK

**Quote (build vs run):**
> “Building a Super Agent does not consume credits. When the Super Agent performs the actions specified in its prompt, those actions consume credits.”

**Quote (faixa):**
> “1 use of Autopilot Agents or Super Agents | 100–300”

**Grade:** CONFIRMED

**Implicação Path B+:** Billing/metering deve cobrar execução (jobs), não criação de perfil de agente; faixa 100–300 por run é referência de ordem de grandeza para UX de custo por hop.

---

## Claim 7

**Claim:** Cursor agents no ClickUp podem ser assigned/@mentioned, mas **não** são assignees tradicionais e um humano permanece responsável pela conclusão.

**Primary URL:**
- https://help.clickup.com/hc/en-us/articles/37621387938711-Use-Cursor-AI-agents

**Fetch:** OK

**Quote:**
> “Cursor agents are not traditional assignees. Assigning a task to a Cursor agent triggers the agent to act on it, but a human teammate remains responsible for its completion.”

**Grade:** CONFIRMED

**Implicação Path B+:** Accountability híbrida obrigatória: assign/mention a agente externo dispara trabalho, mas ownership humano permanece. Modelo de task Paperclip deve distinguir `assignee_agent` (executor) vs `responsible_human` (accountable).

---

## Claim 8

**Claim:** O caminho oficial para humanos pedirem trabalho à IA é progressivo: DM → @mention em task/Doc/Chat → assign ownership → schedule ou Automation — sem um único CTA “Request work from AI” documentado.

**Primary URLs:**
- https://help.clickup.com/hc/en-us/articles/36487554975255-How-can-Super-Agents-help-your-team
- https://help.clickup.com/hc/en-us/articles/37131966192151-Use-ClickUp-Agents-in-Chat
- https://help.clickup.com/hc/en-us/articles/37092796379927-Super-Agent-instructions-triggers-skills-knowledge-and-memory

**Fetch:** OK (todos)

**Quote (sequência progressiva):**
> “Start by having conversations with Super Agents in Direct Messages (DMs). Then @mention your Super Agents on tasks, Docs, and Chat… start assigning tasks… schedule or using Automations.”

**Quote (Chat surfaces):**
> “@mention the Super Agent in any Chat message… Send a direct message to the Super Agent to trigger it.”

**Nota de ausência:** Os artigos PRIMARY de intake (help your team, Chat Agents, triggers) documentam DM / @mention / assign / schedule / Automation; nenhum documenta um botão ou CTA único intitulado “Request work from AI”.

**Grade:** CONFIRMED

**Implicação Path B+:** Work-request affordances devem ser a stack progressiva (DM → mention → assign → schedule/Automation), não um único botão mágico. Um CTA “Ask agent” pode ser diferencial Paperclip, mas não é o padrão documentado do ClickUp.

---

## Metadados

| Item | Valor |
|------|-------|
| Agente | Cycle 2 Confirmation #1 (Path B+ hybrid) |
| Ferramenta | WebFetch |
| Quotes inventadas | 0 |
| Fetches falhos | 1 timeout inicial em Workload view; re-fetch OK |
| REFUTED | 0 |
| PARTIAL | 0 |
| UNKNOWN | 0 |
| **Score** | **8/8 CONFIRMED** |
