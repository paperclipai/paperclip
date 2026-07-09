# D5 — Verticais Path B+ (confirmação)

> **Ciclo:** 2C — Confirmation (hybrid beachhead)  
> **Agente:** #5 — Verticals / hybrid ops panel  
> **Data:** 2026-07-09  
> **Fonte discovery:** [`cycle-1c-hybrid-discovery/05-verticals-hybrid-panel-sources.md`](../cycle-1c-hybrid-discovery/05-verticals-hybrid-panel-sources.md)  
> **Método:** WebFetch / DOI / arXiv / product docs oficiais (primárias)  
> **NotebookLM:** skip (trivial) — confirmação de fontes de mercado, sem overlap Villa.

---

## 1. Resumo executivo

**Veredito Cycle 2C:** hipóteses de beachhead do Cycle 1C **CONFIRMADAS**.

| Hipótese | Grade | Lock Cycle 4 |
|----------|-------|--------------|
| Software Houses = STRONG beachhead (painel híbrido) | **CONFIRMED** | **Beachhead** |
| Support = secundário (não beachhead) | **CONFIRMED** | **Secondary** |
| Marketing = FLUFF / non-goal | **CONFIRMED** | **Non-goal** |
| Anti-hype: sem “80% autonomia” / ROAS mágico | **CONFIRMED** | **Non-goal / messaging lock** |

Evidência causal de SE (lab + campo), UX de pedido fácil (Linear/Claude Tag/ClickUp), gap AI Hub ≠ Workload, e anti-hype (METR + SWE-Bench Pro + Gartner) fecham o lock para o plano Cycle 4.

---

## 2. Matriz de claims

| # | Claim (Cycle 1C) | Grade | Confiança | Notas |
|---|------------------|-------|-----------|-------|
| C1 | Software Houses / product-eng = **STRONG** beachhead para painel híbrido | **CONFIRMED** | Alta | RCTs + UX nativa + gap de roster |
| C2 | Support Ops = **secundário** (não displace CX suite) | **CONFIRMED** | Alta | Causal forte, GTM bloqueado por Zendesk |
| C3 | Marketing / Content = **FLUFF** / non-goal beachhead | **CONFIRMED** | Alta | Templates ≠ outcome; Gartner agent washing |
| C4 | Anti-hype: proibir “80% autonomia” / ROAS mágico no pitch | **CONFIRMED** | Alta | METR −19%; SWE-Bench Pro ~23%; Gartner cancelamentos |
| C5 | Gap ClickUp: AI Hub (só AI) ≠ Workload (só humano) | **CONFIRMED** | Alta | Docs oficiais 2026-07-09 |
| C6 | Linear: delegate ≠ assignee; humano permanece responsável | **CONFIRMED** | Alta | Docs oficiais |
| C7 | Claude Tag 65% PRs = prova de UX, **não** RCT | **PARTIAL** | Média | Claim interno Anthropic; UX multiplayer confirmada |
| C8 | Peng +55,8% lab Copilot | **CONFIRMED** | Alta | arXiv:2302.06590 |
| C9 | Demirer et al. +26,08% tasks (n=4.867) | **CONFIRMED** | Alta | Management Science DOI |
| C10 | Brynjolfsson +14% issues/hora (support) | **CONFIRMED** | Alta | NBER w31161 (abstract/non-tech summary) |
| C11 | Zendesk Resolution Platform = suite híbrida CX incumbente | **CONFIRMED** | Alta | Product blog Relate 2025/2026 |
| C12 | SWE-Bench Pro frontier ~23% public set | **CONFIRMED** | Alta | Scale blog + arXiv HTML (GPT-5 23.3%) |

---

## 3. Evidências primárias (quotes)

### 3.1 Software Houses — beachhead STRONG → CONFIRMED

**C8 — Peng et al. (lab RCT)**  
Fonte: https://arxiv.org/abs/2302.06590 (fetched 2026-07-09)

> “the treated group completed the task 55.8% faster than the control group.”

**C9 — Demirer / Peng / Salz et al. (field RCTs)**  
Fonte: https://doi.org/10.1287/mnsc.2025.00535 (Management Science; fetched 2026-07-09)

> “when data are combined across three experiments and 4,867 developers, our analysis reveals a 26.08% increase (standard error: 10.3%) in completed tasks among developers using the AI tool.”

**C6 — Linear Agents (pedido fácil + ownership)**  
Fonte: https://linear.app/docs/agents-in-linear (fetched 2026-07-09)

> “Agents are not traditional assignees. Assigning an issue to an agent triggers delegation—the agent acts on the issue, but the human teammate remains responsible for its completion.”

Fonte: https://linear.app/docs/assigning-issues (fetched 2026-07-09)

> “Delegate an issue to an agent while keeping a human teammate as the assignee. The assignee remains responsible for the work, while the agent contributes on their behalf.”  
> “Insights surface trends in how work is distributed across assigned teammates and agents… report on issues by assignee or by the agent they’ve been delegated to.”

**ClickUp Super Agents — use case Software development**  
Fonte: https://help.clickup.com/hc/en-us/articles/36487554975255-How-can-Super-Agents-help-your-team (fetched 2026-07-09)

> Tabela use case **Software development**: “Bug triage agent… Release notes writer…”  
> Triggers: “@mention… assigning tasks… schedule or using Automations.”

**Claude Tag — UX Slack multiplayer (não RCT)**  
Fonte: https://www.anthropic.com/news/introducing-claude-tag (2026-06-23; fetched 2026-07-09)

> “Anyone in the channel can tag @Claude in, and delegate tasks…”  
> “@Claude is multiplayer… much more like interacting collaboratively with a teammate.”  
> “Today, 65% of our product team’s code is created by our internal version of Claude Tag.” ← **PARTIAL**: claim interno; usar só como prova de UX.

**C5 — Gap AI Hub ≠ Workload**  
Fonte AI Hub: https://help.clickup.com/hc/en-us/articles/36954958035863-AI-Hub (fetched 2026-07-09)

> AI Hub = “create and manage Super Agents”; colunas Status / Schedules / Avg Cost / # of Jobs / Jobs in Progress; “Monthly usage” no sidebar — **roster só de agentes**.

Fonte Workload: https://help.clickup.com/hc/en-us/articles/30799771936279-Set-capacity-limits-in-Workload-view (fetched 2026-07-09)

> “Set limits for each person… You can only set capacity limits when grouping by assignee.” — **capacity humana**, sem unificar lanes AI.

→ Gap Path B+ **CONFIRMADO**: Paperclip vende roster/workload **híbrido**, não réplica de Workload humano.

---

### 3.2 Support — secundário → CONFIRMED

**C10 — Brynjolfsson, Li, Raymond**  
Fonte: https://www.nber.org/papers/w31161 (fetched 2026-07-09; PDF 503 no fetch — abstract/non-tech summary OK)

> Non-tech summary: “Customer support agents using an AI tool… saw a nearly 14 percent increase in productivity…”

**C11 — Zendesk Resolution Platform (incumbente)**  
Fonte: https://www.zendesk.com/blog/zendesk-insights/innovation/relate-2025-resolution-platform-ai-agents/ (updated 2026-07-05; fetched 2026-07-09)

> “unifies AI agents, copilots, knowledge, workflows, integrations, governance, and insights”  
> “Workforce Management… Quality assurance… AI agents… Copilot” no mesmo produto.

**Implicação GTM:** causal de support existe, mas o **painel híbrido CX já é vendido pela suite**. Paperclip como beachhead displace Zendesk = **REFUTADO** como estratégia P1. Support permanece **secondary expansion** (sala `#support-ops` / triage interno), não beachhead.

**Nota anti-hype (mesmo artigo Zendesk):**

> “organizations can move closer to resolving up to 80% of customer interactions autonomously” + case TeamSystem.

→ Este “80%” é **claim de vendor CX**, não evidência para pitch Paperclip eng. Reforça C4: **não copiar** narrativa de autonomia 80% no beachhead SH.

---

### 3.3 Marketing = FLUFF → CONFIRMED

**ClickUp lista Marketing como template, não outcome**  
Fonte Super Agents help (acima):

> Use case **Marketing**: “Campaign builder… Copy writer: Generates first drafts…”

Sem RCT de ROAS / holdout no catálogo 1C nem em fetch 2C.

**C3 / C4 — Gartner agent washing + cancelamentos**  
Fonte: https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027 (fetched 2026-07-09)

> “Over 40% of agentic AI projects will be canceled by the end of 2027, due to escalating costs, unclear business value or inadequate risk controls”  
> “agent washing” — “only about 130 of the thousands of agentic AI vendors are real”  
> “Most agentic AI propositions lack significant value or return on investment (ROI)”

→ Marketing/content como beachhead de painel híbrido = **FLUFF CONFIRMED**; non-goal Cycle 4.

---

### 3.4 Anti-hype (autonomia / “sempre mais rápido”) → CONFIRMED

**METR −19% (experts OS)**  
Fonte: https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/ (fetched 2026-07-09)

> “when developers use AI tools, they take 19% longer than without—AI makes them slower.”  
> “developers expected AI to speed them up by 24%, and even after experiencing the slowdown, they still believed AI had sped them up by 20%.”

**SWE-Bench Pro ~23%**  
Fontes: https://scale.com/blog/swe-bench-pro · https://arxiv.org/html/2509.16941v1 (fetched/search 2026-07-09)

> Scale: GPT-5 / Claude Opus 4.1 “score only 23.3% and 23.1% respectively on SWE-Bench Pro.”  
> arXiv HTML: “LLM agents achieve only modest resolution rates… ≤ 23.3% on the public set.”

**Conflito Peng (+55% lab) vs METR (−19%)** — ambos **CONFIRMADOS**; pitch correto = *ciclo auditável + dual metrics + HITL*, não “sempre +X%”.

---

## 4. Lock recommendation (Cycle 4 plan)

### Beachhead (P1)

**Software Houses / product-eng teams (≈10–80 pessoas)** com Slack + Linear/GitHub:

1. Roster unificado humanos + agentes (status/adapter/custo).  
2. Workload lanes HITL + runs AI (fechar gap AI Hub ≠ Workload).  
3. Pedido fácil: Ask / `@mention` / assign-as-delegate com **humano owner**.  
4. Dual performance (percepção ≠ realidade — METR).

### Secondary (pós-beachhead)

**Support Ops internos** — sala + triage/draft agents; **não** displace Zendesk WEM/Resolution Platform.

### Non-goals (explícitos no plano)

| Non-goal | Motivo Cycle 2C |
|----------|-----------------|
| Marketing / content / ROAS agents | FLUFF; templates ClickUp ≠ causal; Gartner ROI unclear |
| Pitch “80% autonomia” / agent substitui time | REFUTADO por SWE-Bench Pro ~23% + METR; Zendesk 80% = vendor CX |
| Recruiting voice AI | Evidência A, canal errado (não re-fetched; lock 1C mantido) |
| Consulting “agentic org” enterprise como beachhead | WEAK fit / ciclo de venda (lock 1C mantido) |
| Unificar capacity *só* humana estilo ClickUp Workload | Já existe; valor = **híbrido** |

### Mensagem de valor (lock)

> Vender **capacidade e accountability híbridas** (carga, $, HITL, quem pediu) — não autonomia mágica nem ROAS.

---

## 5. Lacunas / incertezas

| Lacuna | Severidade | Ação |
|--------|------------|------|
| DoD 1C pedia ≥3 quotes de EM “não vejo carga humano+AI” | Média | Gap de produto ClickUp **confirmado**; quotes de buyer ainda anedóticas — Cycle 3/entrevistas |
| Slack Agentforce blog timeout no fetch | Baixa | Claude Tag + Linear bastam para UX `@` multiplayer |
| Brynjolfsson PDF 503 | Baixa | Abstract NBER + non-tech summary suficientes para +14% |
| Claude Tag 65% | Média | Manter **PARTIAL** — nunca no pitch como RCT |
| Zendesk “up to 80%” | — | Usar como **anti-exemplo** de hype, não como meta Paperclip |

---

## 6. Contagem

| Item | Valor |
|------|-------|
| **Path** | `docs/research/slack-a2a-room/cycle-2c-hybrid-confirmation/05-verticals-confirm.md` |
| Claims graded | 12 |
| CONFIRMED | 11 |
| PARTIAL | 1 (Claude Tag 65%) |
| REFUTED | 0 (hipóteses 1C); pitch “80%/ROAS beachhead” permanece **proibido** |
| **Veredito** | **LOCK:** Beachhead = Software Houses · Secondary = Support · Non-goals = Marketing + autonomia mágica |

---

## 7. Próximo (Cycle 3 / 4)

1. Cycle 3: deep-dive UX painel híbrido (roster + Ask + dual metrics) ancorado em Linear/ClickUp gap.  
2. Cycle 4: fases P0–Pn com vertical **somente SH** no GA beachhead; Support como expansão documentada.  
3. Copy GA: checklist anti-hype (sem 80%, sem ROAS, sem “substitui o time”).
