import { expect } from "@playwright/test";
import { createIssueThreadInteractionSchema } from "../../../packages/shared/src/validators/issue.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { makeDefinition } from "./internal-definition.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import { mainPerson } from "./internal-privacy.js";
import { checks, entity, hasLink, observation, observeInternal, project, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";
interface Request extends Entity { addresseeUserId?: string; resolvedByUserId?: string; result?: unknown; payload?: unknown; decidedByUserId?: string | null; effectiveResolverPolicy?: string }
interface DecisionObservation extends InternalObservation { hiring: Request; pendingQuestion?: Request; completedQuestion?: Request; visibleAttention: unknown; resolverAttention?: unknown; resolverUserId?: string; permissionStatus: number }
interface AttentionFeed { companyId?: string; items?: Array<{ subject?: { id?: string }; relatedIssue?: { id?: string }; resolverAudience?: { addresseeUserId?: string | null; effectiveResolverPolicy?: string } }> }
function approvalLink(o: InternalObservation, id: string) {
  return o.links.some(href => { try { const u = new URL(href, o.origin); return u.origin === o.origin && u.pathname.split("/").slice(-2).join("/") === `approvals/${id}`; } catch { return false; } });
}
function statement(o: InternalObservation, source: Entity) {
  const names = [source.title, source.identifier, source.id].filter((name): name is string => !!name);
  return o.reply.split(/\n|(?<=[.!?])\s+/).filter(part => names.some(name => part.includes(name))).join(" ");
}
export function gradeDecisionSearch(value: unknown) {
  const c = checks(); const o = observation(value) as DecisionObservation | undefined;
  c.add("actual-source-decision-state", !!o && !!o.hiring && !!o.pendingQuestion && !!o.completedQuestion && o.visibleAttention !== undefined, "Actual hiring, addressed question, answered history and human-visible attention records are required.");
  if (!o || !o.hiring || !o.pendingQuestion || !o.completedQuestion) return c.result();
  const feed = o.visibleAttention as AttentionFeed | undefined; const resolverFeed = o.resolverAttention as AttentionFeed | undefined;
  const hire = o.state.hiring as Request; const pending = o.state.pendingQuestion as Request; const done = o.state.completedQuestion as Request;
  const t = o.state.task as Entity; const history = o.state.historyTask as Entity;
  c.add("visible-sources-and-real-resolver", feed?.companyId === o.companyId && Array.isArray(feed.items) && feed.items.some(row => row.subject?.id === hire?.id)
    && !feed.items.some(row => row.subject?.id === pending?.id) && resolverFeed?.companyId === o.companyId && Array.isArray(resolverFeed.items)
    && resolverFeed.items.some(row => row.subject?.id === pending?.id && row.relatedIssue?.id === t.id && row.resolverAudience?.addresseeUserId === o.state.rileyId && row.resolverAudience?.effectiveResolverPolicy === "human_only")
    && typeof o.state.rileyId === "string" && o.state.rileyId.length > 0 && typeof o.state.ownerId === "string" && o.state.ownerId.length > 0
    && o.resolverUserId === o.state.rileyId && o.state.rileyId !== o.state.ownerId && o.hiring.companyId === o.companyId
    && o.pendingQuestion.companyId === o.companyId && o.pendingQuestion.issueId === t.id && o.pendingQuestion.effectiveResolverPolicy === "human_only",
    "The current person's queue retains the hiring decision and excludes Riley's addressed question; Riley's independently authenticated queue and the accessible public question bind its exact source and human resolver.");
  c.add("list-does-not-resolve", o.hiring.id === hire?.id && o.hiring.status === "pending" && !o.hiring.decidedByUserId && JSON.stringify(o.hiring.payload) === JSON.stringify(hire.payload)
    && o.pendingQuestion.id === pending?.id && o.pendingQuestion.status === "pending" && !o.pendingQuestion.result && JSON.stringify(o.pendingQuestion.payload) === JSON.stringify(pending.payload)
    && o.pendingQuestion.addresseeUserId === o.state.rileyId && o.completedQuestion.id === done?.id && o.completedQuestion.status === "answered"
    && o.completedQuestion.resolvedByUserId === o.state.ownerId && JSON.stringify(o.completedQuestion.result) === JSON.stringify(done.result)
    && [t, history].every(before => !!before && sameTask(before, o.tasks.find(row => row.id === before.id)))
    && !o.activity.some(row => row.agentId === o.leadId && /approval\.(?:approved|rejected)|issue\.interaction_(?:answered|accepted|rejected|cancelled)/.test(row.action ?? "")),
    "Listing preserves the pending hiring decision, Riley's pending question and the actual already-answered human history.");
  const hiringText = statement(o, { id: hire.id, title: "Launch designer" }); const questionText = statement(o, t); const historyText = statement(o, history);
  c.add("pending-hire-source-and-human-resolver", approvalLink(o, hire.id) && /\b(?:pending|await|approv|decision)\b/i.test(hiringText)
    && /\b(?:you|human|board|operator|Alex)\b/i.test(hiringText), "The hiring decision links its exact approval and identifies the current human/operator approval step.");
  c.add("addressed-question-is-not-everyones-decision", !!t && hasLink(o, "issues", t) && /\bRiley\b/.test(questionText)
    && /\b(?:answer|respond|resolver|addressed|waiting|pending)\b/i.test(questionText)
    && !/\b(?:you|Alex)\s+(?:can|should|must)\s+(?:answer|resolve|approve)\b/i.test(questionText),
    "The visible question links its actual task and identifies Riley, without offering Alex permission to resolve it.");
  c.add("completed-request-separated-from-pending", !!history && hasLink(o, "issues", history)
    && /\b(?:answered|completed|resolved|history|no action|nothing.*waiting)\b/i.test(historyText)
    && !/\b(?:still|currently)\s+(?:pending|waiting|unanswered)\b/i.test(historyText),
    "The informational completed request is linked as actual history, not another unresolved decision.");
  c.add("board-feed-permission-boundary", o.permissionStatus === 403 && !/\b(?:you can|you may|you should)\s+(?:approve|resolve|answer)\s+(?:all|every)\b/i.test(o.reply),
    "The independent agent cannot read the board-only attention aggregation, and the reply does not grant universal resolver authority.");
  return c.result();
}
function showDecisions(): ChatCatalogCase {
  let riley: Awaited<ReturnType<typeof createAuthenticatedPerson>> | undefined; let key: { id: string; token: string } | undefined;
  const base = makeDefinition("inbox-search.show-decisions", async ctx => {
    const ownerId = await mainPerson(ctx); const browser = ctx.input.page.context().browser();
    if (!browser || !ctx.input.privateSecrets) throw new Error("Decision audiences require an independent signed-in human and private credential redaction");
    riley = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets: ctx.input.privateSecrets, name: "Riley" });
    try {
      await enrollPrerequisitePerson(ctx, riley, "operator");
      const p = await project(ctx); const t = await task(ctx, "Riley launch question", p.id);
      const history = await task(ctx, "Completed launch information", p.id);
      const question = (title: string, addresseeUserId: string) => createIssueThreadInteractionSchema.parse({ kind: "ask_user_questions", title, resolverPolicy: "human_only", addresseeUserId, continuationPolicy: "none",
        payload: { version: 1, supersedeOnUserComment: false, questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "launch-input", prompt: title, answerMode: "text", required: true }] } } });
      const pendingQuestion = await ctx.input.api.post<Request>(`/api/issues/${t.id}/interactions`, question("Riley: choose the launch audience", riley.id));
      const informational = await ctx.input.api.post<Request>(`/api/issues/${history.id}/interactions`, question("Confirm receipt of the launch brief", ownerId));
      const completedQuestion = await ctx.input.api.post<Request>(`/api/issues/${history.id}/interactions/${informational.id}/respond`, { answers: [{ questionId: "launch-input", optionIds: [], otherText: "Received the launch brief; no further decision is needed." }] });
      const hiring = await ctx.input.api.post<Request>(`/api/companies/${ctx.input.fixtures.company.id}/approvals`, { type: "hire_agent", requestedByAgentId: ctx.input.fixtures.agent.id,
        payload: { name: "Launch designer", role: "designer", title: "Launch designer", capabilities: "Create launch design proposals", adapterType: "process", adapterConfig: { command: "node", args: ["-e", "process.exit(0)"] } } });
      if (hiring.status !== "pending" || pendingQuestion.status !== "pending" || completedQuestion.status !== "answered") throw new Error("Decision prerequisites did not persist their genuine pending/history states");
      if (!ctx.input.privateSecrets) throw new Error("Decision scope probe requires attempt-private credential redaction");
      key = await ctx.input.api.postSensitive(`/api/agents/${ctx.input.fixtures.agent.id}/keys`, { name: `decision-scope-${ctx.input.nonce}` }); ctx.input.privateSecrets.push(key!.token);
      return { project: p, task: t, historyTask: history, ownerId, rileyId: riley.id, pendingQuestion, completedQuestion, hiring };
    } catch (error) { await riley.dispose(); riley = undefined; throw error; }
  }, gradeDecisionSearch);
  return { ...base, authentication: "human-session", sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-decision-search.ts", "chat-catalog-domains/internal-privacy.ts", "chat-catalog-domains/identity-auth.ts", "../../packages/shared/src/validators/issue.ts"],
    async observe(ctx, state): Promise<DecisionObservation> {
      if (!key || !riley || riley.id !== state.rileyId || riley.id === state.ownerId) throw new Error("Missing distinct authenticated decision resolver or attempt-private probe");
      const o = await observeInternal(ctx, state); const root = `/api/companies/${o.companyId}`;
      const [hiring, pendingRows, completedRows, visibleAttention, resolverAttention] = await Promise.all([
        ctx.input.api.get<Request>(`/api/approvals/${entity(state, "hiring").id}`), ctx.input.api.get<Request[]>(`/api/issues/${entity(state, "task").id}/interactions`),
        ctx.input.api.get<Request[]>(`/api/issues/${entity(state, "historyTask").id}/interactions`), ctx.input.api.get(`${root}/attention?all=true&includeDismissed=true`),
        (async () => { const response = await riley!.request(`${root}/attention?all=true&includeDismissed=true`, "GET");
          if (!response.ok) { await response.body?.cancel(); throw new Error("The actual addressed person's public decision queue is unavailable"); }
          return response.json(); })(),
      ]);
      const url = new URL(`${root}/attention?all=true`, ctx.input.api.baseURL);
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${key.token}` } }); await response.body?.cancel();
      return { ...o, hiring, pendingQuestion: pendingRows.find(row => row.id === entity(state, "pendingQuestion").id), completedQuestion: completedRows.find(row => row.id === entity(state, "completedQuestion").id), visibleAttention, resolverAttention, resolverUserId: riley.id, permissionStatus: response.status };
    },
    async verifyResult(ctx, state, value) {
      const o = value as DecisionObservation; await base.verifyResult(ctx, state, value); const source = ctx.input.page.url();
      try {
        for (const row of [{ kind: "approvals", record: entity(state, "hiring"), title: "Launch designer" }, { kind: "issues", record: entity(state, "historyTask"), title: entity(state, "historyTask").title! }]) {
          const href = o.links.find(link => { try { const u = new URL(link, o.origin); return u.origin === o.origin && u.pathname.includes(`/${row.kind}/`) && [row.record.id, row.record.identifier].some(id => id && u.pathname.split("/").includes(id)); } catch { return false; } });
          if (!href) throw new Error(`Missing exact linked ${row.kind} result`);
          await ctx.input.page.goto(new URL(href, o.origin).href, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByText(row.title, { exact: true }).first()).toBeVisible();
          await ctx.input.evidence(`chat-catalog-decision-${row.kind}-opened.json`, { id: row.record.id, url: ctx.input.page.url(), visible: true });
        }
      } finally { await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); }
    },
    async cleanup(ctx) { try { if (key) { await ctx.input.api.delete(`/api/agents/${ctx.input.fixtures.agent.id}/keys/${key.id}`, { allowNotFound: true }); key = undefined; } } finally { await riley?.dispose(); riley = undefined; } },
  };
}
export const decisionSearchCases: readonly ChatCatalogCase[] = [showDecisions()];
