import { expect } from "@playwright/test";
import { createIssueThreadInteractionSchema } from "../../../packages/shared/src/validators/issue.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { RunnerApiHttpError } from "../api.js";
import { createAuthenticatedPerson, enrollPrerequisitePerson } from "./identity-auth.js";
import { makeDefinition } from "./internal-definition.js";
import { checks, entity, hasLink, observation, observeInternal, project, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";

interface InboxItem extends Entity { archivedByActorType?: string; archivedByAgentId?: string; archivedByRunId?: string }
interface TriageObservation extends InternalObservation {
  ownerItems: InboxItem[]; otherPersonItems: InboxItem[]; policy: { mode: string; allowedAgentIds: string[] };
  questions: Array<Entity & { status: string }>;
  phaseReply: string; unrestorableStatus?: number;
}
const ownerPath = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}/issues?touchedByUserId=me&includeAgentCreatedTasks=true&limit=1000`;
function knownOriginals(o: TriageObservation) { return o.state.originalTasks as Entity[] | undefined; }
function eligible(o: TriageObservation) { return (knownOriginals(o) ?? []).filter(row => row.status === "done"); }
function actualArchive(o: TriageObservation, row: Entity) {
  const item = o.ownerItems.find(now => now.id === row.id);
  return !!item?.archivedAt && Number.isFinite(Date.parse(item.archivedAt)) && item.archivedByActorType === "agent" && item.archivedByAgentId === o.leadId
    && o.runs.some(run => run.id === item.archivedByRunId && run.agentId === o.leadId && run.status === "succeeded");
}
function validTriage(value: unknown): TriageObservation | undefined {
  const o = observation(value) as TriageObservation | undefined;
  return o && Array.isArray(o.ownerItems) && Array.isArray(o.otherPersonItems) && Array.isArray(o.questions) && !!o.policy && typeof o.phaseReply === "string" ? o : undefined;
}
function retainedPersonalState(o: TriageObservation) {
  const original = knownOriginals(o); const question = o.state.question as Entity | undefined;
  const other = o.state.otherPersonTask as InboxItem | undefined;
  const missing = o.state.unrestorableTask as Entity | undefined;
  const historical = o.state.historicalArchive as InboxItem | undefined;
  return !!original && original.filter(row => row.id !== missing?.id).every(row => sameTask(row, o.tasks.find(now => now.id === row.id)))
    && original.filter(row => row.status !== "done").every(row => !o.ownerItems.find(now => now.id === row.id)?.archivedAt)
    && !!other && o.otherPersonItems.some(row => row.id === other.id && sameTask(other, row) && row.archivedAt === other.archivedAt)
    && (!historical || o.ownerItems.some(row => row.id === historical.id && sameTask(historical, row) && row.archivedAt === historical.archivedAt))
    && (!question || o.questions.some(row => row.id === question.id && row.status === "pending"));
}
function archiveEvents(o: TriageObservation) { return o.activity.filter(row => row.action === "issue.inbox_archived" && row.agentId === o.leadId); }
function usefulTriagePath(o: TriageObservation) {
  return /\bundo\b/i.test(o.reply) || eligible(o).some(row => hasLink(o, "issues", row)) || o.links.some(href => {
    try { const url = new URL(href, o.origin); return url.origin === o.origin && (/\/inbox\/mine\/?$/.test(url.pathname)
      || /\/issues\/?$/.test(url.pathname) && url.searchParams.get("view") === "mine"); } catch { return false; }
  });
}
function archiveComplete(o: TriageObservation, requireMany: boolean) {
  const count = eligible(o).length; const events = archiveEvents(o);
  return count === (requireMany ? 501 : 3) && eligible(o).every(row => actualArchive(o, row))
    && events.length === count && events.every(row => eligible(o).some(item => item.id === row.entityId) && row.details?.userId === o.state.personId)
    && (new RegExp(`\\b${count}\\b`).test(o.phaseReply) || count === 501 && /\bfive hundred (?:and )?one\b/i.test(o.phaseReply) || count === 3 && /\bthree\b/i.test(o.phaseReply))
    && retainedPersonalState(o);
}
export function gradeInboxTriage(value: unknown) {
  const c = checks(); const o = validTriage(value);
  c.add("independent-personal-triage", !!o, "Actual per-user archive attribution, task status, personal policy and another authenticated person's state are required.");
  if (!o) return c.result();
  c.add("explicit-personal-permission", o.policy.mode === "allowlist" && o.policy.allowedAgentIds.includes(o.leadId), "The person explicitly enables this CEO through the saved personal-inbox policy.");
  c.add("statuses-and-other-person-retained", retainedPersonalState(o), "Done-only cleanup leaves task statuses, pending questions, other statuses and another person's inbox unchanged.");
  const first = validTriage(o.state.firstArchive);
  if (o.scenarioId === "inbox-search.archive-done") {
    c.add("actual-full-multi-page-cleanup", !!first && archiveComplete(first, true), "The original turn archives all 501 eligible Done items across the default 500-row boundary, with correct attributed count and no other targets.");
    const firstEvents = first ? archiveEvents(first) : [];
    c.add("repeated-request-has-no-new-effects", !!first && eligible(o).every(row => actualArchive(o, row)
      && o.ownerItems.find(item => item.id === row.id)?.archivedAt === first.ownerItems.find(item => item.id === row.id)?.archivedAt)
      && archiveEvents(o).length === firstEvents.length && firstEvents.every(event => archiveEvents(o).some(now => now.id === event.id))
      && !o.activity.some(row => row.action === "issue.inbox_unarchived" && row.agentId === o.leadId),
      "The actual repeated human request retains the original archive timestamps and audit rows without repeating writes or unarchiving successes.");
    c.add("truthful-idempotent-response", /\balready\b|\b(?:nothing|none|no (?:remaining|new|done)|0)[^.\n]*(?:archiv|done)|\b(?:archiv|done)[^.\n]*\b(?:already|nothing|none)\b/i.test(o.phaseReply),
      "The repeated request reports the reconciled no-new-work result instead of inventing another cleanup.");
    c.add("useful-source-or-undo-path", !!first && usefulTriagePath(first), "The original cleanup supplies actual source links, Mine navigation or a useful undo path.");
  } else if (o.scenarioId === "inbox-search.restore-archive") {
    c.add("real-stated-prior-chat-operation", !!first && archiveComplete(first, false) && o.state.setupQuerySent === true,
      "The stated previous cleanup is a genuine persisted human turn and actual CEO archive operation on exactly three known items.");
    const restored = o.activity.filter(row => row.action === "issue.inbox_unarchived" && row.agentId === o.leadId);
    const missing = o.state.unrestorableTask as Entity | undefined;
    const available = eligible(o).filter(row => row.id !== missing?.id);
    c.add("only-operation-items-restored", eligible(o).length === 3 && available.length === 2 && available.every(row => !o.ownerItems.find(item => item.id === row.id)?.archivedAt)
      && restored.length === available.length && restored.every(event => available.some(row => row.id === event.entityId) && event.details?.userId === o.state.personId),
      "Only this person's two still-restorable operation IDs are restored, with real attributed unarchive events.");
    const historical = o.state.historicalArchive as InboxItem | undefined;
    c.add("unrelated-history-remains-archived", !!historical && o.ownerItems.some(row => row.id === historical.id && row.archivedAt === historical.archivedAt && !!row.archivedAt)
      && !restored.some(row => row.entityId === historical.id), "An unrelated earlier archive remains intact instead of clearing all historical preferences.");
    c.add("unrestorable-item-reported-separately", !!missing && o.unrestorableStatus === 404 && !o.tasks.some(row => row.id === missing.id)
      && o.activity.some(row => row.action === "issue.deleted" && row.entityId === missing.id && row.actorType === "user" && row.actorId === o.state.personId)
      && [missing.identifier, missing.id, missing.title].filter(Boolean).some(name => o.phaseReply.includes(name!))
      && /\b(?:cannot|can't|couldn't|no longer|deleted|removed|unavailable|not found)\b/i.test(o.phaseReply),
      "After a real owner deletion between cleanup and undo, the final phase identifies the actual missing item instead of claiming it was restored.");
    c.add("truthful-restore-count", /\b(?:2|two)\b/i.test(o.phaseReply) && /\b(?:restor|unarchiv|undo|undone)/i.test(o.phaseReply), "The final reply accurately distinguishes two confirmed restores from the one unavailable item.");
  } else c.add("implemented-scenario", false, "This oracle does not implement this scenario.");
  return c.result();
}
export function inboxTriageControlTaskSeeds(personId: string) {
  return [
    { title: "Cancelled experiment", status: "cancelled" },
    { title: "Active launch work", status: "in_progress", assigneeUserId: personId },
    { title: "Launch review", status: "in_review" },
    { title: "Unanswered launch decision", status: "backlog" },
  ];
}
function triageCase(scenarioId: string): ChatCatalogCase {
  let other: Awaited<ReturnType<typeof createAuthenticatedPerson>> | undefined;
  let observe: (ctx: ChatCatalogContext, state: Record<string, unknown>) => Promise<TriageObservation>;
  const base = makeDefinition(scenarioId, async ctx => {
    const browser = ctx.input.page.context().browser();
    if (!browser || !ctx.input.privateSecrets) throw new Error("Personal triage requires authenticated independent people and private credential redaction");
    other = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets: ctx.input.privateSecrets, name: "Riley" });
    try {
      await enrollPrerequisitePerson(ctx, other, "operator");
      const session = await ctx.input.api.get<{ user?: { id: string } }>("/api/auth/get-session");
      if (!session.user?.id) throw new Error("Personal inbox target is not a real authenticated human");
      const p = await project(ctx); const originalTasks: Entity[] = [];
      for (let index = 0; index < (scenarioId === "inbox-search.archive-done" ? 501 : 3); index++)
        originalTasks.push(await task(ctx, `Done launch preparation ${String(index + 1).padStart(3, "0")}`, p.id, { status: "done" }));
      for (const { title, ...fields } of inboxTriageControlTaskSeeds(session.user.id))
        originalTasks.push(await task(ctx, title, p.id, fields));
      const unanswered = originalTasks.at(-1)!;
      const question = await ctx.input.api.post<Entity>(`/api/issues/${unanswered.id}/interactions`, createIssueThreadInteractionSchema.parse({
        kind: "ask_user_questions", title: "Unanswered launch decision", continuationPolicy: "none", resolverPolicy: "human_only", addresseeUserId: session.user.id,
        payload: { version: 1, supersedeOnUserComment: false, questionSet: { schema: "paperclip.question_set.v1", questions: [{ id: "launch-choice", prompt: "Which launch copy should we use?", answerMode: "text", required: true }] } },
      }));
      const root = `/api/companies/${ctx.input.fixtures.company.id}`;
      const response = await other.request(`${root}/issues`, "POST", { title: "Riley's separate Done task", status: "done", projectId: p.id });
      if (!response.ok) { await response.body?.cancel(); throw new Error("The independent person's prerequisite task was not created through its own session"); }
      const otherTask = await response.json() as InboxItem;
      await (await other.request(`/api/issues/${otherTask.id}/inbox-archive`, "DELETE", {})).body?.cancel();
      const initial = await ctx.input.api.get<InboxItem[]>(ownerPath(ctx));
      for (const item of initial.filter(row => originalTasks.some(original => original.id === row.id) && row.archivedAt))
        await ctx.input.api.delete(`/api/issues/${item.id}/inbox-archive`);
      await ctx.input.api.putSensitive(`${root}/users/me/inbox-agent-policy`, { mode: "allowlist", allowedAgentIds: [ctx.input.fixtures.agent.id] });
      let historicalArchive: InboxItem | undefined;
      if (scenarioId === "inbox-search.restore-archive") {
        const historical = await task(ctx, "An unrelated historical archive", p.id, { status: "done" });
        await ctx.input.api.post(`/api/issues/${historical.id}/inbox-archive`, {});
        historicalArchive = (await ctx.input.api.get<InboxItem[]>(ownerPath(ctx))).find(row => row.id === historical.id);
        if (!historicalArchive?.archivedAt) throw new Error("The unrelated archive fixture did not persist");
      }
      const otherItems = await other.request(`${root}/issues?touchedByUserId=me&includeAgentCreatedTasks=true&limit=1000`);
      if (!otherItems.ok) { await otherItems.body?.cancel(); throw new Error("Independent person's inbox is not readable"); }
      const otherPersonTask = (await otherItems.json() as InboxItem[]).find(row => row.id === otherTask.id);
      if (!otherPersonTask || otherPersonTask.archivedAt) throw new Error("The other person's visible Done prerequisite is unavailable");
      const state: Record<string, unknown> = { project: p, originalTasks, personId: session.user.id, otherPersonTask, question, historicalArchive };
      const ownerBefore = await ctx.input.api.get<InboxItem[]>(ownerPath(ctx));
      if (!originalTasks.every(row => ownerBefore.some(item => item.id === row.id && !item.archivedAt))) throw new Error("The initial personal inbox does not contain all stated eligible and protected statuses");
      if (scenarioId === "inbox-search.restore-archive") {
        for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: ctx.input.fixtures.agent.id }])
          await ctx.input.api.post(`${root}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
        const query = `Archive these three Done launch preparation tasks from my inbox: ${originalTasks.filter(row => row.status === "done").map(row => row.identifier ?? row.id).join(", ")}.`;
        const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, query); state.setupQuerySent = true;
        const first = await waitForArchive(ctx, state, observe, false); state.firstArchive = { ...first, state: structuredClone(state) };
        await ctx.input.evidence("chat-catalog-real-prior-inbox-operation.json", state.firstArchive);
        const missing = originalTasks.filter(row => row.status === "done")[2]!;
        await ctx.input.api.delete(`/api/issues/${missing.id}`); state.unrestorableTask = missing;
        await ctx.input.evidence("chat-catalog-between-cleanup-and-undo-deletion.json", { taskId: missing.id, actorUserId: session.user.id, action: "Owner deletes one archived item through the supported public task delete API before the canonical undo request." });
      }
      return state;
    } catch (error) { await other.dispose(); other = undefined; throw error; }
  }, gradeInboxTriage);
  observe = async (ctx, state) => {
    if (!other) throw new Error("Missing independent inbox owner");
    const o = await observeInternal(ctx, state); const root = `/api/companies/${o.companyId}`;
    const [ownerItems, policy, questionRows] = await Promise.all([
      ctx.input.api.get<InboxItem[]>(ownerPath(ctx)), ctx.input.api.get<TriageObservation["policy"]>(`${root}/users/me/inbox-agent-policy`),
      ctx.input.api.get<TriageObservation["questions"]>(`/api/issues/${(state.originalTasks as Entity[]).at(-1)!.id}/interactions`),
    ]);
    const response = await other.request(`${root}/issues?touchedByUserId=me&includeAgentCreatedTasks=true&limit=1000`);
    if (!response.ok) { await response.body?.cancel(); throw new Error("Independent user's inbox read failed"); }
    const first = state.firstArchive as TriageObservation | undefined;
    const firstRunIds = new Set(first?.runs.map(row => row.id) ?? []);
    const source = ctx.issue(); const comments = source ? await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`) : [];
    const phaseReply = comments.filter(row => row.authorAgentId === o.leadId && o.runs.some(run => run.id === row.createdByRunId)
      && (!first || !firstRunIds.has(row.createdByRunId ?? ""))).map(row => row.body ?? "").join("\n");
    let unrestorableStatus: number | undefined;
    if (state.unrestorableTask) {
      try { await ctx.input.api.get(`/api/issues/${entity(state, "unrestorableTask").id}`); unrestorableStatus = 200; }
      catch (error) { if (error instanceof RunnerApiHttpError) unrestorableStatus = error.status; else throw error; }
    }
    return { ...o, ownerItems, policy, phaseReply, unrestorableStatus, questions: questionRows, otherPersonItems: await response.json() as InboxItem[] };
  };
  return { ...base, authentication: "human-session", expectedRunCount: 2, minimumRunCount: 2, expectedHumanMessageCount: 2,
    ...(scenarioId === "inbox-search.restore-archive" ? { setupHumanMessageCount: 1 } : {}), attemptTimeoutMs: 600_000, observe,
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-inbox-triage.ts", "chat-catalog-domains/identity-auth.ts", "../../packages/shared/src/validators/issue.ts"],
    ...(scenarioId === "inbox-search.archive-done" ? { async act(ctx: ChatCatalogContext, state: Record<string, unknown>) {
      const first = await waitForArchive(ctx, state, observe, true); state.firstArchive = { ...first, state: structuredClone(state) };
      await ctx.input.evidence("chat-catalog-before-repeated-inbox-cleanup.json", state.firstArchive);
      const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, ctx.scenario.query);
    } } : {}),
    async verifyResult(ctx, _state, value) {
      const o = value as TriageObservation; const source = ctx.input.page.url();
      await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/inbox/mine`, o.origin).href, { waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByText("Active launch work", { exact: true }).first()).toBeVisible();
      await ctx.input.evidence("chat-catalog-personal-triage-mine-opened.json", { personId: o.state.personId, url: ctx.input.page.url(), visible: true });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    },
    async cleanup() { await other?.dispose(); other = undefined; },
  };
}
async function waitForArchive(ctx: ChatCatalogContext, state: Record<string, unknown>, observe: (ctx: ChatCatalogContext, state: Record<string, unknown>) => Promise<TriageObservation>, many: boolean) {
  return pollUntil({ label: "Actual personal Done-only archive operation", deadlineAt: Date.now() + 240_000,
    load: () => observe(ctx, state), accept: o => o.runs.length === 1 && o.runs.every(row => row.status === "succeeded") && ctx.issue()?.conversationState === "waiting" && archiveComplete(o, many) });
}
export const inboxTriageCases: readonly ChatCatalogCase[] = [triageCase("inbox-search.archive-done"), triageCase("inbox-search.restore-archive")];
