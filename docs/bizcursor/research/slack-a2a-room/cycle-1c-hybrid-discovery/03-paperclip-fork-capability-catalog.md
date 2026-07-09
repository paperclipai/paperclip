# Paperclip Fork — Capability Catalog (Path B+)

> **Ciclo:** 1C — Hybrid discovery  
> **Agente:** #3 codebase exploration  
> **Fork:** `/Users/macbook/Projects/paperclip`  
> **Path B+:** Conference Room Slack+@ **e** Hybrid Team Panel (humanos + agentes)  
> **Legenda:** **REUSE** = pronto para consumir · **ADAPT** = existe, precisa mudar contrato/UX · **BUILD** = ausente no fork

---

## 1. Board chat / Conference Room / mentions

| # | Capacidade | Status | Paths (verificados) | Evidência (1 linha) |
|---|------------|--------|---------------------|---------------------|
| 1.1 | Feature flag `enableConferenceRoomChat` | **REUSE** | `ui/src/hooks/useConferenceRoomChatEnabled.ts`, `ui/src/pages/InstanceExperimentalSettings.tsx`, `ui/src/components/Sidebar.tsx` | Toggle experimental gateia nav + rota; teste em `server/src/__tests__/board-chat-route-feature-flag.test.ts`. |
| 1.2 | Rota SSE `POST /api/board/chat/stream` | **ADAPT** | `server/src/routes/board-chat.ts`, `server/src/routes/openapi.ts` | Retorna 403 se flag off; hoje só relay concierge, não orquestra `@`. |
| 1.3 | BoardChat UI (concierge 1:1) | **ADAPT** | `ui/src/pages/BoardChat.tsx`, `ui/src/pages/BoardChat.test.tsx` | Comentário: “board-member skill” + `fetch("/api/board/chat/stream")`; usa `ChatComposer` sem `@`. |
| 1.4 | Persistência standing issue “Board Operations” | **REUSE** | `server/src/routes/board-chat.ts` | find/create standing issue; replies via sentinel `board-concierge`. |
| 1.5 | `ChatComposer` (input sala) | **ADAPT** | `ui/src/components/ChatComposer.tsx` | Grep: zero matches `mention` — textarea plain, sem autocomplete `@`. |
| 1.6 | `MarkdownEditor` + `MentionOption` | **REUSE** | `ui/src/components/MarkdownEditor.tsx`, `ui/src/components/IssueChatThread.tsx` | Issues já emitem `[@Name](agent://id)` via `buildAgentMentionHref`; BoardChat não usa. |
| 1.7 | Formato canônico `agent://` | **REUSE** | `packages/shared/src/project-mentions.ts`, `ui/src/lib/mention-chips.ts` | `AGENT_MENTION_SCHEME = "agent://"`; chips parseiam `kind: "agent"`. |
| 1.8 | Mention wake em issues (ping avulso) | **REUSE** | `server/src/__tests__/issue-update-comment-wakeup-routes.test.ts`, `skills/paperclip/SKILL.md` | `issue_comment_mentioned` sem `parentRunId`; skill avisa budget. |
| 1.9 | Bridge sala → fan-out/join A2A | **BUILD** | *(ausente)* | Glob `room-orchestrator*` e `board-room*` → 0 arquivos no fork. |
| 1.10 | Human API post mensagem + orquestração | **BUILD** | *(ausente)* | Nenhuma rota `POST /api/board/rooms/...`; só `board/chat/stream`. |
| 1.11 | Skill concierge → skill sala | **ADAPT** | `skills/paperclip-board/SKILL.md` | Skill board existe; não ensina `paperclipDelegate` fan-out nem silent-until-@. |
| 1.12 | Timeline multi-autor na sala | **ADAPT** | `ui/src/pages/BoardChat.tsx` | Renderiza comments humano/agente da standing issue, mas stream ativo é só concierge. |
| 1.13 | `adapter_wake` (sem spawn `claude` CLI) | **ADAPT** | `server/src/routes/board-chat.ts`, `server/src/services/heartbeat.ts`, adapters opencode/cursor execute.ts | `board-chat.ts` spawna `claude`; adapters já leem `paperclipChatWake` / `wakeMode: "chat"`. |

## 2. Delegation A2A

| # | Capacidade | Status | Paths | Evidência |
|---|------------|--------|-------|-----------|
| 2.1 | Motor `run-delegation` | **REUSE** | `server/src/services/run-delegation.ts` | `delegateFromRun`; `wait: false`; `getDelegationState` + `waitAllSec`. |
| 2.2 | Wiring heartbeat | **REUSE** | `server/src/services/heartbeat.ts` | `delegateFromRun` exposto; `a2a_delegate` / `delegation_child_completed`. |
| 2.3 | Validators Zod | **REUSE** | `packages/shared/src/validators/delegation.ts` | `wait` default true; `waitAllSec` query. |
| 2.4 | Spec A2A | **REUSE** | `doc/spec/agent-delegation-a2a.md` | Status “Implemented”; fan-out + join. |
| 2.5 | Testes integração | **REUSE** | `server/src/__tests__/run-delegation-integration.test.ts` | “delegates wait:false, links parent/child”. |
| 2.6 | MCP `paperclipDelegate` | **REUSE** | `packages/mcp-server/src/tools.ts` | fan-out + join via `paperclipGetDelegation waitAllSec`. |
| 2.7 | MCP get/cancel | **REUSE** | `packages/mcp-server/src/tools.ts` | join long-poll; cancel. |
| 2.8 | Agent Cards | **REUSE** | `server/src/routes/agents.ts` | `GET .../agent-cards`, `GET .../agent-card`. |
| 2.9 | `POST .../delegate` | **REUSE** | `server/src/routes/agents.ts` | chama `heartbeat.delegateFromRun`. |
| 2.10 | `GET .../delegation` (Board lê) | **REUSE** | `server/src/routes/agents.ts` | board reads any; passa `waitAllSec`. |
| 2.11 | Delegation Trace UI no fork | **BUILD** | *(ausente)* | Grep `DelegationTrace` em ui → 0. |
| 2.12 | `room-policy` | **BUILD** | *(ausente)* | Sem serviço; caps só em env vars. |

## 3. Human vs agent membership

| # | Capacidade | Status | Paths | Evidência |
|---|------------|--------|-------|-----------|
| 3.1 | Company Access / invites | **REUSE** | `ui/src/pages/CompanyAccess.tsx`, `CompanyInvites.tsx`, `server/src/routes/access.ts` | members + roles. |
| 3.2 | Roles humanos | **REUSE** | `server/src/services/company-member-roles.ts` | `member` → `operator`. |
| 3.3 | Resource memberships board\|agent | **REUSE** | `server/src/services/resource-memberships.ts` | `board \| agent \| none`. |
| 3.4 | Helper UI membros | **REUSE** | `ui/src/lib/company-members.ts` | activeUniqueMembers. |
| 3.5 | Agents list + org chart | **REUSE** | `ui/src/pages/Agents.tsx`, `OrgChart.tsx` | workforce agente. |
| 3.6 | Assignability agente | **REUSE** | `server/src/services/agent-assignability.ts` | só agentes. |
| 3.7 | Menções `@user` | **REUSE** | `ui/src/components/MarkdownEditor.tsx` | buildUserMentionHref. |
| 3.8 | Roster híbrido unificado | **BUILD** | *(ausente)* | Glob Hybrid* → 0. |
| 3.9 | ownerUserId + delegate | **ADAPT** | schema/recovery fixtures | sem slice owner+delegate unificado. |

## 4. Cost / usage

| # | Capacidade | Status | Paths | Evidência |
|---|------------|--------|-------|-----------|
| 4.1 | cost-events POST | **REUSE** | `server/src/routes/costs.ts`, `services/costs.ts` | agent reporta próprio custo. |
| 4.2 | by-agent / by-model | **REUSE** | `server/src/routes/costs.ts` | agregações. |
| 4.3 | UI Costs + budgets | **REUSE** | `ui/src/pages/Costs.tsx`, `services/budgets.ts` | tabs overview/budgets. |
| 4.4 | Finance rollup | **REUSE** | `server/src/services/finance.ts` | FinanceDateRange. |
| 4.5 | Cost metadata / cursor parser | **REUSE** | `cost-metadata.ts`, `cursor-run-log-parser.ts` | ingestão por run. |
| 4.6 | Custo por mensagem na sala | **BUILD** | — | sem link room-message → cost. |
| 4.7 | Insights dual humano+agent | **BUILD** | — | sem insights service. |

## 5. Routines / proactive

| # | Capacidade | Status | Paths | Evidência |
|---|------------|--------|-------|-----------|
| 5.1 | Routines CRUD + UI | **REUSE** | `ui/src/pages/Routines.tsx`, `RoutineDetail.tsx`, `services/routines.ts` | runRoutine. |
| 5.2 | Cron scheduler | **REUSE** | `services/routines.ts`, `cron.js` | parseCron. |
| 5.3 | Webhook trigger público | **REUSE** | `routes/routines.ts`, `webhook-trigger-rate-limit.ts` | public fire + rate limit. |
| 5.4 | Plugin-managed routines | **REUSE** | `plugin-managed-routines.ts` | plugin install. |
| 5.5 | Cursor webhook | **REUSE** | `cursor-webhook.ts`, `cursor-webhook-ingest.ts` | ingest Cursor Cloud. |
| 5.6 | proactivity-policy | **BUILD** | *(ausente)* | Glob proactivity* → 0. |
| 5.7 | Proatividade na sala | **BUILD** | — | sem bridge routine → room. |

## 6. Workload / roster UI

| # | Capacidade | Status | Paths | Evidência |
|---|------------|--------|-------|-----------|
| 6.1 | Agents list + detail | **REUSE** | `Agents.tsx`, `AgentDetail.tsx` | maduro. |
| 6.2 | Org chart | **REUSE** | `OrgChart.tsx` | layoutForest. |
| 6.3 | Active agents panel | **REUSE** | `ActiveAgentsPanel.tsx`, `Dashboard.tsx` | runs ao vivo. |
| 6.4 | TeamCatalog | **REUSE** | `TeamCatalog.tsx` | packs — não roster híbrido. |
| 6.5 | Agent action buttons | **REUSE** | `AgentActionButtons.tsx` | pause/resume. |
| 6.6 | Hybrid Team Panel | **BUILD** | — | ausente. |
| 6.7 | Capacity lanes | **BUILD** | — | defer Cycle 3B. |
| 6.8 | Ask modal | **BUILD** | — | fragmentado. |

## 7. Who can POST delegate

| # | Capacidade | Status | Paths | Evidência |
|---|------------|--------|-------|-----------|
| 7.1 | POST delegate — só agent JWT | **REUSE** *(constraint)* | `agents.ts` | actor.type !== agent → 403. |
| 7.2 | GET delegation — board ou agent | **REUSE** | `agents.ts` | board lê qualquer. |
| 7.3 | Cancel — agent-only | **REUSE** | `agents.ts` | gate agent JWT. |
| 7.4 | Board session authz | **REUSE** | `authz.ts` | assertCompanyAccess. |
| 7.5 | Human delegate bridge | **BUILD** | — | precisa agent-of-record server-side. |
| 7.6 | Expor run JWT ao browser | **BUILD** *(proibido)* | — | human API nasce run no server. |

## 8. Performance / analytics

| # | Capacidade | Status | Paths | Evidência |
|---|------------|--------|-------|-----------|
| 8.1 | Dashboard métricas | **REUSE** | `Dashboard.tsx`, `services/dashboard.ts` | MetricCard, charts. |
| 8.2 | Productivity review | **REUSE** | `productivity-review.ts`, `ProductivityReviewBadge.tsx` | churn heuristics. |
| 8.3 | Activity / live updates | **REUSE** | `LiveUpdatesProvider.tsx`, `ActivityFeed.tsx` | BoardChat split pane. |
| 8.4 | Dual performance | **BUILD** | — | agent-centric only. |
| 8.5 | Delegation trace UI | **BUILD** | — | API read existe; UI não. |
| 8.6 | Deployment modes | **ADAPT** | `server/src/index.ts`, `config-schema.ts` | local_trusted vs authenticated. |

## Resumo

| Domínio | REUSE | ADAPT | BUILD |
|---------|-------|-------|-------|
| Board/Room | 5 | 6 | 2 |
| A2A | 10 | 0 | 2 |
| Membership | 6 | 1 | 2 |
| Cost | 5 | 0 | 2 |
| Routines | 5 | 0 | 2 |
| Workload UI | 5 | 0 | 3 |
| Delegate auth | 4 | 0 | 2 |
| Performance | 3 | 1 | 2 |

## Top 10 claims code-backed (Cycle 2)

1. Fan-out wait:false + join waitAllSec implementados e testados (`run-delegation.ts`).
2. POST delegate 403 se actor ≠ agent (`agents.ts`).
3. GET delegation permite board ler qualquer run.
4. BoardChat spawna claude CLI com skill paperclip-board.
5. ChatComposer sem mentions; MarkdownEditor com mentions.
6. Mention agent:// em issue = wake independente (sem parentRunId).
7. MCP paperclipDelegate documenta fan-out+join.
8. Adapters cursor_cloud/opencode_local suportam paperclipChatWake.
9. Não existe room-orchestrator / board-room / DelegationTrace no fork.
10. Routines têm cron+webhook; não há proactivity-policy.

## Lacunas críticas Path B+

1. Sala → A2A: motor REUSE; ponte BUILD.
2. Mentions ≠ join: format REUSE; orquestração BUILD.
3. Humano não delega: constraint REUSE; bridge BUILD.
4. Hybrid panel: peças REUSE; canvas BUILD.
5. Trace UI: API REUSE; componente BUILD.
