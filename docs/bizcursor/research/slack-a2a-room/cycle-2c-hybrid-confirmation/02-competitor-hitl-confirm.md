# Cycle 2C / Agent #2 — Competitor & HITL confirmation (Path B+)

> **Data:** 2026-07-09  
> **Fonte discovery:** [`../cycle-1c-hybrid-discovery/02-competitor-hitl-sources.md`](../cycle-1c-hybrid-discovery/02-competitor-hitl-sources.md)  
> **Método:** WebFetch docs primárias + citação literal; grades CONFIRMED | PARTIAL | REFUTED | UNKNOWN  
> **NotebookLM:** skip (non-Villa) — competitor HITL / Path B+ product research  
> **Confiança geral:** alta (Linear, Claude Tag, Cursor, Asana, GitHub docs); média-alta em Plane (marketing + docs de integração Cursor; sem AIG equivalente)

## Resumo executivo

Das Top 8 claims, **7 CONFIRMED** e **1 PARTIAL** (0 REFUTED / 0 UNKNOWN). O eixo de accountability **Linear assignee-humano + delegate-agente** está solidamente documentado (docs + AIG + blog SDK + API `delegate`). Claude Tag confirma multiplayer **anyone-can-tag / anyone-can-steer** com capabilities por **canal** (agent identity). Cursor confirma intake `@cursor` (Slack) e delegate/`@Cursor` (Linear), com follow-up **owner-gated no Slack**. Asana e GitHub confirmam “pedir trabalho à IA” via assign/@mention sem split Linear. **Plane confirma** o modelo concorrente “agent as assignee / same as teammate / step in as owners” — **não refuta Linear**; é o anti-padrão de accountability para D-12.

**Score:** **7/8 CONFIRMED + 1 PARTIAL** → **87.5%** (tratar PARTIAL como 0.5 → **7.5/8**).

---

## Summary table

| # | Claim (resumo) | Grade | Confiança | Fonte âncora |
|---|----------------|-------|-----------|--------------|
| 1 | Linear: assignee humano accountable vs delegate agente executor | **CONFIRMED** | Alta | [assigning-issues](https://linear.app/docs/assigning-issues), [agents-in-linear](https://linear.app/docs/agents-in-linear), [developers/agents](https://linear.app/developers/agents) |
| 2 | AIG: “An agent cannot be held accountable” é princípio de produto | **CONFIRMED** | Alta | [AIG](https://linear.app/developers/aig), [SDK blog 2025-08-01](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk) |
| 3 | Claude Tag: anyone tags + anyone steers sem re-mention | **CONFIRMED** | Alta | [how-it-works](https://claude.com/docs/claude-tag/concepts/how-it-works), [Help](https://support.claude.com/en/articles/15594475-what-is-claude-tag) |
| 4 | Claude Tag: capabilities seguem o canal (agent identity), não o tagger | **CONFIRMED** | Alta | [how-it-works](https://claude.com/docs/claude-tag/concepts/how-it-works), [agent-identity blog 2026-06-24](https://claude.com/blog/agent-identity-access-model) |
| 5 | Cursor: `@cursor` Slack / assign·`@Cursor` Linear; follow-ups do owner | **PARTIAL** | Alta (Slack) / Média (Linear owner) | [Slack](https://cursor.com/docs/integrations/slack), [Linear](https://cursor.com/docs/integrations/linear) |
| 6 | Asana: assign + @mention + rules/forms = stack canônico (sem split delegate) | **CONFIRMED** | Alta | [Triggering AI Teammates](https://help.asana.com/s/article/triggering-ai-teammates?language=en_US) |
| 7 | GitHub Copilot cloud: assign issue → PR; prompt → branch+iterate | **CONFIRMED** | Alta | [Kick off a task](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task) |
| 8 | Plane: agentes como assignees “same as any teammate” (contraste Linear) | **CONFIRMED** | Média-alta | [plane.so/ai](https://plane.so/ai), [plane.so/agents](https://plane.so/agents), [Cursor integration](https://docs.plane.so/integrations/cursor) |

**Contagem:** CONFIRMED 7 · PARTIAL 1 · REFUTED 0 · UNKNOWN 0

---

## Claim-by-claim

### Claim 1 — Linear assignee (humano) vs delegate (agente)

**Grade: CONFIRMED** · Confiança: **alta**

**Citação literal:**

> “Users can delegate issues to agents, allowing the agent to work on an issue while the assigned teammate maintains ownership.”  
> — https://linear.app/docs/assigning-issues (fetched 2026-07-09)

> “Delegate an issue to an agent while keeping a human teammate as the assignee. The assignee remains responsible for the work, while the agent contributes on their behalf.”  
> — https://linear.app/docs/assigning-issues

> “Agents are not traditional assignees. Assigning an issue to an agent triggers delegation—the agent acts on the issue, but the human teammate remains responsible for its completion.”  
> — https://linear.app/docs/agents-in-linear

> “Assigning an issue to your app now sets it as the `delegate`, not the `assignee`—so humans maintain ownership while agents act on their behalf.”  
> — https://linear.app/developers/agents

**Nota UX:** a UI ainda usa o verbo “assign” ao agente; semanticamente isso **dispara delegation**, não transferência de accountability.

---

### Claim 2 — AIG “An agent cannot be held accountable”

**Grade: CONFIRMED** · Confiança: **alta**

**Citação literal:**

> “An agent cannot be held accountable”  
> “There should be a clear delegation model between humans and agents. An agent can carry out tasks, but the final responsibility should always remain with a human.”  
> — https://linear.app/developers/aig (Principles & practices)

> “It creates a clean taxonomy: issues can only be assigned to humans, and only delegated to agents. That reflects a core tenet of our Agent Interaction Guidelines: an agent cannot be held accountable.”  
> — https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk (Leela Senthil Nathan, **2025-08-01**)

Princípio de produto + implementação (campo `delegate`), não copy isolado de marketing.

---

### Claim 3 — Claude Tag: anyone tags + anyone steers

**Grade: CONFIRMED** · Confiança: **alta**

**Citação literal:**

> “Anyone in the channel can do it.”  
> (contexto: start session com `@Claude`)  
> — https://claude.com/docs/claude-tag/concepts/how-it-works

> “Anyone in the channel can steer a running session by replying in its thread, not just the person who started it. … Without re-mentioning `@Claude` or starting over…”  
> — https://claude.com/docs/claude-tag/concepts/how-it-works

> “Everyone in a channel works with the same Claude, so anyone can steer it or pick up where it left off.”  
> — https://support.claude.com/en/articles/15594475-what-is-claude-tag

**Nuance (não rebaixa para PARTIAL):** Enterprise **Member Access** / RBAC pode restringir *quem pode invocar* Claude Tag (“open to anyone… / org / role”). O default documentado do canal continua anyone-can-tag/steer; o admin pode apertar o gate.

---

### Claim 4 — Claude Tag: access segue o canal (agent identity)

**Grade: CONFIRMED** · Confiança: **alta**

**Citação literal:**

> “Access follows the channel, not the person”  
> “What it can reach follows the channel, not the user.”  
> — https://claude.com/docs/claude-tag/concepts/how-it-works

> “Which ones a session gets follows the channel, not the person asking.”  
> — https://claude.com/docs/claude-tag/concepts/how-it-works (Channel access)

> “Agent identity replaces the question ‘what can this user do?’ with ‘what can this agent do in this compartment?’ … a channel member without direct access to the repo can ask Claude to read that repo, if the channel’s profile grants Claude that permission.”  
> — https://claude.com/blog/agent-identity-access-model (**2026-06-24**)

> “In a channel where Claude Tag is active, Claude isn’t acting on behalf of a single user. It has its own account in each system it touches…”  
> — https://claude.com/blog/agent-identity-access-model

**Nuance:** DMs usam connectors do usuário; claim aplica-se a **canais**. Enterprise RBAC controla invocação, não reverte o modelo de capabilities por canal.

---

### Claim 5 — Cursor Cloud: intake Slack/Linear + follow-ups do owner

**Grade: PARTIAL** · Confiança: **alta** (Slack) / **média** (owner-only no Linear)

**Citação literal — Slack (CONFIRMED):**

> “With Cursor's integration for Slack, you can use Cloud Agents to work on your tasks directly from Slack by mentioning `@cursor` with a prompt.”  
> — https://cursor.com/docs/integrations/slack

> “`@Cursor [prompt]` — Start a Cloud Agent. In threads with existing agents, adds followup instructions”  
> “In threads with existing agents, `@Cursor [prompt]` adds followup instructions (**only works if you own the agent**). Use `@Cursor agent [prompt]` to launch a separate agent.”  
> — https://cursor.com/docs/integrations/slack

**Citação literal — Linear (CONFIRMED intake; owner-gate não explícito):**

> “Use Cloud Agents directly from Linear by delegating issues to Cursor or mentioning `@Cursor` in comments.”  
> “Click assignee field → Select ‘Cursor’”  
> “Simply mention `@Cursor` in a Linear comment to provide additional guidance to a running Cloud Agent.”  
> — https://cursor.com/docs/integrations/linear

> “Triage rules … Linear requires a human assignee for rules to fire, though this requirement may be removed in future updates.”  
> — https://cursor.com/docs/integrations/linear

**Por que PARTIAL:** (1) Intake Slack + Linear confirmados. (2) Follow-up **owner-only** está explícito no Slack; no Linear a doc diz “mention `@Cursor`” sem restringir ao owner. (3) Triage rules ainda pedem human assignee — alinhado a D-12, mas é nota de produto Linear, não Cursor.

---

### Claim 6 — Asana AI Teammates: assign + @mention + rules/forms

**Grade: CONFIRMED** · Confiança: **alta**

**Citação literal:**

> “AI Teammates collaborate like any other team member. You can assign them tasks, mention them in comments with questions or instructions…”  
> — https://help.asana.com/s/article/triggering-ai-teammates?language=en_US

> “Assign a task directly to your AI Teammate.”  
> “You can @mention your AI Teammate in any task comment…”  
> “You can use Asana rules and forms to trigger your AI Teammate automatically.”  
> — https://help.asana.com/s/article/triggering-ai-teammates?language=en_US

Sem taxonomia assignee/delegate tipo Linear nas docs de trigger. Stack canônico de pedido humano→IA no work graph: **assign + @mention + automation**.

---

### Claim 7 — GitHub Copilot cloud agent: assign → PR; prompt → branch+iterate

**Grade: CONFIRMED** · Confiança: **alta**

**Citação literal:**

> “Assigning an issue always creates a pull request. Starting with a prompt works on a branch by default, giving you a chance to review, steer, and iterate before you open a pull request.”  
> — https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task

> “Assigning an issue always creates a pull request. Copilot works on the task and requests your review when it finishes.”  
> — mesma página (Assign an issue to Copilot)

> “You can assign Copilot cloud agent to straightforward issues on your backlog by selecting ‘Copilot’ as the assignee.”  
> — https://docs.github.com/copilot/concepts/agents/cloud-agent/about-cloud-agent

Padrão tracker → agente → artefato revisável (PR/branch) confirmado. Accountability humana implícita via review de PR, sem AIG explícito.

---

### Claim 8 — Plane: assignee “same as any teammate” vs Linear delegate

**Grade: CONFIRMED** (posicionamento Plane + contraste com Linear) · Confiança: **média-alta**  
**Não é REFUTED de Linear** — é modelo **concorrente**.

**Citação literal — Plane:**

> “Add an agent as an assignee. Same as any teammate. It reads the item, picks up context, and does the work.”  
> — https://plane.so/ai (fetched 2026-07-09)

> “On assign — They step in as owners, analyzing scope, running checklists, coordinating next steps…”  
> — https://plane.so/agents

> “either by assigning Cursor as a work item assignee or by mentioning `@cursor` in a comment.”  
> “Cursor appears in the assignee picker like any other team member once the integration is installed.”  
> — https://docs.plane.so/integrations/cursor

**Contraste Linear (já confirmado nas claims 1–2):**

> “issues can only be assigned to humans, and only delegated to agents.”  
> — Linear SDK blog

| Dimensão | Linear | Plane (docs/marketing) |
|----------|--------|------------------------|
| Campo | `assignee` humano + `delegate` agente | Agente no **Assignees** |
| Linguagem | “cannot be held accountable” | “same as any teammate” / “step in as owners” |
| HITL accountability | Explícita (AIG) | Audit trail + “team reviews”; sem split owner/delegate documentado |

**Implicação:** Claim 8 **confirma** que existe produto mainstream com agent-as-assignee. Para Path B+ / **D-12**, isso **não** autoriza copiar Plane: Linear + AIG permanecem a referência de accountability.

---

## Implicações para D-12 (assign-as-delegate) e UX de work-request

### D-12 — Assign-as-delegate (travar)

| Evidência | Ação de produto |
|-----------|-----------------|
| Linear docs + API `delegate` + AIG | **Manter D-12:** `ownerUserId` (humano) + `delegateAgentId` (agente). Agente nunca é único dono. |
| Plane “same as teammate” / “as owners” | Tratar como **anti-padrão** de accountability; UI pode *parecer* assign, mas modelo de dados = delegate. |
| Cursor Linear triage: “requires a human assignee” | Reforça owner humano mesmo em automação. |
| GitHub/Asana assign-to-agent | Aceitável como **affordances de intake**; accountability via review humano (PR / activity), mas Path B+ deve **expor** owner+delegate na UI (não só implícito). |

### UX de human work-request (stack Path B+)

Ordem sugerida (alinhada Cycle 1B/3B, agora com grades Cycle 2C):

1. **`@mention` na Room** (Claude Tag pattern — anyone tags / anyone steers; capabilities por superfície/canal, não por requester) — Claim 3–4 CONFIRMED.  
2. **Assign-as-delegate no issue** (Linear pattern — D-12) — Claims 1–2 CONFIRMED; Claim 8 = contraste a evitar no modelo.  
3. **Ask / Pedir ao agente** (botão de baixa fricção) — Asana/monday-style assign trigger — Claim 6 CONFIRMED.  
4. **Templates / forms / rules** — Asana rules/forms — Claim 6 CONFIRMED.

**Steer multiplayer vs owner-gated follow-up:**

| Superfície | Padrão confirmado | Path B+ |
|------------|-------------------|---------|
| Claude Tag thread | Anyone steers | Room: silent-until-@ + steer coletivo no thread |
| Cursor Slack | Follow-up só se **owner** do agent | Work-request assíncrono: owner do run; Room pode divergir (multiplayer) |
| Cursor Linear | `@Cursor` follow-up (owner não explícito) | Preferir D-12 + mention; não assumir anyone-steers no issue agent session |

**Não copiar cegamente:** Plane agent-as-owner; Cursor Slack owner-only se a Room for multiplayer Claude-style (conflito de modelo — Room = Claude; issue delegate session = Linear/Cursor).

---

## Lacunas / incertezas

| Lacuna | Impacto | Próximo passo |
|--------|---------|---------------|
| Plane docs.plane.so/ai/plane-ai timeout no fetch | Baixo — marketing + Cursor integration bastam para Claim 8 | Re-fetch Ask vs Build se Cycle 3 precisar |
| Cursor Linear: follow-up owner-only? | Médio para UX de issue session | Observar produto / SDK; não inventar |
| Asana access-control intersection (fonte #18) | Baixo para D-12; alto para security | Cycle 3 se HITL de permissões for escopo |
| Claims reserva 9–11 (Manus, monday, A2A) | Fora do Top 8 | Bandwidth Cycle 2C+ se necessário |

---

## Score final

| Métrica | Valor |
|---------|-------|
| Claims avaliadas | 8 |
| CONFIRMED | 7 |
| PARTIAL | 1 (#5 Cursor owner follow-up cross-surface) |
| REFUTED | 0 |
| UNKNOWN | 0 |
| **Score** | **7.5 / 8 (87.5%)** |

**Path do artefato:**  
`/Users/macbook/Projects/bizcursor/docs/research/slack-a2a-room/cycle-2c-hybrid-confirmation/02-competitor-hitl-confirm.md`
