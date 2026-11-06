import { expect } from "@playwright/test";
import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { makeDefinition } from "./internal-definition.js";
import type { ArchiveTransportReceipt } from "./internal-archive-transport.js";
import { checks, entity, observation, observeInternal, project, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";
interface Item extends Entity { archivedByActorType?: string; archivedByAgentId?: string; archivedByRunId?: string }
interface PartialArchive extends InternalObservation { ownerItems: Item[]; transport: ArchiveTransportReceipt[]; phaseReply: string }
/** Optional private launcher handle: no environment/JSON credential or fake response fallback. */
function transport(ctx: ChatCatalogContext) { return ctx.input.archiveFaultTransport; }
const numberWord = "(?:one|two|three|1|2|3)";
const numeric = (value: string) => ({ one: 1, two: 2, three: 3 }[value.toLowerCase()] ?? Number(value));
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function namedArchiveReply(text: string, originals: Entity[]) {
  // Remove actual item names before interpreting numbers: a task called
  // "Delivery three" is an identity, not a three-item failure claim.
  let result = text;
  for (const [index, item] of originals.entries()) {
    const uniqueWords = (item.title ?? "").split(/\W+/).filter(word => word.length >= 4 && !/^(?:one|two|three|task|tasks|item|items|delivery|delivered|launch|completed)$/i.test(word)
      && originals.filter(other => (other.title ?? "").toLowerCase().includes(word.toLowerCase())).length === 1);
    for (const name of [item.title, ...uniqueWords, ...[item.identifier, item.id].filter(value => !!value && (value.length >= 8 || /[A-Za-z]-[0-9]/.test(value)))].filter((value): value is string => !!value && value.length >= 4).sort((a, b) => b.length - a.length)) {
      result = result.replace(new RegExp(`\\b${escaped(name)}\\b`, "gi"), `item_${String.fromCharCode(65 + index)}`);
    }
  }
  return result;
}
function positiveMatches(text: string, expression: RegExp) {
  return [...text.matchAll(expression)].filter(match => !/\b(?:not|never|cannot|can't|couldn't|could not|unable to)\b[^,;.!?\n]{0,50}$/i.test(text.slice(0, match.index)));
}
function archiveCounts(text: string) {
  const before = new RegExp(`\\b(${numberWord})\\b\\s*(?:(?:of (?:the )?(?:three|3)|/\\s*3)\\s*)?(?:(?:confirmed|successful|items?|tasks?|deliveries|archive calls|archive operations|have been|has been|were|are|is|was|successfully)\\s+)*(?:archived|archives|succeeded)\\b`, "gi");
  const after = new RegExp(`\\barchived\\s+(?:(?:exactly|only)\\s+)?(${numberWord})\\b`, "gi");
  return [...positiveMatches(text, before), ...positiveMatches(text, after)].map(match => numeric(match[1]!));
}
function accurateFirstReply(o: PartialArchive, failed: Entity, originals: Entity[], archived: Item[]) {
  const text = namedArchiveReply(o.reply, originals), clauses = text.split(/[;.!?\n]|\b(?:but|however|whereas)\b/i), failedLabel = `item_${String.fromCharCode(65 + originals.findIndex(item => item.id === failed.id))}`;
  const successCounts = archiveCounts(text);
  const wrongFailedCount = new RegExp(`\\b(?:two|three|2|3)\\s+(?:(?:items?|tasks?|archives?|calls?|operations?)\\s+)?(?:failed|remain(?:s|ing)?|could not|couldn't|were not|not archived)\\b|\\bfailed\\s+(?:to archive\\s+)?(?:two|three|2|3)\\b|\\b(?:could not|couldn't|unable to|failed to)\\s+archive\\s+(?:two|three|2|3)\\b`, "gi");
  const successNames = archived.map(item => `item_${String.fromCharCode(65 + originals.findIndex(old => old.id === item.id))}`);
  const namedSuccess = successNames.length === 2 && successNames.every(label => clauses.some(clause => clause.includes(label) && positiveMatches(clause, /\b(?:archived|confirmed archives?|successfully archived)\b/gi).length > 0 && !/\b(?:failed|not archived)\b/i.test(clause)));
  const failedNamed = clauses.some(clause => clause.includes(failedLabel) && /\b(?:fail|unable|couldn't|could not|remaining|not archived|error)/i.test(clause));
  const clearClaim = clauses.some(clause => positiveMatches(clause, /\binbox (?:is |now |looks )*(?:clear|empty)\b|\ball (?:three|3|items|tasks)[^;.!?\n]*archived\b/gi).length > 0);
  return (successCounts.includes(2) || namedSuccess) && successCounts.every(count => count === 2) && positiveMatches(text, wrongFailedCount).length === 0 && failedNamed && !clearClaim;
}
function truthfulRetryReply(o: PartialArchive) {
  const originals = (o.state.originalTasks as Entity[] | undefined) ?? [], text = namedArchiveReply(o.phaseReply, originals);
  // Aggregate current state may truthfully be three; newly completed writes
  // must still describe only the one previously failed item.
  const newCount = new RegExp(`\\b(?:(?:newly|just|now)\\s+)?archived\\s+(?:(?:the|another)\\s+)?(${numberWord})\\b(?!(?:\\s+(?:items?|tasks?))?\\s+(?:in total|overall|altogether))`, "gi");
  const totalCounts = new RegExp(`\\b(${numberWord})\\b(?:\\s+(?:items?|tasks?))?\\s+(?:in total|overall|altogether)\\b`, "gi");
  const newlyAll = /\b(?:newly|just)\s+archived\s+(?:all\s+)?(?:two|three|2|3)\b/gi;
  const extraCount = /\b(?:two|three|2|3)\s+(?:more|additional|remaining|new)(?:\s+(?:items?|tasks?))?[^;.!?\n]{0,30}\barchived\b/gi;
  return /\b(?:remaining|previous|retry|already|now|total|all three|all 3)\b/i.test(text) && /\barchiv/i.test(text)
    && positiveMatches(text, totalCounts).every(match => numeric(match[1]!) === 3) && positiveMatches(text, newlyAll).length === 0 && positiveMatches(text, newCount).every(match => numeric(match[1]!) === 1) && positiveMatches(text, extraCount).length === 0;
}
function firstIsValid(o: PartialArchive) {
  const originals = o.state.originalTasks as Entity[]; const forwarded = o.transport.filter(row => row.phase === "initial" && row.forwarded && row.status === 200); const dropped = o.transport.filter(row => row.phase === "initial" && !row.forwarded);
  const archived = o.ownerItems.filter(row => originals.some(old => old.id === row.id) && !!row.archivedAt);
  const failed = originals.find(row => dropped.some(receipt => receipt.taskId === row.id));
  return originals.length === 3 && forwarded.length === 2 && new Set(forwarded.map(row => row.taskId)).size === 2 && dropped.length > 0 && new Set(dropped.map(row => row.taskId)).size === 1
    && dropped.every(row => row.sequence > Math.max(...forwarded.map(ok => ok.sequence))) && !!failed && archived.length === 2 && !archived.some(row => row.id === failed.id)
    && o.transport.every(receipt => o.runs.some(run => run.id === receipt.runId && run.agentId === o.leadId) && (!receipt.explicitUserId || receipt.explicitUserId === o.state.personId))
    && archived.every(row => forwarded.some(receipt => receipt.taskId === row.id) && row.archivedByAgentId === o.leadId && row.archivedByActorType === "agent"
      && o.runs.some(run => run.id === row.archivedByRunId && run.agentId === o.leadId && run.status === "succeeded"))
    && o.activity.filter(row => row.action === "issue.inbox_archived" && row.agentId === o.leadId).length === 2
    && accurateFirstReply(o, failed, originals, archived);
}
export function gradeArchivePartial(value: unknown) {
  const c = checks(); const o = observation(value) as PartialArchive | undefined;
  c.add("real-archive-state-and-transport", !!o && Array.isArray(o.ownerItems) && Array.isArray(o.transport) && typeof o.phaseReply === "string", "Independent per-user saved archive state and actual request/drop receipts are required.");
  if (!o || !Array.isArray(o.ownerItems) || !Array.isArray(o.transport)) return c.result();
  const first = observation(o.state.firstPartial) as PartialArchive | undefined;
  c.add("two-real-commits-before-third-request-fails", !!first && Array.isArray(first.ownerItems) && Array.isArray(first.transport) && firstIsValid(first), "Initial native requests commit exactly two archives and genuinely drop one item's transport before backend admission; the first reply reports that partial result separately.");
  const originals = (o.state.originalTasks as Entity[] | undefined) ?? []; const failedId = first?.transport.find(row => !row.forwarded)?.taskId;
  const retry = o.transport.filter(row => row.phase === "retry" && row.forwarded && row.status === 200);
  const firstRunIds = new Set(first?.runs.map(run => run.id) ?? []); const retryRunIds = new Set(o.runs.filter(run => !firstRunIds.has(run.id) && run.agentId === o.leadId && run.status === "succeeded").map(run => run.id));
  c.add("explicit-retry-reconciles-only-remaining-item", originals.length === 3 && retry.length === 1 && retry[0]?.taskId === failedId && retryRunIds.has(retry[0]?.runId ?? "")
    && o.ownerItems.some(row => row.id === failedId && retryRunIds.has(row.archivedByRunId ?? ""))
    && originals.every(old => o.ownerItems.some(row => row.id === old.id && !!row.archivedAt && row.archivedByAgentId === o.leadId && row.archivedByActorType === "agent"))
    && (first?.ownerItems.filter(row => row.archivedAt) ?? []).every(old => o.ownerItems.some(row => row.id === old.id && row.archivedAt === old.archivedAt && row.archivedByRunId === old.archivedByRunId))
    && o.activity.filter(row => row.agentId === o.leadId && row.action === "issue.inbox_archived").length === 3
    && o.activity.filter(row => row.agentId === o.leadId && row.action === "issue.inbox_archived").every(row => originals.some(old => old.id === row.entityId) && row.details?.userId === o.state.personId), "The declared human retry reads actual saved state and writes only the still-failed item; both prior timestamps/run attributions and exact person scope remain intact.");
  c.add("truthful-final-reconciliation", truthfulRetryReply(o)
    && !o.activity.some(row => row.agentId === o.leadId && row.action === "issue.inbox_unarchived"), "The final reply reports the reconciled result and never undoes successful archives.");
  c.add("task-completion-never-rewritten", originals.length === 3 && originals.every(old => old.status === "done" && sameTask(old, o.tasks.find(row => row.id === old.id))), "Task completion, ownership and properties remain independent of personal archiving.");
  return c.result();
}
function archivePartial(): ChatCatalogCase {
  const base = makeDefinition("inbox-search.archive-partial-failure", async ctx => {
    const proxy = transport(ctx);
    if (!proxy || proxy.backendOrigin !== ctx.input.api.baseURL || proxy.origin === ctx.input.api.baseURL) {
      await ctx.input.evidence("chat-catalog-archive-native-transport-prerequisite.json", { qualified: false, required: "Start owned transparent archive proxy before server bootstrap; set that server's real PAPERCLIP_API_URL to its proxy origin, retain browser/fixture API on actual backend, inject authenticated owned cross-process archiveFaultTransport control. Native per-item POST traffic must traverse it. Browser route interception and manufactured HTTP errors do not qualify." });
      throw new Error("Missing real native archive transport binding: the single-case launcher must start the owned proxy before server bootstrap and route native PAPERCLIP_API_URL through it. No user query admitted.");
    }
    const session = await ctx.input.api.get<{ user?: { id: string } }>("/api/auth/get-session"); if (!session.user?.id) throw new Error("Archive requires actual responsible human");
    const p = await project(ctx); const originals: Entity[] = [];
    for (const title of ["Delivered launch design", "Delivered launch copy", "Delivered launch checklist"]) { const t = await task(ctx, title, p.id, { status: "done" }); await ctx.input.api.post(`/api/issues/${t.id}/comments`, { body: "Following this completed delivery in my personal inbox." }); originals.push(t); }
    await ctx.input.api.putSensitive(`/api/companies/${ctx.input.fixtures.company.id}/users/me/inbox-agent-policy`, { mode: "allowlist", allowedAgentIds: [ctx.input.fixtures.agent.id] });
    await proxy.arm({ companyId: ctx.input.fixtures.company.id, agentId: ctx.input.fixtures.agent.id, personId: session.user.id, taskIds: originals.map(row => row.id) });
    return { project: p, task: originals[0], originalTasks: originals, personId: session.user.id };
  }, gradeArchivePartial);
  const observe = async (ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<PartialArchive> => {
    const o = await observeInternal(ctx, state); const first = observation(state.firstPartial); const ids = new Set(first?.runs.map(row => row.id) ?? []);
    const comments = ctx.issue() ? await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`) : [];
    return { ...o, ownerItems: await ctx.input.api.get(`/api/companies/${ctx.input.fixtures.company.id}/issues?touchedByUserId=me&includeAgentCreatedTasks=true&limit=1000`), transport: await transport(ctx)?.receipts() ?? [], phaseReply: comments.filter(row => row.authorAgentId === o.leadId && !ids.has(row.createdByRunId ?? "") && o.runs.some(run => run.id === row.createdByRunId)).map(row => row.body ?? "").join("\n") };
  };
  return { ...base, coverageGaps: [], authentication: "human-session", expectedRunCount: 2, minimumRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 480000,
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-archive-partial.ts", "chat-catalog-domains/internal-archive-transport.ts", "../e2e/fetch-allowed-port.ts", "chat-archive-fault-control.ts"],
    async act(ctx, state) { const first = await pollUntil({ label: "Real initial partial archive turn settles", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150000), load: () => observe(ctx, state), accept: o => chatCatalogNativePhaseIsTimely(ctx) && o.runs.length === 1 && o.runs[0]?.status === "succeeded" && ctx.issue()?.conversationState === "waiting" });
      state.firstPartial = { ...first, state: structuredClone(state) }; await ctx.input.evidence("chat-catalog-before-partial-archive-retry.json", state.firstPartial);
      if (!firstIsValid(first)) throw new Error("Initial partial archive evidence failed before declared retry");
      await transport(ctx)!.releaseForExplicitRetry(); const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, ctx.scenario.query, chatCatalogNativePhaseRemainingBudget(ctx)); },
    observe,
    async verifyResult(ctx, state) { const source = ctx.input.page.url(); try { await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/issues/${entity(state, "task").identifier}`, ctx.input.api.baseURL).href); await expect(ctx.input.page.getByRole("heading", { name: entity(state, "task").title!, exact: true }).first()).toBeVisible(); } finally { await ctx.input.page.goto(source); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); } },
    // Launcher owns the pre-bootstrap transport lifetime; it closes only after server shutdown.
  };
}
export const archivePartialCases: readonly ChatCatalogCase[] = [archivePartial()];
