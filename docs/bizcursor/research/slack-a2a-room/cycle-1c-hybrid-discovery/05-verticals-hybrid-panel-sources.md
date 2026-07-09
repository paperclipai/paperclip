# D5 — Verticais Path B+ (painel híbrido humano + IA)

> **Ciclo:** 1C — Discovery (Path B+ beachhead)  
> **Agente:** #5 — Verticals / hybrid ops panel  
> **Data:** 2026-07-09  
> **Pergunta:** Quais negócios precisam de um **painel** para gerir **staff humano e agentes de IA proativos**, com humanos pedindo trabalho à IA com facilidade?  
> **Re-validação:** Cycle 1–3 disseram Software Houses = beachhead; Support = secundário; Marketing = FLUFF.  
> **Confiança geral:** Alta nas grades Software House / Support / Marketing; média em Consulting / Recruiting (fit de canal).  
> **NotebookLM:** skip (trivial) — discovery de fontes de mercado, sem overlap Villa.

---

## 1. Resumo executivo

O painel híbrido (roster + workload + pedido fácil humano→IA + dual performance) **não muda** o beachhead: **Software Houses / product-eng teams** continuam #1. A evidência causal de produtividade em SE é a mais forte; o fit de produto (agente como colega, `@mention`, assign-as-delegate, HITL) é o mais maduro nos produtos de referência (Linear, Slack, Claude Tag, ClickUp Super Agents).

**Support Ops** permanece **secundário**: há RCT de campo (Brynjolfsson) e demanda clara de workforce humano+AI, mas o painel “tipo ClickUp Team” compete com WEM/CX suites (Zendesk) — melhor como expansão após beachhead eng.

**Marketing / Content** permanece **FLUFF** para beachhead do painel: claims de ROAS/autonomia sem holdout; Gartner documenta *agent washing* e cancelamento de projetos agentic por valor unclear.

**Novidade Path B+ vs Cycle 1 D5:** o *job-to-be-done* do painel (ver carga humano+AI no mesmo lugar; pedir trabalho sem decorar slugs) reforça Software Houses — EMs já sofrem com agent sprawl e capacity cega (ClickUp separa AI Hub vs Workload humano).

---

## 2. Critérios de grade (Path B+)

| Grade | Definição para este catálogo |
|-------|------------------------------|
| **STRONG** | Evidência causal A/B **ou** produto enterprise com UX híbrida auditável **e** fit claro com roster/workload/pedido fácil |
| **WEAK** | Evidência útil mas canal errado, proficiency early, ou painel já coberto por suite vertical dominante |
| **FLUFF** | Forecast/vendor claim/ROAS sem método; hype agentic sem HITL/ops mensurável |

Dimensões: (1) evidência causal, (2) necessidade de **roster híbrido**, (3) **pedido fácil** humano→IA, (4) fit com Room Slack+@ + Team panel.

---

## 3. Catálogo de fontes (n = 24)

### 3.1 Software houses / product-eng (candidatos STRONG)

| # | Fonte | Tipo | Data | URL | Achado relevante ao painel híbrido | Confiança |
|---|-------|------|------|-----|-------------------------------------|-----------|
| 1 | Peng et al. — *Impact of AI on Developer Productivity* (Copilot RCT) | RCT lab | 2023-02 | https://arxiv.org/abs/2302.06590 | +55,8% mais rápido em task JS; prova demanda de AI no fluxo de eng | Alta |
| 2 | Demirer / Peng / Salz et al. — field experiments Microsoft/Accenture/F100 | RCT campo | 2025 (MS) | https://doi.org/10.1287/mnsc.2025.00535 · PDF https://economics.mit.edu/sites/default/files/inline-files/draft_copilot_experiments.pdf | +26,08% tasks completadas (n=4.867); AI no time real de software | Alta |
| 3 | METR — Early-2025 AI on experienced OS developers | RCT campo | 2025-07-10 | https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/ | Experts **−19%** com AI; percepção ≠ realidade → **HITL + métricas dual** obrigatórios no painel | Alta |
| 4 | Scale — SWE-Bench Pro | Benchmark | 2025-09-19 | https://scale.com/blog/swe-bench-pro · https://arxiv.org/abs/2509.16941 | Frontier ~**23%** public set → agentes não substituem time; painel de oversight faz sentido | Alta |
| 5 | Linear Docs — AI Agents | Product docs | atual | https://linear.app/docs/agents-in-linear | Agente = app user; **delegate ≠ assignee**; humano permanece responsável | Alta |
| 6 | Linear Docs — Assign and delegate | Product docs | atual | https://linear.app/docs/assigning-issues | Pedido fácil: assign agent mantém owner humano — padrão Path B+ D-12 | Alta |
| 7 | Linear Developers — Agents getting started | Product docs | atual | https://linear.app/developers/agents | `app:assignable` / `app:mentionable`; Insights por Delegate | Alta |
| 8 | Anthropic — Introducing Claude Tag | Product / vendor | 2026-06-23 | https://www.anthropic.com/news/introducing-claude-tag | `@Claude` multiplayer no Slack; async + ambient; claim interno **65%** PRs (usar só como UX, não como RCT) | Média (UX alta; % = C) |
| 9 | Slack — Agentforce / agents as teammates | Product | 2024– | https://slack.com/blog/news/turn-agents-into-teammates-with-slack · https://slack.com/help/articles/36218786859667-Use-Agentforce-in-Slack | Agentes no directory; `@mention` em canal como colega | Alta |
| 10 | ClickUp Help — Super Agents | Product docs | atual | https://help.clickup.com/hc/en-us/articles/36487554975255-How-can-Super-Agents-help-your-team | Tabela de use cases inclui **Software development** (bug triage, release notes); `@mention` + assign + schedule | Alta |

### 3.2 Support ops (candidatos STRONG secundário / WEAK beachhead)

| # | Fonte | Tipo | Data | URL | Achado relevante | Confiança |
|---|-------|------|------|-----|------------------|-----------|
| 11 | Brynjolfsson, Li, Raymond — *Generative AI at Work* | Quasi-exp. campo | 2023 (rev.) | https://www.nber.org/papers/w31161 · PDF https://www.nber.org/system/files/working_papers/w31161/w31161.pdf | +14% issues/hora (n=5.179); novatos +34%; AI **assiste** humanos | Alta |
| 12 | Zendesk — 2025 CX Trends (press) | Survey vendor | 2024-11-20 | https://www.zendesk.com/newsroom/press-releases/zendesk-2025-cx-trends-report-human-centric-ai-drives-loyalty/ | Copilots + AI agents; 73% agents querem copiloto; narrativa human-centric | Média |
| 13 | Intercom — Customer service team evolution | Vendor research | 2024– | https://www.intercom.com/blog/new-research-customer-service-team-evolution/ | ~95% mudam workflow pós-AI; humanos viram QA/monitor; hybrid human+AI | Média |
| 14 | Zendesk — Resolution Platform / AI agents | Product | 2025 | https://www.zendesk.com/blog/zendesk-insights/innovation/relate-2025-resolution-platform-ai-agents/ | Unifica AI agents + copilots + WEM; prova que **suite CX já vende painel híbrido** | Alta |

### 3.3 Hybrid roster / workload gap (evidência de produto — transversal)

| # | Fonte | Tipo | Data | URL | Achado relevante | Confiança |
|---|-------|------|------|-----|------------------|-----------|
| 15 | ClickUp Help — AI Hub | Product docs | atual | https://help.clickup.com/hc/en-us/articles/36954958035863-AI-Hub | Roster de Super Agents: status, schedules, jobs, monthly usage — **só AI** | Alta |
| 16 | ClickUp Help — Set capacity limits in Workload | Product docs | atual | https://help.clickup.com/hc/en-us/articles/30799771936279-Set-capacity-limits-in-Workload-view | Capacity por **assignee humano** (time/tasks/points) — **não unifica AI** | Alta |
| 17 | ClickUp Help — Measure your workload | Product docs | atual | https://help.clickup.com/hc/en-us/articles/30799712357271-Measure-your-workload | Métricas de carga humanas; gap vs AI Hub = oportunidade Paperclip B+ | Alta |
| 18 | ClickUp Brain — Team Capacity Assessor / Workload Balancer agents | Product catalog | atual | https://clickup.com/brain/agents/templates/listings/team-capacity-assessor · https://clickup.com/brain/agents/templates/listings/team-workload-balancer | Agentes **analisam** capacity humana; não são lanes unificadas humano+AI | Média |

### 3.4 Consulting / enterprise ops (contexto de governança — WEAK beachhead)

| # | Fonte | Tipo | Data | URL | Achado relevante | Confiança |
|---|-------|------|------|-----|------------------|-----------|
| 19 | McKinsey — *Seizing the agentic AI advantage* | Analyst | 2025-06 | https://www.mckinsey.com/capabilities/quantumblack/our-insights/seizing-the-agentic-ai-advantage · PDF https://www.mckinsey.com/~/media/mckinsey/business%20functions/quantumblack/our%20insights/seizing%20the%20agentic%20ai%20advantage/seizing-the-agentic-ai-advantage-june-2025.pdf | Agentic mesh; roles *agent orchestrator* / HITL designer; anti-sprawl | Média |
| 20 | McKinsey — *The agentic organization* | Analyst | 2025 | https://www.mckinsey.com/capabilities/people-and-organizational-performance/our-insights/the-agentic-organization-contours-of-the-next-paradigm-for-the-ai-era | HR passa a trackear **humanos + agents**; performance = orquestração, não só task completion | Média |
| 21 | Deloitte — AI agent observability / human-on-the-loop | Consulting | 2025– | https://www.deloitte.com/us/en/services/consulting/articles/ai-agent-observability-human-in-the-loop.html | KPIs de agent ops; shift execution→oversight | Média |
| 22 | Deloitte — Global Agentic Network (press) | Press | 2025-05-27 | https://www.deloitte.com/global/en/about/press-room/deloitte-launches-global-agentic-network-to-power-digital-workforce-solutions.html | “Digital workforce” como oferta de consulting — demanda de gestão híbrida, não de beachhead SaaS eng | Média |

### 3.5 Marketing / anti-hype (FLUFF beachhead) + Recruiting (WEAK canal)

| # | Fonte | Tipo | Data | URL | Achado relevante | Confiança |
|---|-------|------|------|-----|------------------|-----------|
| 23 | Gartner — >40% agentic projects canceled by EOY 2027 | Analyst press | 2025-06-25 | https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027 | Custos, valor unclear, risk controls; **agent washing**; ~130 vendors “reais” | Alta |
| 24 | Jabarian & Henkel — Voice AI interviews field experiment | Field exp. | 2025 | https://brianjabarian.org/voiceai · https://www.chicagobooth.edu/review/does-ai-beat-humans-recruiting | Evidência **A** em hiring (+12% offers), mas win = **voice**, não painel Slack/Team | Alta |

---

## 4. Grades por vertical (re-validação Path B+)

| Vertical | Grade | Rationale (painel híbrido) |
|----------|-------|----------------------------|
| **Software Houses / Product-Eng** | **STRONG** | RCTs lab+campo (#1–2); METR/SWE-Bench forçam HITL (#3–4); UX nativa de pedido fácil e ownership (#5–9); ClickUp lista bug triage como Super Agent (#10). EM precisa ver **lanes humano + `@coder`/`@triage`** antes de pedir mais spike. |
| **Customer Support Ops** | **STRONG** (secundário) / **WEAK** (beachhead) | Causal forte (#11); hybrid ops real (#12–13); mas Zendesk já vende Resolution Platform + WEM (#14) — Paperclip entra como Room+Team genérico, não como displace CX suite. |
| **Product / PM-ops (dentro de SE)** | **STRONG** (sub-persona) | Claude Tag + Linear + Slack mostram PM/eng pedindo AI no mesmo canal (#8–9); não é vertical separada — **absorver no beachhead SH**. |
| **Consulting / Professional services** | **WEAK** | McKinsey/Deloitte descrevem *agentic org* e observability (#19–22), mas são frameworks/serviços — buyer longo, sales cycle enterprise, pouco fit com Coolify/Paperclip beachhead. |
| **Recruiting Ops** | **WEAK** | Evidência causal excelente (#24), canal **voice-first**; painel híbrido Slack/Team é misfit no win principal. |
| **Marketing / Content / Growth** | **FLUFF** | ClickUp lista “Campaign builder / Copy writer” (#10) como template — **não** é evidência de outcome. Gartner (#23) + ausência de RCT de ROAS agentic → proibido como beachhead. |
| **Supply Chain / Finance AP** | **FLUFF→WEAK** (fora do escopo 1C) | Sem fontes A neste catálogo; manter non-goal até Cycle 2 se surgir primary. |

### Conflitos entre fontes (não misturar no pitch)

1. **Peng (+55% lab) vs METR (−19% experts)** — ambos válidos; painel vende *ciclo auditável + review*, não “sempre mais rápido”.  
2. **Claude Tag 65% PRs** — claim interno Anthropic (#8); útil só como prova de UX Slack multiplayer.  
3. **Support +14% (Brynjolfsson)** vs **Zendesk suite** — valor existe, mas GTM beachhead compete com incumbente.

---

## 5. Hipóteses para Cycle 2 (confirmação)

### Beachhead (hipótese H1 — confirmar)

**Software Houses / product-eng teams (10–80 pessoas)** que já usam Slack/Linear/GitHub e querem:

1. Roster unificado (humanos + agentes com adapter/status/custo).  
2. Workload lanes (HITL humano + runs AI).  
3. Pedido fácil (Ask / `@` / assign-as-delegate) sem agent sprawl.

**DoD de confirmação Cycle 2:** ≥3 quotes primárias de EM/tech lead descrevendo “não vejo carga total humano+AI”; validar que ClickUp AI Hub ≠ Workload (#15–17) permanece gap.

### Secundário (hipótese H2)

**Support Ops internos** (não displace Zendesk): sala `#support-ops` + agentes de triage/draft; painel Team para lead de CS ver fila humana + AI involvement rate.

**DoD Cycle 2:** confirmar Brynjolfsson applicability a *ops internos* (não só BPO); mapear overlap com Zendesk WEM.

### Non-goals (hipótese H3 — manter fora do P1)

| Non-goal | Por quê |
|----------|---------|
| Marketing/content ROAS agents | FLUFF (#23); sem causal |
| Recruiting voice AI | Evidência A, canal errado (#24) |
| Consulting “agentic org” enterprise | WEAK fit; ciclo de venda |
| “Substitui o time / autonomia 80%” | Refutado por METR + SWE-Bench Pro + Gartner |
| Unificar capacity ClickUp-style *só* para humanos | Já existe (#16); valor Paperclip = **híbrido** |

### Mensagem de valor (anti-hype)

> Vender **capacidade e accountability híbridas** (quem está carregado, quanto custa $, quanto tempo HITL, quem pediu o quê) — não autonomia mágica.

---

## 6. Contagem e path

| Item | Valor |
|------|-------|
| **Path** | `docs/research/slack-a2a-room/cycle-1c-hybrid-discovery/05-verticals-hybrid-panel-sources.md` |
| **Fontes catalogadas** | **24** |
| **Verticais graded** | 7 (SH STRONG; Support STRONG-sec/WEAK-beach; Product-ops STRONG-sub; Consulting WEAK; Recruiting WEAK; Marketing FLUFF; SC/Finance out-of-scope) |
| **Re-validação prior** | **CONFIRMADA** — SH beachhead · Support secundário · Marketing FLUFF |

---

## 7. Próximo (Cycle 2)

1. Confirmar quotes ClickUp gap (AI Hub vs Workload) com screenshots/docs.  
2. Confirmar Linear delegate + Insights por Delegate em uso real.  
3. Entrevistas/hipóteses com 2–3 EMs de software house (carga híbrida).  
4. Explicitamente **REFUTAR** qualquer pitch marketing ROAS no material GA.
