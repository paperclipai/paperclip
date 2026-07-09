# Cycle 2C — Fork Code Confirmation (Top 10)

> **Ciclo:** 2C — Hybrid confirmation  
> **Agente:** #3 code claims  
> **Fonte das claims:** [`cycle-1c-hybrid-discovery/03-paperclip-fork-capability-catalog.md`](../cycle-1c-hybrid-discovery/03-paperclip-fork-capability-catalog.md) § Top 10  
> **Repo verificado:** `/Users/macbook/Projects/paperclip`  
> **Data:** 2026-07-09  
> **Método:** Read/Grep nos paths citados; ausência verificada via `ls`/`rg` em `server/src` e `ui/src` (docs excluídos)

`NotebookLM: skip (non-Villa) — Paperclip fork code confirmation`

---

## Score

| Grade | Count |
|-------|-------|
| **CONFIRMED** | 9 |
| **PARTIAL** | 1 |
| **REFUTED** | 0 |

**Score: 9/10 CONFIRMED** (1 PARTIAL — C1 join `waitAllSec` sem teste dedicado)

---

## Claims matrix

| ID | Claim (Cycle 1C) | Grade | Evidência |
|----|------------------|-------|-----------|
| C1 | Fan-out `wait:false` + join `waitAllSec` implementados e testados | **PARTIAL** | `wait:false` + fan-out: código + integração. `waitAllSec`: implementado (serviço/rota/Zod/MCP); **sem** teste em `server/src/__tests__` |
| C2 | POST delegate 403 se actor ≠ agent | **CONFIRMED** | `agents.ts` gate explícito |
| C3 | GET delegation permite board ler qualquer run | **CONFIRMED** | Comentário + gate só restringe agent alheio |
| C4 | BoardChat spawna `claude` CLI com skill `paperclip-board` | **CONFIRMED** | `board-chat.ts` spawn + load skill |
| C5 | ChatComposer sem mentions; MarkdownEditor com mentions | **CONFIRMED** | Grep zero em ChatComposer; MentionOption em MarkdownEditor |
| C6 | Mention `agent://` em issue = wake independente (sem `parentRunId`) | **CONFIRMED** | `issues.ts` wakeup sem `parentRunId`; teste + skill |
| C7 | MCP `paperclipDelegate` documenta fan-out+join | **CONFIRMED** | Descrição tool + `waitAllSec` em get |
| C8 | Adapters `cursor_cloud` / `opencode_local` suportam `paperclipChatWake` | **CONFIRMED** | Ambos `execute.ts` + README cursor |
| C9 | Não existe `room-orchestrator` / `board-room` / `DelegationTrace` no fork | **CONFIRMED** | Paths ausentes em código; só docs de pesquisa |
| C10 | Routines têm cron+webhook; não há `proactivity-policy` | **CONFIRMED** | `routines.ts` + ausência de serviço |

---

## C1 — Fan-out wait:false + join waitAllSec

**Grade: PARTIAL**

### Evidência — fan-out `wait:false` (CONFIRMED)

```599:607:/Users/macbook/Projects/paperclip/server/src/services/run-delegation.ts
    if (!input.wait) {
      return {
        parentRunId,
        childRunId: childRun.id,
        childIssueId,
        delegationStatus: "pending" as const,
        a2aTaskState: delegationStatusToA2ATaskState("pending"),
        wait: false,
      };
```

Teste: `server/src/__tests__/run-delegation-integration.test.ts:136` — `"delegates wait:false, links parent/child, and stamps depth"`.

### Evidência — join `waitAllSec` (implementado, não testado)

```939:946:/Users/macbook/Projects/paperclip/server/src/services/run-delegation.ts
  async function getDelegationState(parentRunId: string, options?: { waitAllSec?: number }) {
    const parent = await deps.getRun(parentRunId);
    if (!parent) return null;

    if (options?.waitAllSec && options.waitAllSec > 0) {
      const timeoutMs = Math.min(options.waitAllSec, DELEGATION_WAIT_TIMEOUT_MAX_SEC) * 1000;
      await waitForAllChildrenTerminal(parentRunId, timeoutMs);
```

- Zod: `packages/shared/src/validators/delegation.ts:33` — `waitAllSec` query.
- Rota: `agents.ts:3637–3639` passa `waitAllSec` para `getDelegationState`.
- MCP: `paperclipGetDelegation` com `waitAllSec` (`packages/mcp-server/src/tools.ts:500–511`).
- **Gap:** `rg waitAllSec` em `server/src/__tests__` → 0 matches.

**Implicação Cycle 3/4:** tratar motor A2A como **REUSE** para fan-out; join long-poll como **REUSE com dívida de teste** (não reinventar waiter).

---

## C2 — POST delegate 403 se actor ≠ agent

**Grade: CONFIRMED**

```3580:3583:/Users/macbook/Projects/paperclip/server/src/routes/agents.ts
  router.post("/heartbeat-runs/:runId/delegate", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
```

Também exige `X-Paperclip-Run-Id` == `runId` (403 se mismatch, L3586–3588).

---

## C3 — GET delegation: board lê qualquer run

**Grade: CONFIRMED**

```3627:3630:/Users/macbook/Projects/paperclip/server/src/routes/agents.ts
    // Agents may only read delegation state for their own runs; board reads any.
    if (req.actor.type === "agent" && req.actor.agentId !== existing.agentId) {
      res.status(403).json({ error: "Agents can only read their own delegation state" });
```

Board não entra no `if` → lê qualquer run da company (após `assertCompanyAccess`).

---

## C4 — BoardChat spawna claude + skill paperclip-board

**Grade: CONFIRMED**

```23:25:/Users/macbook/Projects/paperclip/server/src/routes/board-chat.ts
 * Implements `POST /board/chat/stream` (mounted under `/api`): a lightweight
 * chat relay that spawns the `claude` CLI with the paperclip-board skill as
 * its system prompt and streams the response back to the web UI via
```

```80:80:/Users/macbook/Projects/paperclip/server/src/routes/board-chat.ts
    const skillPath = path.resolve(here, "../../../skills/paperclip-board/SKILL.md");
```

```247:247:/Users/macbook/Projects/paperclip/server/src/routes/board-chat.ts
    const proc = spawn("claude", args, {
```

Arquivo skill existe: `skills/paperclip-board/SKILL.md`.

---

## C5 — ChatComposer sem mentions; MarkdownEditor com mentions

**Grade: CONFIRMED**

ChatComposer — comentário de design + grep `mention` = 0:

```17:20:/Users/macbook/Projects/paperclip/ui/src/components/ChatComposer.tsx
 * One reusable input shell used by BOTH the conference room (BoardChat) and
 * task comments (IssueChatThread). It is intentionally a *plain textarea* —
 * **no formatting toolbar** — with attach + send.
```

MarkdownEditor — `MentionOption`, `buildAgentMentionHref`, autocomplete `@`:

```83:84:/Users/macbook/Projects/paperclip/ui/src/components/MarkdownEditor.tsx
  /** List of mentionable entities. Enables @-mention autocomplete. */
  mentions?: MentionOption[];
```

---

## C6 — Mention agent:// → wake independente (sem parentRunId)

**Grade: CONFIRMED**

Wake em comment (sem campo `parentRunId` no snapshot):

```5717:5735:/Users/macbook/Projects/paperclip/server/src/routes/issues.ts
        for (const mentionedId of mentionedIds) {
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          addWakeup(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            ...
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
              forceFreshSession: true,
              commentWakeFreshnessGuard: true,
            },
          });
```

Teste: `issue-update-comment-wakeup-routes.test.ts:570–587` — espera `reason: "issue_comment_mentioned"` sem `parentRunId`.

Skill: `skills/paperclip/SKILL.md:331` — “@-mentions trigger heartbeats — use sparingly, they cost budget” + formato `agent://`.

---

## C7 — MCP paperclipDelegate documenta fan-out+join

**Grade: CONFIRMED**

```484:485:/Users/macbook/Projects/paperclip/packages/mcp-server/src/tools.ts
      "paperclipDelegate",
      "Delegate work to a report agent from the current heartbeat run (A2A). Requires PAPERCLIP_RUN_ID. Supports parallel fan-out (call multiple times with wait:false, then join with paperclipGetDelegation waitAllSec), ...
```

```500:504:/Users/macbook/Projects/paperclip/packages/mcp-server/src/tools.ts
      "paperclipGetDelegation",
      "Read the delegation state ... Pass waitAllSec to long-poll until every delegated child finishes (join for parallel fan-out). ...
      z.object({
        waitAllSec: z.number().int().min(1).max(300).optional().nullable(),
```

---

## C8 — Adapters cursor_cloud / opencode_local + paperclipChatWake

**Grade: CONFIRMED**

```313:328:/Users/macbook/Projects/paperclip/packages/adapters/cursor-cloud/src/server/execute.ts
  const chatWake = normalizePaperclipChatWakePayload(context.paperclipChatWake);
  ...
  const wakePrompt = chatWake
    ? renderPaperclipChatWakePrompt(chatWake, { resumedSession: canReuseSession })
    : renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: canReuseSession });
```

```247:247:/Users/macbook/Projects/paperclip/packages/adapters/opencode-local/src/server/execute.ts
  const chatWake = normalizePaperclipChatWakePayload(context.paperclipChatWake);
```

README cursor: `packages/adapters/cursor-cloud/README.md` § “Chat-mode (paperclipChatWake)” — `wakeMode: "chat"`.

---

## C9 — Ausência room-orchestrator / board-room / DelegationTrace

**Grade: CONFIRMED** (claim de ausência)

| Path esperado | Resultado 2026-07-09 |
|--------------|----------------------|
| `server/src/services/room-orchestrator.ts` | **No such file** |
| `server/src/routes/board-room.ts` | **No such file** |
| `ui/src/**/DelegationTrace*` | **0** em `ui/src` (`rg -l DelegationTrace`) |
| `server/src/services/proactivity-policy.ts` | **No such file** (também C10) |

Menções a esses nomes existem só em `docs/bizcursor/research/**` (planos/SPECs futuros) — não contam como implementação.

---

## C10 — Routines cron+webhook; sem proactivity-policy

**Grade: CONFIRMED**

- Cron: `server/src/services/routines.ts:58` importa `parseCron`; `runRoutine` em L2192+.
- Webhook: triggers `kind === "webhook"`, URL pública `/api/routine-triggers/public/.../fire` (L1821+), `source: "webhook"` (L2310).
- `proactivity-policy`: glob/serviço em código de produção → **ausente** (só SPECs em docs).

---

## PROMOTED product requirements (somente CONFIRMED)

Requisitos elegíveis para Cycle 3/4 — **não** promover a parte “testado” de C1 join; motor fan-out sim via evidência CONFIRMED parcial + C7.

| ID | Requirement (produto) | Origem |
|----|----------------------|--------|
| **PR-F1** | Humano **não** chama `POST .../delegate` do browser; orquestração sala usa identidade de **agent run** server-side (agent-of-record / host run) | C2 |
| **PR-F2** | Board UI pode polir estado de delegação via `GET .../delegation` (auth board) sem JWT de agent | C3 |
| **PR-F3** | Path Coolify/remoto: **não** depender de spawn local `claude` + skill board como runtime da Conference Room; migrar para `adapter_wake` / adapters existentes | C4 |
| **PR-F4** | Conference Room deve adotar composer com `@` (reusar `MarkdownEditor` / mention chips) — `ChatComposer` plain é insuficiente | C5 |
| **PR-F5** | Mention em issue **≠** join A2A: wake `issue_comment_mentioned` é independente; sala multi-`@` precisa orquestrador explícito (não reusar só mention wake) | C6 |
| **PR-F6** | Contrato agent-facing de fan-out+join permanece MCP `paperclipDelegate` (`wait:false`) + `paperclipGetDelegation(waitAllSec)` — skill/sala deve alinhar a esse contrato | C7 |
| **PR-F7** | Chat-mode na sala deve injetar `paperclipChatWake` nos adapters `cursor_cloud` e `opencode_local` (já suportados) | C8 |
| **PR-F8** | **BUILD** obrigatório: `room-orchestrator` (e/ou rotas board-room) + UI `DelegationTrace` — ausentes no fork | C9 |
| **PR-F9** | Routines (cron/webhook) são **REUSE** para proatividade; **BUILD** `proactivity-policy` para governar wakes ambient vs silent-until-@ | C10 |

### Não promovido (PARTIAL)

| Claim | Por quê |
|-------|---------|
| C1 “join waitAllSec testado” | Implementação existe; falta teste de integração. Cycle 3 pode especificar smoke `waitAllSec` sem tratar como gap de produto. Fan-out `wait:false` **pode** ser assumido REUSE (evidência forte + C7). |

---

## Gaps de código (confirmados)

1. Bridge sala → A2A (`room-orchestrator` / `board-room`) — **BUILD** (C9).
2. Mentions na Conference Room — **ADAPT** ChatComposer ou trocar por MarkdownEditor (C5).
3. Human delegate — constraint **REUSE** (C2); bridge server-side **BUILD**.
4. DelegationTrace UI — **BUILD** (C9); API read **REUSE** (C3).
5. `proactivity-policy` — **BUILD** (C10); routines **REUSE**.
6. BoardChat `claude` CLI — **ADAPT**/substituir para deploy remoto (C4).
7. Dívida: teste integração `getDelegationState({ waitAllSec })` (C1 PARTIAL).

---

## Veredito

Claims do catálogo Cycle 1C Top 10 são **sólidas**: 9/10 CONFIRMED, 0 REFUTED. Única nuance: C1 exagera “testados” no join. Path B+ continua: **motor A2A REUSE**, **ponte sala + hybrid/policy/trace BUILD**.
