# Cycle 2C — Confirmação Dual Performance (Human | Agent | Room)

> **Data:** 2026-07-09 (retrieved)  
> **Agente:** Cycle 2 Confirmation #4  
> **Fonte das claims:** [`cycle-1c-hybrid-discovery/04-dual-performance-sources.md`](../cycle-1c-hybrid-discovery/04-dual-performance-sources.md) (C2-D4-01…08)  
> **Método:** WebFetch PRIMARY (ClickUp Help, Linear Docs, Jira Cloud, Langfuse, LangSmith, Helicone, OTel blogs, arXiv/AAAI, McKinsey PDF, Deloitte, Gartner Newsroom)  
> **NotebookLM:** skip (non-Villa) — product/tech research Path B+ metrics  
> **Confiança geral:** Alta em docs de produto; média em academia; média-baixa em consultoria (McKinsey/Deloitte/Gartner → preferir PARTIAL quando a claim for prescritiva)

---

## 1. Resumo executivo

Cinco claims de instrumentação de produto/academia fecham como **CONFIRMED**. Três claims de stack GenAI / consultoria / anti-hype ficam **PARTIAL** (sub-parte TTFT não verificada no fetch; paradoxo ROI confirmado mas prescrição de painel é inferência; agent washing + cancel confirmados, ROAS/#agents-as-KPI é extrapolação).

**Score: 5/8 CONFIRMED** (+ 3 PARTIAL, 0 REFUTED)

**P0 metric set** abaixo usa **somente** evidência CONFIRMED. Tudo que depende de PARTIAL fica **OUT**.

---

## 2. Summary table

| ID | Claim (curta) | Grade | Confiança | Primary URL(s) fetched |
|----|---------------|-------|-----------|------------------------|
| C2-D4-01 | AI Hub: Avg Cost / # Jobs / Jobs in Progress; **não** unifica com Workload humano | **CONFIRMED** | Alta | AI Hub, Workload, Super Agent profiles |
| C2-D4-02 | Linear Insights: Cycle Time (start→complete) + Lead Time (create→complete) first-class | **CONFIRMED** | Alta | Linear Insights |
| C2-D4-03 | Jira Control Chart: cycle/lead por status selecionados + rolling avg + stdev | **CONFIRMED** | Alta | Jira Control Chart |
| C2-D4-04 | Langfuse/LangSmith/Helicone + OTel: cost, latency (TTFT), tokens, errors | **PARTIAL** | Média | Langfuse, LangSmith, Helicone, OTel 2024/2026 |
| C2-D4-05 | Co-Gym + CowPilot: colaboração além de success (initiative / controlled autonomy / intervention) | **CONFIRMED** | Alta | arXiv 2412.15701, 2501.16609; GitHub Co-Gym |
| C2-D4-06 | AAAI: task reward ≠ cooperação; interdependence métrica separada | **CONFIRMED** | Alta | AAAI OJS abstract |
| C2-D4-07 | McKinsey/Deloitte: adoção alta, ROI/EBIT fraco → painel outcome + cost/outcome | **PARTIAL** | Média | McKinsey PDF Jun 2025; Deloitte AI ROI |
| C2-D4-08 | Gartner: >40% cancel até 2027 + agent washing → rejeitar #agents / ROAS fluff | **PARTIAL** | Média | Gartner PR 2025-06-25, 2025-08-26 |

**Score: 5/8 CONFIRMED**

---

## 3. Claims detalhadas

### C2-D4-01 — AI Hub vs Workload (gap unificado)

**Claim:** ClickUp AI Hub expõe **Avg Cost**, **# of Jobs**, **Jobs in Progress** por Super Agent, mas **não** unifica isso com Workload humano no mesmo view.

**Primary URLs:**
- https://help.clickup.com/hc/en-us/articles/36954958035863-AI-Hub
- https://help.clickup.com/hc/en-us/articles/6310449699735-Use-Workload-view
- https://help.clickup.com/hc/en-us/articles/36960637050135-Manage-and-edit-Super-Agent-profiles

**Fetch:** OK (AI Hub, Workload, profiles)

**Quote (AI Hub columns):**
> “Avg Cost… shown in USD… # of Jobs… Jobs in Progress… The number of currently active jobs.”

**Quote (Workload humano):**
> “Visualize your team's work and capacity over time… each person's capacity is displayed in shades of red, yellow, or green.”

**Quote (profile cost panel):**
> “Average cost… Last run cost… Number of runs… Total cost…”

**Grade:** **CONFIRMED**

**Notas:** Workload documenta capacity por pessoa/assignee; AI Hub/profile documentam métricas de Super Agent. Nenhum dos artigos fetched descreve colunas de agente dentro do Workload (nem capacity humana no AI Hub). Gap de unificação = ausência documental cruzada, alinhado ao Cycle 2C Claim 4 ClickUp.

---

### C2-D4-02 — Linear Cycle / Lead Time

**Claim:** Linear Insights define operacionalmente **Cycle Time** (start→complete) e **Lead Time** (create→complete) como medidas first-class de flow humano.

**Primary URL:**
- https://linear.app/docs/insights

**Fetch:** OK

**Quote:**
> “Cycle Time — Time from issue start to completion”  
> “Lead Time — Time from issue creation to completion”

**Grade:** **CONFIRMED**

**Notas:** Measures first-class na tabela Measure/Slice; scatterplot; filtros automáticos (Cycle Time só issues que passaram por in-progress).

---

### C2-D4-03 — Jira Control Chart contrato

**Claim:** Jira Control Chart calcula cycle/lead time a partir de **status selecionados** + rolling average/stdev — útil como contrato de definição.

**Primary URL:**
- https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-control-chart/

**Fetch:** OK (após retry)

**Quote:**
> “It takes the time spent by each work item in a particular status (or statuses), and maps it over a specified period of time. The average, rolling average, and standard deviation for this data are shown.”

**Quote (cycle vs lead):**
> “Cycle time is the time spent working on a work item… Lead time is similar to cycle time, but is the time taken from when a work item is logged… until work is completed”

**Grade:** **CONFIRMED**

---

### C2-D4-04 — Stack agent ops (cost / latency / tokens / errors)

**Claim:** Stack Langfuse/LangSmith/Helicone + OTel GenAI padronizam **cost, latency (incl. TTFT), tokens, errors** como telemetria agent ops.

**Primary URLs:**
- https://langfuse.com/docs/metrics/overview
- https://langfuse.com/docs/observability/features/token-and-cost-tracking
- https://docs.langchain.com/langsmith/cost-tracking
- https://docs.helicone.ai/getting-started/platform-overview
- https://opentelemetry.io/blog/2024/otel-generative-ai/
- https://opentelemetry.io/blog/2026/genai-observability/

**Fetch:** OK (Langfuse metrics + cost; LangSmith; Helicone; OTel 2024 + 2026). Langfuse cost page OK no segundo fetch.

**Quote (Langfuse):**
> “Cost and Latency are accurately measured and broken down by user, session, geography, feature, model and prompt version.”

**Quote (LangSmith):**
> “LangSmith automatically records LLM token usage and costs… aggregated metrics in project stats, and in dashboards.”

**Quote (Helicone):**
> “Every request is logged with costs, latency, and errors tracked”

**Quote (OTel 2026):**
> “`gen_ai.client.operation.duration` — histogram of LLM call latencies… `gen_ai.client.token.usage` — histogram of token consumption.”

**Grade:** **PARTIAL**

**Por quê não CONFIRMED:** cost + latency + tokens + errors estão bem documentados no stack. **TTFT** não aparece no corpo fetched dos blogs OTel 2024/2026 (só duration/token.usage). Semconv GenAI ainda “under active development” (OTel 2026). Não travar schema Paperclip em TTFT como sinal P0.

**OUT do P0 metric set:** latency p95, TTFT, raw token count (sem $).

---

### C2-D4-05 — Co-Gym / CowPilot colaboração

**Claim:** Co-Gym e CowPilot medem colaboração além de task success: initiative/controlled autonomy e **human intervention count**.

**Primary URLs:**
- https://arxiv.org/abs/2412.15701
- https://github.com/SALT-NLP/collaborative-gym
- https://arxiv.org/abs/2501.16609

**Fetch:** OK (arXiv abstracts/body via fetch; GitHub README via search/WebFetch)

**Quote (Co-Gym arXiv — initiative + satisfaction):**
> “we introduce Initiative Entropy (Hinit), which quantifies the balance of initiative among team members… Overall Satisfaction… 1–5 Likert scale, complementing the evaluation of task performance.”

**Quote (Co-Gym GitHub — Collab Score / Controlled Autonomy):**
> “Collab Score = 1_Delivered × Task Performance”  
> “Controlled Autonomy: … counting the agent's confirmation questions… and … instances where the human verbally intervenes”

**Quote (CowPilot):**
> “Human intervention count: how many times does the user pause the agent to take actions themselves… Agent step count… Human step count”

**Grade:** **CONFIRMED**

**Notas:** Nomes “Collab Score” / “Controlled Autonomy” estão no README/código do repo (T2), não no abstract arXiv; Initiative Entropy + Overall Satisfaction estão no paper. CowPilot confirma **human intervention count** de forma explícita.

---

### C2-D4-06 — AAAI interdependence ≠ task reward

**Claim:** AAAI “Who Is Helping Whom?”: **task reward alto ≠ cooperação**; interdependence deve ser métrica separada.

**Primary URL:**
- https://ojs.aaai.org/index.php/AAAI/article/view/38787

**Fetch:** OK

**Quote:**
> “we propose the concept of constructive interdependence… as a key metric for evaluating cooperation in human-agent teams… teaming performance is not necessarily correlated with task reward, highlighting that task reward alone cannot reliably measure cooperation”

**Grade:** **CONFIRMED**

**Notas:** Domínio Overcooked / STRIPS — métrica acadêmica. Para produto P0, usar **proxy operacional** (co-touch), não Int_cons STRIPS.

---

### C2-D4-07 — McKinsey / Deloitte paradoxo ROI

**Claim:** McKinsey/Deloitte: adoção gen/agentic alta com **ROI/EBIT fraco** → painéis devem priorizar outcome + cost/outcome, não adoption vanity.

**Primary URLs:**
- https://www.mckinsey.com/capabilities/quantumblack/our-insights/seizing-the-agentic-ai-advantage (PDF Jun 2025)
- https://www.deloitte.com/global/en/issues/ai/ai-roi-the-paradox-of-rising-investment-and-elusive-returns.html

**Fetch:** McKinsey HTML timeout; **PDF OK**. Deloitte OK.

**Quote (McKinsey PDF):**
> “Nearly eight in ten companies report using gen AI—yet just as many report no significant bottom-line impact… the ‘gen AI paradox.’”

**Quote (Deloitte):**
> “Of the respondents already using agentic AI… just ten percent… are currently realizing significant ROI from agentic AI.”

**Grade:** **PARTIAL**

**Por quê:** Premissa empírica (adoção alta / impacto EBIT-ROI fraco) **confirmada**. A seta “→ painéis devem priorizar outcome + cost/outcome” é **prescrição de produto**, não citação normativa das fontes. Fontes de consultoria = marketing-grade; não promover sozinhas a requisito P0. Cost/job já entra via **C2-D4-01 CONFIRMED** (Avg Cost), não via esta claim.

**OUT do P0:** “cost/outcome” e “anti-adoption vanity” como requisitos derivados só de McKinsey/Deloitte.

---

### C2-D4-08 — Gartner cancel + agent washing

**Claim:** Gartner: >40% projetos agentic cancelados até 2027 + **agent washing** → dual panels Path B+ devem rejeitar KPIs de contagem de agentes / ROAS fluff.

**Primary URLs:**
- https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027
- https://www.gartner.com/en/newsroom/press-releases/2025-08-26-gartner-predicts-40-percent-of-enterprise-apps-will-feature-task-specific-ai-agents-by-2026-up-from-less-than-5-percent-in-2025

**Fetch:** OK (ambos). Hype Cycle X3 **não** re-fetched nesta rodada.

**Quote (cancel):**
> “Over 40% of agentic AI projects will be canceled by the end of 2027, due to escalating costs, unclear business value or inadequate risk controls”

**Quote (agent washing — Jun):**
> “Many vendors are contributing to the hype by engaging in ‘agent washing’ – the rebranding of existing products, such as AI assistants, RPA and chatbots”

**Quote (agentwashing — Aug):**
> “The most common misconception is referring to these AI assistants as agents, a misunderstanding known as ‘agentwashing.’”

**Grade:** **PARTIAL**

**Por quê:** Predição de cancelamento + definição de agent washing **CONFIRMADAS**. “Rejeitar KPI # de agentes” e “ROAS fluff” **não** aparecem nos PRs; são inferência Path B+ / blog secundário (X4). Gartner recomenda focar value/ROI e “cost, quality, speed and scale” — útil como anti-hype, insuficiente para CONFIRMED da claim completa.

**OUT do P0 como requisito CONFIRMED:** banimento explícito de ROAS; banimento de “# agents” como KPI (pode constar como **anti-métrica recomendada**, não como claim CONFIRMED).

---

## 4. P0 metric set mínimo (somente CONFIRMED)

> Regra: se a métrica depende de claim PARTIAL → **OUT**.

| Lane | ID | Métrica P0 | Definição operacional | Claim(s) |
|------|-----|------------|----------------------|----------|
| **Human** | P0-Hu-1 | Cycle Time (p50) | Tempo start→complete em issues com owner humano (contrato Linear) | C2-D4-02 |
| **Human** | P0-Hu-2 | Capacity load | Effort/WIP assigned vs capacity por pessoa (Workload-style green/yellow/red) | C2-D4-01 |
| **Agent** | P0-Ag-1 | Avg Cost / job | $ médio por job/run do agente (AI Hub / profile) | C2-D4-01 |
| **Agent** | P0-Ag-2 | Jobs in Progress | Contagem de jobs agentic ativos agora | C2-D4-01 |
| **Agent** | P0-Ag-3 | Human intervention count | Nº de vezes que humano pausa/override por run (CowPilot) | C2-D4-05 |
| **Room** | P0-Rm-1 | Hybrid Cycle Time | open→done no thread/issue com ≥1 hop agentic (mesmo contrato start/complete; status selecionáveis à la Jira) | C2-D4-02, C2-D4-03 |
| **Room** | P0-Rm-2 | Co-touch rate | % issues/threads com ≥1 ação humana **e** ≥1 ação agent no histórico (proxy operacional de interdependence) | C2-D4-06 |

### OUT (não P0 — PARTIAL ou anti-métrica)

| Item | Motivo |
|------|--------|
| Latency p50/p95, TTFT | C2-D4-04 PARTIAL |
| Raw token count | C2-D4-04 PARTIAL; vanity sem $ |
| Error/retry rate como KPI primário | só coberto em C2-D4-04 PARTIAL |
| Cost / done outcome (McKinsey-driven) | C2-D4-07 PARTIAL (Avg Cost já cobre custo via 01) |
| Success rate isolado como “cooperação” | contradiz C2-D4-06 CONFIRMED |
| # de agentes criados | C2-D4-08 PARTIAL (agent washing factual OK; KPI ban = inferência) |
| ROAS / AI marketing lift | C2-D4-08 PARTIAL; não está nos PRs Gartner |
| Collab Score / Controlled Autonomy / Initiative Entropy como KPI de produto | C2-D4-05 CONFIRMED no lab; pesados demais para P0 UI (intervention count basta) |
| Approval latency / review burden (Hu-4/5 draft) | sem claim CONFIRMED nestas 8 |

---

## 5. Implicações Path B+

1. **Dual panel obrigatório:** lane humana (Workload + Cycle Time) **separada** da lane agente (Avg Cost, Jobs in Progress) — gap ClickUp CONFIRMED.  
2. **Contrato de tempo:** adotar definições Linear (Cycle/Lead) + opcionalmente colunas de status Jira para hybrid cycle time.  
3. **HITL first-class:** intervention count no painel Agent/Room; não só success rate.  
4. **Co-touch ≠ success:** Room deve mostrar co-touch rate ao lado de throughput — AAAI.  
5. **Não bloquear P0** em OTel TTFT, McKinsey cost/outcome, ou anti-ROAS Gartner até Cycle 3 aprofundar PARTIALs.

---

## 6. Entrega

| Campo | Valor |
|-------|-------|
| **Path** | `docs/research/slack-a2a-room/cycle-2c-hybrid-confirmation/04-dual-performance-confirm.md` |
| **Score** | **5/8 CONFIRMED** (3 PARTIAL, 0 REFUTED) |
| **P0 metrics** | Hu: Cycle Time, Capacity load · Ag: Avg Cost/job, Jobs in Progress, Intervention count · Rm: Hybrid Cycle Time, Co-touch rate |
| **Próximo** | Cycle 3B `04-dual-performance-metrics.md` — taxonomia Outcome/Collaboration só com CONFIRMED + proxies |
