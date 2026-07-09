# Cycle 1C / D2 — Competitor & HITL source catalog (Path B+)

> **Data da coleta:** 2026-07-09  
> **Escopo:** padrões de pedido humano→IA, accountability (delegate vs assignee), multiplayer steer, roster híbrido  
> **Método:** WebSearch + WebFetch; URLs inventadas proibidas  
> **Confiança geral:** alta nas docs oficiais Linear / Claude Tag / Cursor / GitHub / Asana; média em marketing Plane / Height / monday (claims de produto sem SPEC pública equivalente)

## Resumo executivo

Para Path B+ (painel híbrido humano+IA), as fontes mais densas são: **Linear** (assignee humano + delegate agente; “agent cannot be held accountable”), **Claude Tag** (qualquer um no canal tagueia e qualquer um steera o thread), **Cursor Cloud** (`@cursor` Slack / assign Linear), **Asana AI Teammates** (assign + @mention como colega), **GitHub Copilot cloud agent** (assign issue → PR/branch). Notion/monday/Plane/Height reforçam roster/triggers, mas com menos precisão de accountability. Manus Collab + Slack `@Manus` cobrem multiplayer 1-task. OpenAI Agents HITL e A2A `input-required` são SECONDARY de orquestração (não UI de team panel).

---

## Catálogo de fontes

| # | Tier | Produto / domínio | Título | URL | Data? | Why it matters |
|---|------|-------------------|--------|-----|-------|----------------|
| 1 | **PRIMARY** | Linear | AI Agents | https://linear.app/docs/agents-in-linear | undated (fetched 2026-07-09) | Agentes = app users; assign a agente **dispara delegation**; humano permanece responsável; My Issues / Insights por Delegate. |
| 2 | **PRIMARY** | Linear | Assign and delegate issues | https://linear.app/docs/assigning-issues | undated (fetched 2026-07-09) | Modelo explícito: assignee humano + agent delegate; filtros/Insights por assignee **ou** agent; triage rules podem delegar. |
| 3 | **PRIMARY** | Linear | Agent Interaction Guidelines (AIG) | https://linear.app/developers/aig | undated (fetched 2026-07-09) | Princípio: **“An agent cannot be held accountable”** — contrato HITL para Path B+. |
| 4 | **PRIMARY** | Linear | Our approach to building the Agent Interaction SDK | https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk | undated (blog; fetched 2026-07-09) | Racional de produto: issues só assign a humanos; só **delegate** a agentes; evita “agente com dezenas de issues sem dono humano”. |
| 5 | **PRIMARY** | Linear Dev | Getting Started (Agents) | https://linear.app/developers/agents | undated (fetched 2026-07-09) | Scopes `app:assignable` / `app:mentionable`; assign → `delegate` (não `assignee`); AgentSession em mention/delegation. |
| 6 | **PRIMARY** | Claude Tag | How Claude Tag works | https://claude.com/docs/claude-tag/concepts/how-it-works | undated (fetched 2026-07-09) | **Anyone** no canal pode `@Claude`; **anyone** steera respondendo no thread sem re-mention; access segue o **canal**, não a pessoa. |
| 7 | **PRIMARY** | Claude Tag | Work with Claude Tag (overview) | https://claude.com/docs/claude-tag/overview | undated (fetched 2026-07-09) | Team/Enterprise; handoff de trabalho real no Slack; checklist no thread; setup admin-governed. |
| 8 | **PRIMARY** | Claude / Anthropic | Agent identity: a new access model… | https://claude.com/blog/agent-identity-access-model | undated (blog; fetched 2026-07-09) | Multiplayer: identidade do agente ≠ usuário que tagueou; permissões do canal; RBAC Enterprise sobre quem pode invocar. |
| 9 | **PRIMARY** | Claude Help | What is Claude Tag? | https://support.claude.com/en/articles/15594475-what-is-claude-tag | undated; nota cutover Claude in Slack → Tag **2026-08-03** | Canal compartilhado = mesmo Claude; steer coletivo; Member Access modes (workspace / org / role). |
| 10 | **PRIMARY** | Cursor | Cloud Agents | https://cursor.com/docs/cloud-agent | undated (fetched 2026-07-09) | Entry points: Desktop/Web/Slack/GitHub/Linear/API; Cloud Agents = ex-Background Agents. |
| 11 | **PRIMARY** | Cursor | Slack integration | https://cursor.com/docs/integrations/slack | undated (fetched 2026-07-09) | `@Cursor [prompt]` inicia agent; follow-up no thread se owner; `@Cursor agent` força novo; channel defaults + routing rules. |
| 12 | **PRIMARY** | Cursor | Linear integration | https://cursor.com/docs/integrations/linear | undated (search+docs; fetch timeout 2026-07-09 — URL confirmada via search) | Delegate issue a Cursor **ou** `@Cursor` em comment; triage rules; nota: Linear pode exigir human assignee para rules. |
| 13 | **SECONDARY** | Linear Marketplace | Cursor Integration | https://linear.app/integrations/cursor | undated | Assign Cursor / `@cursor` → cloud agent → PR; superfície híbrida Linear↔Cursor. |
| 14 | **PRIMARY** | Notion | Custom Agents | https://www.notion.com/help/custom-agents | undated (fetched 2026-07-09) | Agentes de time com triggers/schedules; share como página; roster sob Agents section — relevante a **AI Hub-like roster**, não assign-as-delegate Linear. |
| 15 | **SECONDARY** | Notion | Notion 3.3: Custom Agents | https://www.notion.com/releases/2026-02-24 | **2026-02-24** | Release: task routing, Slack/MCP, admin visibility — data âncora para roster de agentes. |
| 16 | **PRIMARY** | Asana | Triggering AI Teammates | https://help.asana.com/s/article/triggering-ai-teammates?language=en_US | undated (fetched 2026-07-09) | **Assign task** + **@mention** + rules/forms/recurring; mid-task feedback; View activity — pedido humano→IA no work graph. |
| 17 | **PRIMARY** | Asana | How to use Asana AI teammates | https://help.asana.com/s/article/ai-teammates?language=en_US | undated | Teammates multi-user; share; AI Studio (volume) vs Teammates (colaborativo). |
| 18 | **PRIMARY** | Asana | AI Teammate Access Control… | https://help.asana.com/s/article/understanding-access-control-for-ai-teammates?language=en_US | undated | Intersection permissions (triggering user ∩ teammate); approvals ao expandir access — HITL de segurança. |
| 19 | **PRIMARY** | monday.com | AI Agents on monday.com | https://support.monday.com/hc/en-us/articles/33347027353746-AI-Agents-on-monday-com | undated (fetched 2026-07-09) | Agents nativos; **Assign it to items to trigger**; activity log + undo; tools/guardrails — intake humano→agente no board. |
| 20 | **SECONDARY** | Height | Height 2.0 is now launched | https://height.app/blog/introducing-height-2-0 | undated (blog; autonomous features) | Autonomous PM chores (triage, backlog, updates) — AI no fluxo de time, **não** roster assign explícito tipo Linear. |
| 21 | **SECONDARY** | Height | Release notes v2 (Teams, Autonomous…) | https://height.app/blog/releasenotes_v2 | undated | Auto button; bug triage assign/escalate; team standups — relevância parcial a hybrid roster. |
| 22 | **PRIMARY** | Plane | Plane AI (product) | https://plane.so/ai | undated (fetched 2026-07-09) | **Assign agent as assignee** + `@mention`; audit trail; “agents and teams” — claim forte de hybrid roster (validar em Cycle 2). |
| 23 | **PRIMARY** | Plane Docs | Plane AI assistant | https://docs.plane.so/ai/plane-ai | undated (fetched 2026-07-09) | Build mode: create/update work items, **assign members**; Ask vs Build — humano pede, AI age no work graph. |
| 24 | **PRIMARY** | GitHub Docs | Kick off a task with Copilot agents | https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task | undated (fetched 2026-07-09) | **Assign issue to Copilot** (sempre abre PR) vs prompt (branch + iterate) — padrão “pedir trabalho à IA” no tracker. |
| 25 | **PRIMARY** | GitHub Docs | About GitHub Copilot cloud agent | https://docs.github.com/copilot/concepts/agents/cloud-agent/about-cloud-agent | undated | Cloud agent (ex-coding agent / Workspace legado); assign backlog issues; distinto de agent mode IDE. |
| 26 | **SECONDARY** | GitHub Blog | Assigning and completing issues with coding agent… | https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/ | undated (legado “coding agent”) | Narrativa assign→👀→Actions VM→draft PR→review loop; útil como SECONDARY histórico. |
| 27 | **PRIMARY** | Manus | Manus Collab | https://manus.im/docs/features/collab | undated (fetched 2026-07-09) | Multiplayer na **mesma task**: todos promptam; só owner consome créditos; owner controla invites — contraste com Room Slack. |
| 28 | **PRIMARY** | Manus Help | Chatting with Manus Agent on Slack… | https://help.manus.im/en/articles/14431752-chatting-with-manus-agent-on-slack-channels-dms-and-file-delivery | undated | `@Manus` em canal = transparente ao time; task sob quem tagueou primeiro; DM = privado — dual surface collab vs solo. |
| 29 | **SECONDARY** | OpenAI Agents | Human-in-the-loop (Python SDK) | https://openai.github.io/openai-agents-python/human_in_the_loop/ | undated | Pause em tool approval; `interruptions` + resume `RunState` — HITL de runtime, **não** team panel UI. |
| 30 | **SECONDARY** | OpenAI API | Orchestration and handoffs | https://developers.openai.com/api/docs/guides/agents/orchestration | undated | Handoffs vs agents-as-tools (ownership do reply) — útil para orquestração interna Paperclip. |
| 31 | **SECONDARY** | A2A Protocol | Life of a Task | https://a2a-protocol.org/dev/topics/life-of-a-task/ | undated (fetched 2026-07-09) | Estados `input-required` / `auth-required`; parallel tasks no `contextId` — orquestração human-visible no protocolo, não roster. |
| 32 | **SECONDARY** | A2A Protocol | A2A home | https://a2a-protocol.org/dev/ | undated | Escopo: agent↔agent (não Slack UI); complementar a Path B Room. |

**Contagem:** **32** fontes (faixa 15–35).  
**Núcleo Cycle 2 (PRIMARY / alta prioridade):** #1–12, #14, #16–19, #22–25, #27–28 (~24).

---

## Notas de exclusão / baixa relevância

| Candidato | Decisão | Motivo |
|-----------|---------|--------|
| GitHub Copilot **Workspace** (nome legado) | Mapear → **Copilot cloud agent** | Docs atuais usam “cloud agent”; Workspace não é o termo canônico 2026. |
| Height Copilot blog antigo | Preferir 2.0 / autonomous | Copilot page redireciona narrativa para autonomous features. |
| OpenAI / A2A | Incluídos só como SECONDARY | Relevantes a orquestração/HITL runtime, não a painel híbrido de roster. |

---

## Top 8 candidate claims (para Cycle 2 Confirmation)

1. **Linear separa assignee (humano, accountable) de delegate (agente, executor)** — issues não transferem accountability ao agente.  
   *Fontes:* #1, #2, #3, #4, #5

2. **Linear AIG: “An agent cannot be held accountable”** é princípio de produto, não só copy de marketing.  
   *Fontes:* #3, #4

3. **Claude Tag: qualquer membro do canal pode iniciar (`@Claude`) e qualquer membro pode steer no thread sem re-mention.**  
   *Fontes:* #6, #7, #9

4. **Claude Tag: capabilities seguem o canal (agent identity / service accounts), não o usuário que tagueou** — multiplayer sem “permissions do requester”.  
   *Fontes:* #6, #8

5. **Cursor Cloud: humano pede trabalho via `@cursor` (Slack) ou assign/`@Cursor` (Linear); follow-ups no thread são do owner do agent.**  
   *Fontes:* #10, #11, #12, #13

6. **Asana AI Teammates: assign + @mention + rules/forms são o stack canônico de “humano pede trabalho à IA” no work tracker** (sem split assignee/delegate Linear).  
   *Fontes:* #16, #17, #18

7. **GitHub Copilot cloud agent: assign issue = handoff assíncrono com PR (ou branch+iterate via prompt)** — padrão tracker→agente→artefato revisável.  
   *Fontes:* #24, #25

8. **Plane posiciona agentes como assignees “same as any teammate”** (contraste com Linear delegate) — claim a **confirmar/refutar** vs Linear accountability model.  
   *Fontes:* #22, #23 (+ contraste #1–#3)

### Claims reserva (9–11) se Cycle 2 tiver bandwidth

9. Manus Collab: multiplayer prompt na mesma task; billing só no owner (#27).  
10. monday: assign agent to item dispara execução no board (#19).  
11. A2A `input-required` é o gancho de HITL protocol-level para Room wait/join (#31).

---

## Próximo passo

Cycle 2C: WebFetch + citação literal das Top 8; grade **CONFIRMED / PARTIAL / REFUTED**; cruzar com decisões D-09…D-13 (Path B+ hybrid panel) e com ClickUp Super Agents (Cycle 1B/2B).
