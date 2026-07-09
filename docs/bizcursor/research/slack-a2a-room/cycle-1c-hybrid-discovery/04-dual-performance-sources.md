# D4 — Dual performance sources (Human + AI agent)

> **Cycle:** 1C Hybrid Discovery — Path B+ dual performance panels  
> **Agent:** #4  
> **Data:** 2026-07-09  
> **Escopo:** Catálogo de fontes para medir times híbridos (humanos + agentes de IA)  
> **NotebookLM:** skip (non-Villa) — product/tech research Path B+ metrics  
> **Status:** Discovery only — claims **não** são fatos até Cycle 2

---

## 1. Resumo executivo

Produtos de workforce (ClickUp Workload, Linear Insights, Jira Control Chart, Asana Workload) já instrumentam **throughput, cycle/lead time, WIP e capacity** para humanos. Produtos de AI ops (ClickUp AI Hub, Langfuse, LangSmith, Helicone) + OpenTelemetry GenAI instrumentam **cost/job, latency, tokens, errors**. Academia (Co-Gym, CowPilot, Magentic-One, AAAI interdependence) e indústria (McKinsey gen-AI paradox, Deloitte ROI, Gartner cancel/agent-washing) apontam que **outcome + collaboration + HITL latency** importam mais que contagem de agentes ou ROAS de marketing.

**Gap de produto (hipótese):** quase ninguém unifica capacity humana + agent health + HITL wait no mesmo painel — oportunidade Path B+ (alinhar com D-11 / Ciclo 3B).

**Confiança deste catálogo:** média-alta nas fontes PRIMARY de produto/docs; média em papers; baixa em blogs de anti-hype secundários.

---

## 2. Catálogo de fontes

### 2.1 Human workforce analytics (throughput, cycle time, WIP, utilization)

| # | URL | Title | Date? | Why it matters | Tier |
|---|-----|-------|-------|----------------|------|
| H1 | https://help.clickup.com/hc/en-us/articles/6310449699735-Use-Workload-view | Use Workload view – ClickUp Help | n/d (help live) | PRIMARY de capacity humana: assignee + due + estimate → barras green/yellow/red; referência Path B+ Workload lanes | **PRIMARY** |
| H2 | https://help.clickup.com/hc/en-us/articles/36954958035863-AI-Hub | AI Hub – ClickUp Help | n/d | Roster AI com `# of Jobs`, `Avg Cost`, `Jobs in Progress`, schedules — **não** unifica com Workload humano (gap) | **PRIMARY** |
| H3 | https://help.clickup.com/hc/en-us/articles/36960637050135-Manage-and-edit-Super-Agent-profiles | Manage and edit Super Agent profiles – ClickUp Help | n/d | Painel cost/usage por agente: avg cost, last run cost, # runs, total cost — template de “agent row” | **PRIMARY** |
| H4 | https://linear.app/docs/insights | Insights – Linear Docs | n/d | Issue count, Effort, **Cycle Time**, **Lead Time**, Triage Time, Issue Age, burn-up — baseline humano de flow | **PRIMARY** |
| H5 | https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-control-chart/ | View and understand the control chart \| Jira Cloud | n/d | Cycle/lead time por status + rolling avg + stdev — definição operacional clássica de cycle time | **PRIMARY** |
| H6 | https://help.asana.com/s/article/portfolio-workload-and-universal-workload?language=en_US | How to use workload to manage team capacity \| Asana | n/d | WIP/capacity por pessoa (task count ou effort); OOO; universal workload — segundo vendor de Workload | **PRIMARY** |
| H7 | https://help.asana.com/s/article/capacity-planning?language=en_US | How to use capacity planning \| Asana | n/d | Capacity de longo prazo (alocação %/horas) vs task-level Workload — distinção planning vs execution | **SECONDARY** |
| H8 | https://dora.dev/guides/dora-metrics/ | DORA’s software delivery performance metrics | Updated 2026-01-05 | Throughput (lead time, deploy freq, recovery) + instability (change fail, rework) — anti-vanity para engenharia humana | **PRIMARY** |
| H9 | https://www.atlassian.com/devops/frameworks/dora-metrics | DORA Metrics: How to measure Open DevOps Success \| Atlassian | n/d | Tradução vendor das 4 keys; útil para UX de scorecards | **SECONDARY** |
| H10 | https://linear.app/integrations/larridin | Larridin Integration – Linear | n/d | Scorecards híbridos no Linear: throughput, cycle time, **human vs AI-authored code**, cost-per-issue — sinal de mercado Path B+ | **SECONDARY** |

### 2.2 AI agent ops metrics (cost/job, success rate, latency, retries, tool errors)

| # | URL | Title | Date? | Why it matters | Tier |
|---|-----|-------|-------|----------------|------|
| A1 | https://langfuse.com/docs/metrics/overview | Metrics Overview – Langfuse | n/d | Cost, latency, volume, quality scores por user/session/model/prompt — schema de dashboard agent ops | **PRIMARY** |
| A2 | https://langfuse.com/docs/observability/features/token-and-cost-tracking | Token & Cost Tracking – Langfuse | n/d | Cost inference por model pricing; breakdown input/output — cost/job | **PRIMARY** |
| A3 | https://docs.langchain.com/langsmith/cost-tracking | Cost tracking – LangSmith | n/d | Cost em trace tree + project stats + dashboards; custom cost em tool runs | **PRIMARY** |
| A4 | https://docs.langchain.com/langsmith/observability-llm-tutorial | Trace an LLM application tutorial – LangSmith | n/d | Monitoring: latency, error rate, feedback, costs agregados | **PRIMARY** |
| A5 | https://docs.helicone.ai/getting-started/platform-overview | Platform Overview – Helicone | n/d | Cost + latency + errors em gateway; unit economics por user/feature | **PRIMARY** |
| A6 | https://opentelemetry.io/blog/2024/otel-generative-ai/ | OpenTelemetry for Generative AI | 2024 | Convenções GenAI: traces/metrics/events; tokens + latency como sinais padrão | **PRIMARY** |
| A7 | https://opentelemetry.io/blog/2026/genai-observability/ | Inside the LLM Call: GenAI Observability with OpenTelemetry | 2026 | `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`; TTFT; tool calls | **PRIMARY** |
| A8 | https://github.com/open-telemetry/semantic-conventions-genai | open-telemetry/semantic-conventions-genai | Active 2026 | Repo canônico GenAI semconv (spans/metrics/MCP) — fonte de nomes estáveis | **PRIMARY** |
| A9 | https://help.clickup.com/hc/en-us/articles/37837088720151-How-are-AI-Super-Credits-consumed | How are AI Super Credits consumed? – ClickUp | n/d | Cost model por ação/job (100–300 credits); liga AI Hub a unit economics | **PRIMARY** |
| A10 | https://www.microsoft.com/en-us/research/publication/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ | Magentic-One (MSR-TR-2024-47) | Nov 2024 | Task completion rate + error analysis em multi-agent; AutoGenBench — success ≠ vanity | **PRIMARY** |

### 2.3 HITL metrics (human wait time, approval latency, intervention rate)

| # | URL | Title | Date? | Why it matters | Tier |
|---|-----|-------|-------|----------------|------|
| T1 | https://arxiv.org/abs/2412.15701 | Collaborative Gym (Co-Gym): Enabling and Evaluating Human-Agent Collaboration | 2024-12 (arXiv) | Collab Score, Initiative Entropy, Controlled Autonomy, Overall Satisfaction; win rates vs autonomous | **PRIMARY** |
| T2 | https://github.com/SALT-NLP/collaborative-gym | SALT-NLP/collaborative-gym | n/d | Implementação open das métricas Co-Gym (initiative, controlled autonomy) | **PRIMARY** |
| T3 | https://arxiv.org/abs/2501.16609 | CowPilot: Autonomous and Human-Agent Collaborative Web Navigation | 2025-01 (arXiv) | **Human intervention count**, agent/human step counts, agent-driven completion accuracy | **PRIMARY** |
| T4 | https://ojs.aaai.org/index.php/AAAI/article/view/38787 | Who Is Helping Whom? Inter-Dependencies in Human-AI Teaming (AAAI) | 2026 (AAAI-40) | Task reward ≠ cooperation; **constructive interdependence** — anti-métrica de “só success rate” | **PRIMARY** |
| T5 | https://openreview.net/forum?id=GDYueXtKXT | Collaborative Gym – OpenReview | n/d | Peer review / abstract estável; aponta falhas de comunicação (65%) e situational awareness (40%) | **SECONDARY** |

### 2.4 Academic / industry — human–AI team performance

| # | URL | Title | Date? | Why it matters | Tier |
|---|-----|-------|-------|----------------|------|
| I1 | https://www.mckinsey.com/capabilities/quantumblack/our-insights/seizing-the-agentic-ai-advantage | Seizing the agentic AI advantage \| McKinsey | Jun 2025 | “Gen AI paradox”: uso alto, EBIT baixo; KPIs de outcome + workflow redesign + human–agent cohabitation | **PRIMARY** |
| I2 | https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai-how-organizations-are-rewiring-to-capture-value | The State of AI \| McKinsey Global Survey | n/d (survey series) | >80% sem impacto EBIT enterprise; workflow redesign correlaciona com valor | **PRIMARY** |
| I3 | https://www.deloitte.com/us/en/what-we-do/capabilities/applied-artificial-intelligence/content/state-of-ai-in-the-enterprise.html | The State of AI in the Enterprise 2026 \| Deloitte | 2026 | Benefícios reportados (produtividade 66%, cost 40%); agentic governance madura só ~21% | **PRIMARY** |
| I4 | https://www.deloitte.com/global/en/issues/ai/ai-roi-the-paradox-of-rising-investment-and-elusive-returns.html | AI ROI: rising investment, elusive returns \| Deloitte | n/d | Só ~10% dos users de agentic AI reportam ROI significativo; frameworks distintos gen vs agentic | **PRIMARY** |
| I5 | https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/ | Magentic-One article \| Microsoft Research | 2024 | Narrative + benchmarks GAIA/WebArena/AssistantBench — success rate com CI | **SECONDARY** |
| I6 | https://www.mckinsey.com/capabilities/people-and-organizational-performance/our-insights/the-human-side-of-generative-ai-creating-a-path-to-productivity | The human side of generative AI \| McKinsey | n/d | Papel do manager / humanização do trabalho — métricas de orchestration humana | **SECONDARY** |

### 2.5 Anti-patterns — vanity AI metrics, ROAS fluff, agent washing

| # | URL | Title | Date? | Why it matters | Tier |
|---|-----|-------|-------|----------------|------|
| X1 | https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027 | Gartner: >40% agentic AI projects canceled by EOY 2027 | 2025-06-25 | Custos, unclear value, risk controls — kill vanity pilots | **PRIMARY** |
| X2 | https://www.gartner.com/en/newsroom/press-releases/2025-08-26-gartner-predicts-40-percent-of-enterprise-apps-will-feature-task-specific-ai-agents-by-2026-up-from-less-than-5-percent-in-2025 | Gartner: 40% enterprise apps with task-specific agents by 2026 | 2025-08-26 | Define **agent washing** (assistants rebranded as agents) | **PRIMARY** |
| X3 | https://www.gartner.com/en/articles/hype-cycle-for-agentic-ai | 2026 Hype Cycle for Agentic AI \| Gartner | 2026 | Peak of Inflated Expectations; governance/cost profiles separados | **PRIMARY** |
| X4 | https://lynnraebsamen.com/agent-washing-in-the-boardroom-the-vanity-metric/ | Agent Washing in the Boardroom: The Vanity Metric | n/d | Vanity: # agents, raw interactions, adoption counts sem outcome | **SECONDARY** |
| X5 | https://dora.dev/guides/dora-metrics/ | DORA metrics (pitfalls section) | 2026-01-05 | Goodhart: “metrics as goals”, one-metric-to-rule-them-all — aplica a AI dashboards | **PRIMARY** (reuse H8) |

**Contagem:** **30 fontes únicas** (H1–H10, A1–A10, T1–T5, I1–I6, X1–X4; X5 = H8).  
Faixa pedida: 15–35 ✓

---

## 3. Draft metric taxonomy — **UNCONFIRMED**

> Hipóteses para Cycle 2. Não promover a requisitos sem grade CONFIRMED/PARTIAL.

### 3.1 Human (owner / reviewer)

| ID | Métrica (hipótese) | Definição operacional draft | Fonte inspiração |
|----|--------------------|-----------------------------|------------------|
| Hu-1 | WIP por owner | Issues abertas com `owner=human` / pessoa | H1, H6 |
| Hu-2 | Human cycle time | p50/p90 start→done em issues **sem** delegate agent | H4, H5 |
| Hu-3 | Utilization / capacity load | Effort assigned / capacity (horas ou points) | H1, H6 |
| Hu-4 | Approval latency | Tempo `needs_you` / gate → resolve (approve\|reject) | T1–T3, I1 |
| Hu-5 | Review burden | Minutos humanos em gates / semana | T1, I6 |
| Hu-6 | Override / reject rate | % outputs agent rejeitados ou refeitos | T3, T4 |

### 3.2 Agent (delegate / runner)

| ID | Métrica (hipótese) | Definição operacional draft | Fonte inspiração |
|----|--------------------|-----------------------------|------------------|
| Ag-1 | Success rate | runs `done` / (`done`+`failed`) na janela | A10, A1 |
| Ag-2 | Cost / job (done) | $ spend / issues agentic concluídas | H2, H3, A2, A3, A9 |
| Ag-3 | Latency p50/p95 | queued→running→done; opcional TTFT LLM | A6, A7, A5 |
| Ag-4 | Retry / error rate | retries + tool/provider errors / runs | A1, A5, A8 |
| Ag-5 | Idle / waste spend | $ em cancel/fail/orphan | A2, X1 |
| Ag-6 | Autonomy ratio | % conclusões sem gate intermediário (**alto ≠ bom**) | T1, T3 |

### 3.3 Room / Thread (hybrid orchestration)

| ID | Métrica (hipótese) | Definição operacional draft | Fonte inspiração |
|----|--------------------|-----------------------------|------------------|
| Rm-1 | Throughput híbrido | Issues fechadas / semana com ≥1 hop agentic | H4, H8, I1 |
| Rm-2 | Hybrid cycle time | open→done com owner+delegate | H4, H5 |
| Rm-3 | Co-touch rate | % issues com ≥1 humano **e** ≥1 agente no histórico | T1, T4 |
| Rm-4 | Human wait time (HITL) | soma tempo em estados de espera humana no thread | T1–T3 |
| Rm-5 | Intervention rate | intervenções humanas / run ou / issue | T3 |
| Rm-6 | Fan-out join success | % orchestrations N≥2 com join completo (sem timeout) | A10 + prior A2A research |
| Rm-7 | Cost / done outcome | spend total room / outcomes aceitos (first-pass) | A2, I1, I4 |
| Rm-8 | Orphan agentic | issues com delegate **sem** owner humano | H2 gap + governance I3 |

### 3.4 Anti-métricas (não exibir como KPI primário) — **UNCONFIRMED**

| Anti-métrica | Por quê evitar | Fonte |
|--------------|----------------|-------|
| # de agentes criados | Agent washing / vanity | X1, X2, X4 |
| Raw message / interaction count | Sem outcome | X4, I1 |
| “Autonomy %” isolado | Alto + override alto = risco | T1, T4 |
| ROAS / “AI marketing lift” sem holdout | Fluff vertical marketing | I1, X1 (value unclear) |
| Token count sem $ e sem outcome | Proxy fraco | A2, DORA pitfalls H8 |

---

## 4. Top 8 claims para Cycle 2

| ID | Claim | Fontes a citar | Prioridade |
|----|-------|----------------|------------|
| C2-D4-01 | ClickUp AI Hub expõe **Avg Cost**, **# of Jobs**, **Jobs in Progress** por Super Agent, mas **não** unifica isso com Workload humano no mesmo view. | H1, H2, H3 | P0 |
| C2-D4-02 | Linear Insights define operacionalmente **Cycle Time** (start→complete) e **Lead Time** (create→complete) como medidas first-class de flow humano. | H4 | P0 |
| C2-D4-03 | Jira Control Chart calcula cycle/lead time a partir de **status selecionados** + rolling average/stdev — útil como contrato de definição. | H5 | P1 |
| C2-D4-04 | Stack Langfuse/LangSmith/Helicone + OTel GenAI padronizam **cost, latency (incl. TTFT), tokens, errors** como telemetria agent ops. | A1–A8 | P0 |
| C2-D4-05 | Co-Gym e CowPilot medem colaboração além de task success: initiative/controlled autonomy e **human intervention count**. | T1, T2, T3 | P0 |
| C2-D4-06 | AAAI “Who Is Helping Whom?”: **task reward alto ≠ cooperação**; interdependence deve ser métrica separada. | T4 | P1 |
| C2-D4-07 | McKinsey/Deloitte: adoção gen/agentic alta com **ROI/EBIT fraco** → painéis devem priorizar outcome + cost/outcome, não adoption vanity. | I1–I4 | P0 |
| C2-D4-08 | Gartner: >40% projetos agentic cancelados até 2027 + **agent washing** → dual panels Path B+ devem rejeitar KPIs de contagem de agentes / ROAS fluff. | X1, X2, X3 | P0 |

---

## 5. Incertezas e lacunas

1. **Datas de help docs** ClickUp/Linear/Asana/Jira raramente versionadas — Cycle 2 deve WebFetch e capturar quote + “retrieved 2026-07-09”.  
2. **OTel GenAI** ainda em evolução (repo `semantic-conventions-genai`); nomes de retry/error podem mudar — não travar schema Paperclip em semconv Development.  
3. **HITL latency** em produtos SaaS (ClickUp/Linear) pouco documentada como KPI first-class — pode ser **CONSTRUIR** no fork.  
4. **ROAS fluff**: poucas PRIMARY oficiais; anti-pattern vem mais de Gartner/McKinsey “unclear value” do que de papers de ads.  
5. Cruzar com Ciclo 3B `04-dual-performance-metrics.md` (taxonomia Outcome/Collaboration/…) — este D4 é **fonte**, não SPEC.

---

## 6. Entrega

| Campo | Valor |
|-------|-------|
| **Path** | `docs/research/slack-a2a-room/cycle-1c-hybrid-discovery/04-dual-performance-sources.md` |
| **Source count** | **30** |
| **PRIMARY** | ~24 |
| **SECONDARY** | ~6 |
| **Próximo** | Cycle 2 — confirmar C2-D4-01…08 com quotes |
