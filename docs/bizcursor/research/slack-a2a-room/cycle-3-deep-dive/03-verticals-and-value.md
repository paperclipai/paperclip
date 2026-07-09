# Verticais e Valor Empresarial

> **Ciclo:** 3 — Deep dive  
> **Data:** 2026-07-09  
> **Produto-alvo:** Paperclip Conference Room (modo Slack: humanos + `@agente`, A2A fan-out + wait/join)  
> **Base:** grades Cycle 2 (confirmação de fontes primárias) + catálogo Cycle 1 D5  
> **Confiança geral:** Alta nas grades A/B; média em Finance AP / SC early (poucos RCTs)

---

## 1. Critérios de priorização (evidência A/B/C, fit Slack+@, AI proficiency)

Priorizamos verticais pelo **produto que estamos construindo** (sala + `@agents` + orquestração A2A), não por “onde há mais hype de agentes”.

### 1.1 Escala de evidência (Cycle 2)

| Grade | Definição | Uso no GTM |
|-------|-----------|------------|
| **A** | RCT, field experiment causal, ou benchmark independente com método publicado | Pode sustentar beachhead e claims de valor |
| **B** | Case corporativo auditável (press/earnings) **com** correção/nuance posterior, ou framework enterprise útil | Secundário / narrativa honesta; não vender como RCT |
| **C** | Forecast de analista, vendor claim, TEI comissionado, blog sem holdout | Direção de mercado no máximo; **não** beachhead |
| **FLUFF** | Número sem método, denominador ou auditoria | Proibido em pitch / DoD |

### 1.2 Dimensões de score (peso sugerido)

| Dimensão | Peso | Pergunta |
|----------|------|----------|
| **Evidência causal** | 35% | Existe A/B de outcome (tempo, qualidade, retenção)? |
| **Fit Slack + `@`** | 30% | O trabalho já acontece em canal/thread? `@mention` é o gatilho natural? |
| **AI proficiency atual** | 20% | Agentes já resolvem fatia útil *hoje* (não forecast 2030)? |
| **HITL / audit trail** | 15% | Humano no gate é feature (não gambiarra)? Alinha anti-hype Gartner/McKinsey? |

### 1.3 Scorecard Cycle 2 (consolidado)

| Vertical | Evidência | Fit Slack+@ | Proficiency agora | Beachhead P1? |
|----------|-----------|-------------|-------------------|---------------|
| **Software houses** | **A** | Excelente | Alta (com limites METR/Pro) | **Y — #1** |
| **Customer Support Ops** | **B** | Muito bom (ops internos) | Alta em volume rotineiro | **Y — #2** |
| **Recruiting Ops** | **A** | Bom (ops); fraco se voice-first | Alta em screening/voice | **N*** (caveat canal) |
| **Marketing / Content** | **C / FLUFF** | Alto conceitualmente | Fraca (claims ROAS) | **N** |
| **Supply Chain exceptions** | **C** (forecast) | Médio-bom (war room) | Early | **N** (early pilot) |
| **Finance AP exceptions** | **B/C** | Bom (fila + aprovação) | Média-alta em STP/exception | **N** (após P1) |

\*Recruiting tem evidência **A**, mas o win causal (Jabarian) é **voice interview**, não thread Slack — ver §4.

### 1.4 Regra de ouro de messaging

> Vender **ciclo de trabalho auditável no thread** (latência, handoff, custo, aprovação humana), não “autonomia 80%” nem ROAS mágico.

---

## 2. Beachhead: Software Houses

**Grade Cycle 2: A · Phase 1: Y**

Melhor pacote *evidência × fit de produto*. UX “agente como colega” já é mainstream (Claude Tag / Slack agentic / Linear Agents / Cursor `@` em Slack).

### 2.1 Por que beachhead

| Evidência | Claim | Status Cycle 2 |
|-----------|-------|----------------|
| Peng et al. (arXiv 2302.06590) | Copilot RCT **+55,8%** mais rápido (task lab JS) | **A — CONFIRMADO** |
| METR (jul 2025) | Experts em repo próprio: AI-allowed **−19%** (early-2025) | **A — CONFIRMADO** (nuance, não refutação) |
| SWE-Bench Pro (Scale, set/2025) | Frontier ~**23%** no public set | **A — CONFIRMADO** (baseline de dificuldade) |
| Claude Tag 65% PRs | Claim interno Anthropic | **C** se usado sozinho; útil só como prova de **UX Slack** |

**Conflito a não misturar:** Peng (+55% lab) e METR (−19% experts) são **ambos verdadeiros** em contextos diferentes. Pitch honesto: *aceleração em tarefas bem especificadas + review humano obrigatório em repos maduros*.

### 2.2 Personas e agentes típicos

| Papel humano | Agentes na sala | Adapter Paperclip típico |
|--------------|-----------------|--------------------------|
| Tech lead / EM | `@triage`, `@coder`, `@reviewer` | `cursor_cloud` (dev) |
| Founder / Board | `@ceo` (orquestra) | `opencode_local` |
| QA / SRE | `@repro`, `@patch` | `cursor_cloud` |

### 2.3 Cenários concretos (`@agents`)

#### Cenário SH-1 — Bug war room (`#eng-bugs`)

```
Humano: @triage @coder bug: checkout 500 em prod após deploy 14:22
         repro: curl … | logs: Sentry #8821

@triage  → classifica severidade, linka issue, pede wait em @coder
@coder   → draft PR + testes; posta diff no thread
Humano   → aprova merge / pede ajuste
@reviewer → checklist de risco (só se @mencionado)
```

- **A2A:** fan-out `@triage @coder` com `wait:false` + join quando ambos postarem; ou cascade SAS se triage deve terminar antes.
- **Valor:** time-to-first-diff e auditoria no thread — **não** “resolve 80% dos bugs sozinho”.

#### Cenário SH-2 — Spike paralelo (`#eng-spike-auth`)

```
Humano: @researcher @coder @security avaliar OAuth vs session cookies
         para B2B; deadline sexta; @ceo sintetiza

@researcher → comparativo + links
@coder      → PoC mínima em branch
@security   → threat model curto
@ceo        → join + recomendação (humano decide)
```

- **A2A:** paralelo + quorum/join (não barrier cego).
- **Valor:** compressão de discovery com rastreio de quem disse o quê.

#### Cenário SH-3 — Onboarding de feature (`#feat-billing-v2`)

```
Humano: @pm-agent @coder @docs
         spec em /docs/billing.md — implementar webhook idempotente

@pm-agent → checklist de aceite no thread
@coder    → implementação + PR
@docs     → draft changelog (só após @coder done)
```

### 2.4 Métricas de valor (norte)

| Métrica | Baseline típico (sem sala) | Alvo piloto 30–60d | Como medir |
|---------|----------------------------|--------------------|------------|
| Time-to-first-diff após bug report | horas / dias | **−40%** mediana | timestamp humano → 1º PR link no thread |
| Ciclos de ida-e-volta “sumiu no DM” | alto | **−50%** pings fora do canal | contagem de handoffs fora da sala |
| % PRs com testes citados no thread | baixo | **≥70%** | checklist no join |
| Custo por sessão / thread | opaco | **100% visível** | F3 / cost-events |
| Taxa de revert pós-merge agent-assisted | — | **≤ baseline humano** | git + tag `agent-assisted` |

### 2.5 Definition of Done de valor (piloto Software House)

Um piloto beachhead está **Done** quando **todos** forem verdadeiros:

1. **≥1 sala** (`#eng-*`) com ≥3 agentes `@mencionáveis` e silent-until-`@`.
2. **≥20 threads** reais em 30 dias com fan-out ou cascade documentado.
3. Mediana **time-to-first-diff** melhor que baseline da equipe (amostra ≥10 bugs comparáveis).
4. **100%** das ações agentic com humano owner visível no thread (approve / reject / revise).
5. Nenhum claim de “SWE-bench 90% = produção”; messaging alinhado a Pro ~23% + METR nuance.
6. Board vê **custo por thread** (desbloqueio F3 / equivalente no fork).

**Anti-DoD:** “agente mergeou sozinho em main” sem gate humano.

---

## 3. Secundário: Customer Support Ops

**Grade Cycle 2: B · Phase 1: Y (2º)**

Evidência de **volume real** (Klarna) + **correção híbrida** pública = narrativa vendável e honesta. Não é RCT; é case B forte.

### 3.1 Evidência (não exagerar)

| Claim | Fonte | Uso correto |
|-------|-------|-------------|
| 2,3M conversas = **2/3** dos chats; ~700 FTE eq.; &lt;2 min vs 11 | Klarna press, 27 fev 2024 | Prova de **escala em rotina** |
| Reinvestimento em humanos / qualidade | Bloomberg / CX Dive, mai 2025+ | Prova de que **híbrido** é estado estável |
| Multi-agent LangGraph (Klarna) | LangChain customer story | Prova de **orquestração**, não de ROI Slack |

**Narrativa proibida:** “substitui 700 agentes”.  
**Narrativa correta:** “AI no volume rotineiro + humano no VIP/complexo, com resumo no thread”.

### 3.2 Cenários concretos

#### Cenário CS-1 — L1 ops room (`#support-l1`)

```
Sistema/webhook: ticket #4412 — chargeback parcial
Humano (lead): @triage-support @policy @refund-agent resumir e propor

@triage-support → intent + risco + idioma
@policy         → regra de elegibilidade (KB)
@refund-agent   → draft de ação (não executa se $ > limiar)
Humano          → aprova execução ou escala VIP
```

#### Cenário CS-2 — Escalation com contexto (`#support-vip`)

```
@triage-support: preciso de humano — cliente enterprise, 3rd chargeback
Humano: @cx-lead tomando; @triage-support silent até eu @mencionar de novo
```

- Padrão produto: **silent-until-@** + human owner (alinha Claude Tag / Linear).

#### Cenário CS-3 — War room de incidente CX (`#cx-incident`)

```
Humano: @status @comms @triage-support outagem gateway pagamentos
@status  → status page draft
@comms   → macros multi-idioma
@triage-support → fila: auto-reply vs hold
```

### 3.3 Métricas e DoD (secundário)

| Métrica | Alvo piloto |
|---------|-------------|
| % tickets L1 com 1ª resposta agentic &lt; 2 min | ≥60% |
| % escalations com resumo estruturado no thread | ≥90% |
| CSAT / quality em amostra humana | ≥ baseline pré-piloto |
| “Always human option” documentada | obrigatório |

**DoD:** híbrido medido; sem corte cego de headcount como KPI único.

---

## 4. Terciário: Recruiting Ops (com caveat voice)

**Grade Cycle 2: A · Phase 1: N\* (para room Slack genérico)**

### 4.1 Caveat crítico (não negociável no pitch)

O field experiment **Jabarian & Henkel (N≈70k)** mostra ganhos causais em **entrevistas por voz com IA** (+12% offers; melhor start/retention; decisão final humana). Isso **não** se traduz automaticamente em “AI entrevista no Slack”.

| O que a evidência A prova | O que NÃO prova |
|---------------------------|-----------------|
| Voice AI screening em escala, com HITL na oferta | Que thread Slack substitui entrevista |
| Padronização + preferência do candidato quando escolhe AI | Que multi-agente de chat = mesmo efeito |

**Regra:** Recruiting entra como **ops room** (agenda, scorecard, debrief), não como clone do resultado Jabarian.

### 4.2 Cenários concretos (adjacentes, honestos)

#### Cenário RC-1 — Hiring ops (`#recruiting-ops`)

```
Humano (recruiter): @scheduler @screener @debrief
  candidata Ana — role Backend; transcript voice-AI já no Drive

@scheduler → slots + calendar
@screener  → scorecard estruturado a partir do transcript
@debrief   → perguntas para o hiring manager
Humano     → decide advance / reject (sempre)
```

#### Cenário RC-2 — Painel de entrevista (`#panel-backend-q3`)

```
Humano: @note-taker @rubric após live call
@note-taker → notas por competência
@rubric     → gaps vs JD
Humano      → calibração do painel
```

### 4.3 Quando virar Y de beachhead

Só se o produto for **RPO / voice-first** com integração de entrevista, não Conference Room Slack genérico.

---

## 5. Conteúdo / Marketing Agencies (guardrails — não beachhead)

**Grade Cycle 2: C / FLUFF · Phase 1: N**

Demanda de “war room de campanha” é alta; **evidência pública de ROAS agentic é fraca**.

### 5.1 O que é FLUFF

| Claim típico | Problema |
|--------------|----------|
| “+61% ROAS vs half human” (vendor blog) | Sem protocolo, período, N de contas, holdout |
| “342% ROI” Forrester TEI comissionado (ex. Jasper) | Eficiência de conteúdo ≠ incrementality de mídia |
| “Hilton autonomous agents” em site de agência | Sem auditoria independente |

### 5.2 Guardrails de produto (se cliente insistir)

1. **Proibir** KPI de ROAS/ROI de mídia como DoD do piloto.
2. Permitir só outcomes de **ops**: tempo-até-brief, variantes geradas, % assets com brand-check humano.
3. Gates obrigatórios: `@brand-check` + aprovação humana antes de publish.
4. Claims regulados (saúde, finanças, kids) → agente **não** posta sem humano.

### 5.3 Cenário permitido (ops, sem ROAS)

```
#campaign-ops
Humano: @brief @copy @brand-check lançamento SKU-X — tom sóbrio, sem superlativos médicos

@brief       → brief estruturado
@copy        → 3 variantes
@brand-check → flags de compliance
Humano       → escolhe variante; publica fora da sala ou via integração com gate
```

**Posicionamento:** “acelerador de content ops com auditoria”, **nunca** “agente que sobe ROAS”.

---

## 6. Supply Chain exception rooms (early)

**Grade Cycle 2: C · Phase 1: N (early only)**

### 6.1 O que a evidência é (e não é)

| Fonte | O que diz | O que NÃO diz |
|-------|-----------|---------------|
| Gartner PR 21 mai 2025 | **50%** das soluções SCM cross-functional **incluirão** agentic AI até **2030** | Que IA já opera 50% da supply chain com ROI |
| McKinsey ops anedotas / vendor cases | Dispatcher assist, exception triage | RCT de proficiency atual |
| SCMR / analistas | Mainstream ainda a anos | Autonomia plena de planning |

**Uso correto:** direção estratégica + piloto de **exception room** onde dados/ERP já existem.  
**Uso incorreto:** “Gartner 50%” como proof of value no deck Phase 1.

### 6.2 Cenário early (`#procurement-exceptions`)

```
ERP webhook: PO #8891 — preço +18% vs contrato
Humano: @triage-sc @buyer @planner threshold $10k

@triage-sc → classifica (preço / lead time / qualidade)
@buyer     → draft renegociação / alternate vendor
@planner   → impacto em MPS (read-only)
Humano     → aprova se $ > limiar (sempre)
```

### 6.3 Condições de entrada

- Integrações ERP/TMS/WMS mínimas (senão a sala vira chat vazio).
- Limiares $ e playbooks explícitos (Gartner: “define operational parameters”).
- Sem autonomia de emitir PO sem gate.

---

## 7. Finance AP exceptions

**Grade Cycle 1/2: B/C · Phase 1: N (após beachhead SE + governança de custo)**

Fit forte com **HITL + audit trail** (Action Center / approval), alinhado a anti-hype. Evidência mais de automação STP/RPA agentic (UiPath etc.) do que de RCT Slack.

### 7.1 Cenário (`#ap-exceptions`)

```
Invoice ingest: vendor ACME — amount ≠ PO line
Humano (AP): @extract @match @approver

@extract  → campos + confiança OCR
@match    → 2/3-way match diff
@approver → pede humano se variance > 2% ou > $500
Humano    → approve / reject / request credit note
```

### 7.2 Por que não beachhead

- Compliance/SOX: erro custa caro; ciclo de venda enterprise longo.
- Valor depende de conectores ERP — fora do núcleo Slack+A2A inicial.
- Entra quando F3 (custos) + papéis/approvals (F5) estiverem sólidos.

### 7.3 Métricas

| Métrica | Alvo |
|---------|------|
| % faturas STP (straight-through) | + vs baseline |
| Tempo médio em exception queue | −30% |
| % ações agentic sem aprovação acima do limiar | **0** |

---

## 8. Matriz fase × vertical (quais fases desbloqueiam qual vertical)

Duas lentes: **(A)** fases GTM do Conference Room Slack-mode; **(B)** capacidades BizCursor/Paperclip F0–F6 que desbloqueiam valor.

### 8.A — Fases GTM do produto sala+@

| Fase GTM | Capacidade mínima | Verticais desbloqueadas | Verticais ainda bloqueadas |
|----------|-------------------|-------------------------|----------------------------|
| **P0 — Foundation** | Auth, agentes listáveis, 1:1 chat | Demo interna só | Todas para valor medido |
| **P1 — Slack-mode MVP** | Canal, `@mention`, silent-until-@, thread async, human owner | **Software houses (beachhead)** | Support em escala, AP, SC |
| **P2 — A2A nativo** | Fan-out `@A @B`, wait/join, trace | Software **spikes paralelos**; Support L1 multi-agent | SC/AP sem conectores |
| **P3 — Cost + roles** | Custo/thread, budget, papéis, approvals | **Support Ops** (secundário); Finance AP exceptions | SC enterprise |
| **P4 — Memory + tasks** | PARA/contexto, issues/tasks, notif | Recruiting **ops** (terciário); Content ops com gates | Voice recruiting (produto aparte) |
| **P5 — Vertical packs** | Conectores ERP/TMS/CRM + playbooks | SC exception rooms (early); AP profundos | Marketing ROAS (nunca como pack de “valor causal”) |

### 8.B — Cruzamento com roadmap BizCursor F0–F6

| Capacidade | Fase repo | Software | Support | Recruiting ops | Marketing* | SC early | Finance AP |
|------------|-----------|----------|---------|----------------|------------|----------|------------|
| Conexão Coolify + secrets | **F0** | prep | prep | prep | prep | prep | prep |
| Chat + histórico | **F1** | demo 1:1 | — | — | — | — | — |
| A2A delegation + trace | **F2** | **desbloqueia beachhead multi-agent** | triagem multi-agent | debrief multi-agent | brief paralelo | triage paralelo | extract+match |
| Custos / budget | **F3** | DoD custo/thread | custo/ticket | custo/hire-ops | custo/campanha (ops) | custo/exception | **crítico** |
| Memória PARA | **F4** | prefs de repo/style | macros/KB prefs | rubrics | brand voice | playbooks | vendor prefs |
| Tasks + notif + roles | **F5** | PR/issue opcional | SLA + escalate | pipeline stages | approval queue | $ threshold tasks | **approver role** |
| Release / polish | **F6** | piloto pagante | piloto #2 | opcional | só com guardrails | early design partner | design partner |

\*Marketing: desbloqueio técnico ≠ permissão de claim ROAS.

### 8.C — Ordem recomendada de go-to-market

```
P1 Software ──► P2 A2A depth (mesmo vertical)
        │
        └──► P3 Support Ops (narrativa híbrida)
                │
                ├──► P4 Recruiting ops (sem voice claim)
                ├──► P4/P5 Finance AP exceptions
                └──► P5 SC exception rooms (early, data-ready)
                         │
                         └── Marketing/Content: only ops KPIs + brand gate
```

---

## 9. Anti-hype (Gartner 40%, McKinsey mesh)

Usar estes materiais como **guarda-corpo de messaging e arquitetura**, não como vertical de receita.

### 9.1 Gartner — &gt;40% projetos agentic cancelados até fim de 2027

- **Fonte:** [Gartner PR, 25 jun 2025](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)
- **Motivos citados:** custos crescentes, valor de negócio unclear, risk controls inadequados; muitos PoCs movidos a hype; “agent washing”.
- **Implicação para Conference Room:**
  - Escopo estreito (1 vertical, 1 sala, KPIs de ciclo).
  - ROI = latência/qualidade/custo **medidos**, não autonomy theater.
  - Preferir assistente/automação quando agentic for overkill (citação Gartner: muitos use cases “agentic” não precisam ser).

### 9.2 McKinsey — Agentic AI mesh + gen-AI paradox

- **Fontes:** [Seizing the agentic AI advantage (jun 2025)](https://www.mckinsey.com/capabilities/quantumblack/our-insights/seizing-the-agentic-ai-advantage) · [PDF](https://www.mckinsey.com/~/media/mckinsey/business%20functions/quantumblack/our%20insights/seizing%20the%20agentic%20ai%20advantage/seizing-the-agentic-ai-advantage-june-2025.pdf) · [QuantumBlack — Agentic AI Mesh](https://medium.com/quantumblack/how-we-enabled-agents-at-scale-in-the-enterprise-with-the-agentic-ai-mesh-architecture-baf4290daf48)
- **Ideias úteis:** mesh = orquestração + governança + vendor-agnostic; risco de agent sprawl / autonomy drift; desafio maior é **humano** (trust, adoption, governance).
- **Implicação para Paperclip:**
  - A2A + sala com `@` = pedaço do “mesh” operacional (delegação, contexto compartilhado, observabilidade via trace).
  - Não espalhar dezenas de agentes sem owner, budget (F3) e roles (F5).
  - Alinhar a padrões abertos (A2A/MCP) como McKinsey descreve no mesh.

### 9.3 Tradução em uma frase de pitch

> “Scoped agents, clear cycle metrics, human gate — porque &gt;40% dos projetos agentic morrem por hype, custo e risco; nós vendemos a sala onde o trabalho e a aprovação ficam visíveis.”

---

## 10. Fontes

### 10.1 Software / engenharia

| ID | Fonte | Grade | URL |
|----|-------|-------|-----|
| SE-01 | Peng et al. — Copilot RCT (+55,8%) | A | https://arxiv.org/abs/2302.06590 |
| SE-02 | GitHub Blog — resumo do experimento | B | https://github.blog/news-insights/research/research-quantifying-github-copilots-impact-on-developer-productivity-and-happiness/ |
| SE-04 | METR — experienced devs −19% (early 2025) | A | https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/ |
| SE-04b | METR uplift update (fev 2026) | A | https://metr.org/blog/2026-02-24-uplift-update/ |
| SE-05 | SWE-Bench Pro (Scale / arXiv) | A | https://arxiv.org/abs/2509.16941 · https://scale.com/blog/swe-bench-pro |
| SE-08 | Anthropic Claude Tag (UX Slack; 65% = claim interno) | B/C | https://www.anthropic.com/news/introducing-claude-tag |
| SE-09 | Slack — agentic collaboration | B | https://slack.com/blog/news/powering-agentic-collaboration |

### 10.2 Support

| ID | Fonte | Grade | URL |
|----|-------|-------|-----|
| CS-01 | Klarna — 2/3 chats (fev 2024) | B | https://www.klarna.com/international/press/klarna-ai-assistant-handles-two-thirds-of-customer-service-chats-in-its-first-month/ |
| CS-02 | OpenAI — Klarna customer story | B | https://openai.com/index/klarna/ |
| CS-04 | CX Dive — rehire / hybrid | B | https://www.customerexperiencedive.com/news/klarna-reinvests-human-talent-customer-service-AI-chatbot/747586/ |

### 10.3 Recruiting

| ID | Fonte | Grade | URL |
|----|-------|-------|-----|
| RC-01 | Jabarian & Henkel — Voice AI, N≈70k | A | https://brianjabarian.org/voiceai · SSRN https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5395709 |
| RC-01b | Chicago Booth Review — cobertura | B | https://www.chicagobooth.edu/review/does-ai-beat-humans-recruiting |

### 10.4 Marketing / content (guardrails)

| ID | Fonte | Grade | URL |
|----|-------|-------|-----|
| MK-TEI | Jasper / Forrester TEI 342% ROI (comissionado) | C/FLUFF p/ ROAS | https://www.prnewswire.com/news-releases/marketing-teams-achieved-342-roi-with-jasper-according-to-total-economic-impact-study-302552457.html |
| MK-crit | Crítica método ROAS agentic | C | https://adpulse.com/the-rise-of-ai-agentic-marketing-and-actual-roi/ |

### 10.5 Supply chain / finance

| ID | Fonte | Grade | URL |
|----|-------|-------|-----|
| SC-01 | Gartner — 50% SCM solutions agentic até 2030 | C (forecast) | https://www.gartner.com/en/newsroom/press-releases/2025-05-21-gartner-predicts-half-of-supply-chain-management-solutions-will-include-agentic-ai-capabilities-by-2030 |
| FI-01 | UiPath — invoice automation / AP | B/C | https://www.uipath.com/solutions/department/finance-and-accounting-automation/invoice-automation |

### 10.6 Anti-hype / enterprise

| ID | Fonte | Grade | URL |
|----|-------|-------|-----|
| ENT-01 | Gartner — &gt;40% agentic projects canceled by 2027 | B (forecast) | https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027 |
| ENT-02 | McKinsey — Seizing the agentic AI advantage | B | https://www.mckinsey.com/capabilities/quantumblack/our-insights/seizing-the-agentic-ai-advantage |
| ENT-02b | PDF jun 2025 | B | https://www.mckinsey.com/~/media/mckinsey/business%20functions/quantumblack/our%20insights/seizing%20the%20agentic%20ai%20advantage/seizing-the-agentic-ai-advantage-june-2025.pdf |
| ENT-03 | QuantumBlack — Agentic AI Mesh | B | https://medium.com/quantumblack/how-we-enabled-agents-at-scale-in-the-enterprise-with-the-agentic-ai-mesh-architecture-baf4290daf48 |

### 10.7 Trilha interna desta pesquisa

| Doc | Papel |
|-----|-------|
| `docs/research/slack-a2a-room/cycle-1-discovery/00-INDEX.md` | D5 verticais — catálogo inicial |
| `docs/research/slack-a2a-room/cycle-2-confirmation/00-INDEX.md` | Grades A/B/C confirmadas; Marketing = FLUFF; beachhead SE |

---

## Veredito (Cycle 3)

1. **Beachhead:** Software houses — grade **A**, fit Slack+@ máximo, DoD = ciclo de PR/bug no thread.  
2. **Secundário:** Support Ops — grade **B**, narrativa **híbrida** (Klarna 2/3 + walk-back).  
3. **Terciário:** Recruiting Ops — grade **A** com **caveat voice** (não vender Jabarian como feature Slack).  
4. **Não beachhead:** Marketing/Content (FLUFF ROAS); SC (forecast 2030); AP (após governança).  
5. **Anti-hype obrigatório** em todo pitch: Gartner &gt;40% cancel + McKinsey mesh (scoped, governed, human trust).

**NotebookLM:** GO — pesquisa BizCursor/Paperclip sem overlap de processo Villa (CD/Stock/Financial).
