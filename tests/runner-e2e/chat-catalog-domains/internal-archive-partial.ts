import { expect } from "@playwright/test";
import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { armArchiveStorageFault, type ArchiveStorageFault } from "../chat-archive-storage-fault.js";
import { makeDefinition } from "./internal-definition.js";
import { checks, entity, hasLink, observation, observeInternal, project, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";
interface Item extends Entity { archivedByActorType?: string; archivedByAgentId?: string; archivedByRunId?: string }
interface PartialArchive extends InternalObservation { ownerItems: Item[]; phaseReply: string }
const ORACLE = "paperclip.chat-catalog.inbox.archive-partial-failure.v3";
/** Handles live outside case state: state is cloned into evidence. */
const faults = new Map<string, ArchiveStorageFault>();

const archivedRows = (o: PartialArchive, originals: Entity[]) => o.ownerItems.filter(row => originals.some(old => old.id === row.id) && !!row.archivedAt);
const archiveEvents = (o: PartialArchive) => o.activity.filter(row => row.action === "issue.inbox_archived" && row.agentId === o.leadId);
const leadRun = (o: PartialArchive, runId: string | undefined, ids?: Set<string>) => !!runId && o.runs.some(run => run.id === runId && run.agentId === o.leadId && run.status === "succeeded" && (!ids || ids.has(run.id)));

/** Unarchiving an item that never archived is a harmless reset; undoing a saved archive hides the outcome. */
const undidSavedArchive = (o: PartialArchive, archivedIds: string[]) => o.activity.some(row => row.agentId === o.leadId && row.action === "issue.inbox_unarchived" && archivedIds.includes(row.entityId ?? ""));
/**
 * Whether the reply names the failed item by an exact product identity: a link,
 * its identifier or its seeded title. This is an identity reference, not a
 * reading of the reply's meaning; the reply's claims are read by a human
 * against the saved state below.
 */
function identifiesItem(o: PartialArchive, item: Entity) {
  const exact = (value: string) => { const alnum = /[A-Za-z0-9]/; for (let at = o.reply.indexOf(value); at >= 0; at = o.reply.indexOf(value, at + 1)) {
    const before = o.reply[at - 1] ?? " ", after = o.reply[at + value.length] ?? " ";
    if (!alnum.test(before) && before !== "-" && !alnum.test(after)) return true; } return false; };
  return hasLink(o, "issues", item) || [item.identifier, item.title].some(value => !!value && exact(value));
}
/** The person's saved inbox state is the outcome. Reply wording is never pattern-matched. */
function firstIsValid(o: PartialArchive) {
  const originals = (o.state.originalTasks as Entity[] | undefined) ?? [], failures = (o.state.injectedFailures as Record<string, number> | undefined) ?? {};
  const archived = archivedRows(o, originals), failed = originals.filter(row => !archived.some(done => done.id === row.id));
  const events = archiveEvents(o);
  return originals.length === 3 && archived.length === 2 && failed.length === 1
    // The storage fault really fired, and only on the item that stayed unarchived.
    && (failures[failed[0]!.id] ?? 0) >= 1 && archived.every(row => (failures[row.id] ?? 0) === 0)
    && archived.every(row => row.archivedByActorType === "agent" && row.archivedByAgentId === o.leadId && leadRun(o, row.archivedByRunId))
    && events.length === 2 && events.every(row => archived.some(done => done.id === row.entityId) && row.details?.userId === o.state.personId)
    && !undidSavedArchive(o, archived.map(row => row.id))
    && identifiesItem(o, failed[0]!);
}
export function gradeArchivePartial(value: unknown) {
  const c = checks(); const o = observation(value) as PartialArchive | undefined;
  c.add("saved-archive-state-observed", !!o && Array.isArray(o.ownerItems) && typeof o.phaseReply === "string", "The person's saved per-user archive state and the retry reply are required.");
  if (!o || !Array.isArray(o.ownerItems)) return c.result();
  const first = observation(o.state.firstPartial) as PartialArchive | undefined;
  c.add("two-saved-archives-and-one-real-storage-failure", !!first && Array.isArray(first.ownerItems) && firstIsValid(first), "The first turn saves exactly two archives for the person; the product's own write for the third fails in storage, that item stays in the inbox, and the reply identifies it.");
  const originals = (o.state.originalTasks as Entity[] | undefined) ?? [];
  const firstArchived = first ? archivedRows(first, originals) : [];
  const failedId = originals.find(row => !firstArchived.some(done => done.id === row.id))?.id;
  const firstRunIds = new Set(first?.runs.map(run => run.id) ?? []);
  const retryRunIds = new Set(o.runs.filter(run => !firstRunIds.has(run.id) && run.agentId === o.leadId && run.status === "succeeded").map(run => run.id));
  const events = archiveEvents(o);
  c.add("retry-archives-only-the-remaining-item", originals.length === 3 && firstArchived.length === 2 && !!failedId
    && originals.every(old => o.ownerItems.some(row => row.id === old.id && !!row.archivedAt && row.archivedByAgentId === o.leadId && row.archivedByActorType === "agent"))
    && o.ownerItems.some(row => row.id === failedId && leadRun(o, row.archivedByRunId, retryRunIds))
    // No duplicate writes: the two earlier archives keep their original time and run.
    && firstArchived.every(old => o.ownerItems.some(row => row.id === old.id && row.archivedAt === old.archivedAt && row.archivedByRunId === old.archivedByRunId))
    && events.length === 3 && events.every(row => originals.some(old => old.id === row.entityId) && row.details?.userId === o.state.personId)
    && events.filter(row => row.entityId === failedId).length === 1, "The second request archives only the item that failed, for the same person, without rewriting the two earlier archives.");
  c.add("successful-archives-never-undone", !undidSavedArchive(o, originals.map(row => row.id).filter(id => id !== failedId)) && o.phaseReply.trim().length > 0, "The retry replies in the conversation and never unarchives items to hide the failure.");
  c.add("task-completion-never-rewritten", originals.length === 3 && originals.every(old => old.status === "done" && sameTask(old, o.tasks.find(row => row.id === old.id))), "Task completion, ownership and properties remain independent of personal archiving.");
  return c.result();
}
function archivePartial(): ChatCatalogCase {
  const base = makeDefinition("inbox-search.archive-partial-failure", async ctx => {
    const session = await ctx.input.api.get<{ user?: { id: string } }>("/api/auth/get-session"); if (!session.user?.id) throw new Error("Archive requires actual responsible human");
    const p = await project(ctx); const originals: Entity[] = [];
    for (const title of ["Delivered launch design", "Delivered launch copy", "Delivered launch checklist"]) { const t = await task(ctx, title, p.id, { status: "done" }); await ctx.input.api.post(`/api/issues/${t.id}/comments`, { body: "Following this completed delivery in my personal inbox." }); originals.push(t); }
    await ctx.input.api.putSensitive(`/api/companies/${ctx.input.fixtures.company.id}/users/me/inbox-agent-policy`, { mode: "allowlist", allowedAgentIds: [ctx.input.fixtures.agent.id] });
    // Armed last: the fault only matches agent-attributed archive writes for these three tasks.
    faults.set(ctx.input.fixtures.company.id, await armArchiveStorageFault({ executionId: ctx.input.execution.id,
      binding: { companyId: ctx.input.fixtures.company.id, agentId: ctx.input.fixtures.agent.id, personId: session.user.id, taskIds: originals.map(row => row.id) } }));
    return { project: p, task: originals[0], originalTasks: originals, personId: session.user.id };
  }, gradeArchivePartial);
  const observe = async (ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<PartialArchive> => {
    const o = await observeInternal(ctx, state); const first = observation(state.firstPartial); const ids = new Set(first?.runs.map(row => row.id) ?? []);
    const comments = ctx.issue() ? await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`) : [];
    return { ...o, ownerItems: await ctx.input.api.get(`/api/companies/${ctx.input.fixtures.company.id}/issues?touchedByUserId=me&includeAgentCreatedTasks=true&limit=1000`), phaseReply: comments.filter(row => row.authorAgentId === o.leadId && !ids.has(row.createdByRunId ?? "") && o.runs.some(run => run.id === row.createdByRunId)).map(row => row.body ?? "").join("\n") };
  };
  return { ...base, oracleVersion: ORACLE, coverageGaps: [], authentication: "human-session", expectedRunCount: 2, minimumRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 480000,
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-archive-partial.ts", "chat-archive-storage-fault.ts"],
    async act(ctx, state) {
      const fault = faults.get(ctx.input.fixtures.company.id); if (!fault) throw new Error("Archive storage fault was not armed for this attempt");
      const first = await pollUntil({ label: "Initial partial archive turn settles", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150000), load: () => observe(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && o.runs.length === 1 && o.runs[0]?.status === "succeeded" && ctx.issue()?.conversationState === "waiting" });
      state.injectedFailures = await fault.failures();
      state.firstPartial = { ...first, state: structuredClone(state) }; await ctx.input.evidence("chat-catalog-before-partial-archive-retry.json", state.firstPartial);
      if (!firstIsValid(first)) throw new Error("Initial partial archive evidence failed before declared retry");
      // The storage fault clears before the person asks again, like a transient outage ending.
      await fault.release(); const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, ctx.scenario.query, chatCatalogNativePhaseRemainingBudget(ctx)); },
    observe,
    async verifyResult(ctx, state) { const source = ctx.input.page.url(); try { await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/issues/${entity(state, "task").identifier}`, ctx.input.api.baseURL).href); await expect(ctx.input.page.getByRole("heading", { name: entity(state, "task").title!, exact: true }).first()).toBeVisible(); } finally { await ctx.input.page.goto(source); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); } },
    async cleanup(ctx) { const fault = faults.get(ctx.input.fixtures.company.id); faults.delete(ctx.input.fixtures.company.id); await fault?.close(); },
  };
}
export const archivePartialCases: readonly ChatCatalogCase[] = [archivePartial()];
