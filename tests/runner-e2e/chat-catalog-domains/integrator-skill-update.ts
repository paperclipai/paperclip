import { readSkillVersionHistory } from "./integrator-skill-versions.js";
import { saveSkillConversationContext } from "./integrator-skill-context.js";
import { factualContextQueryAttachment } from "../chat-query-attachments.js";
import { createHash } from "node:crypto";
import type { CompanySkillDetail, CompanySkillVersion, CompanySkillUpdateStatus } from "../../../packages/shared/src/types/company-skill.js";
import type { SkillSource, SkillSourceRefreshResult } from "../../../packages/shared/src/types/skill-source.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { remainingIdentityObservationBudget } from "./identity-support.js";
import { checks, observation, type InternalObservation } from "./internal-support.js";
import { editableLocalNotes } from "./integrator-skill-source.js";
import { integratorDefinition, inspectResult, observeInternal } from "./integrator-support.js";
// Genuine public history, read-only qualified 2026-10-26. Never substitute a URL
// snapshot, fabricated GitHub server, local fork, or mutable default-branch head.
import { accessibilityUpdatePins } from "./integrator-skill-pins.js";
export { accessibilityUpdatePins } from "./integrator-skill-pins.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const root = (ctx: ChatCatalogContext) => `/api/companies/${ctx.input.fixtures.company.id}`;
interface VisibleSkillReview { runId: string; issueId: string; humanCommentId: string; summary: string; visibleText: string }
interface UpdateObservation extends InternalObservation { visibleReview?: VisibleSkillReview; upstream: CompanySkillDetail; localFork: CompanySkillDetail; upstreamVersions: CompanySkillVersion[]; forkVersions: CompanySkillVersion[]; source: SkillSource; updateStatus: Pick<CompanySkillUpdateStatus, "supported" | "currentRef" | "latestRef" | "hasUpdate"> }
// Only a committed current native completion can contribute rendered review text.
export function acceptedSkillReviewRun(o: InternalObservation, issueId: string) {
  if (o.runs.length !== 1) return undefined;
  const run = o.runs[0]!, result = run.resultJson, native = result?.nativeResult as Record<string, unknown> | undefined;
  return run.companyId === o.companyId && run.agentId === o.leadId && run.status === "succeeded" && run.runtimeMode === "native"
    && run.contextSnapshot?.issueId === issueId && (run.nativeIssueId == null || run.nativeIssueId === issueId)
    && typeof run.contextSnapshot?.commentId === "string"
    && result?.finalizationPhase === "committed" && result.finalizationReasonCode === "conversation_turn_finished"
    && result.prpRunTerminalState === "succeeded" && result.prpTurnTerminalState === "completed"
    && native?.schema === "paperclip.run_result.v1" && native.reportedWorkDisposition === "done"
    && typeof result.summary === "string" && result.summary.trim() && native.summary === result.summary ? run : undefined;
}
export function readVisibleSkillReview(input: { runId: string; humanCommentId: string }) {
  const visible = (node: Element) => {
    for (let element: Element | null = node; element; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if (element.hasAttribute("hidden") || element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true"
        || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return node.getClientRects().length > 0;
  };
  const selector = '[data-testid="task-chat-thread"], [data-testid="thread-root"]';
  const roots = [...document.querySelectorAll(selector)].filter(root => visible(root)
    && [...root.querySelectorAll("[id]")].some(node => node.id === `comment-${input.humanCommentId}` && node.closest(selector) === root));
  if (roots.length !== 1) return "";
  return [...roots[0]!.querySelectorAll("[data-thread-anchor]")].filter(node => {
    const anchor = node.getAttribute("data-thread-anchor");
    return node.closest(selector) === roots[0] && (anchor === `${input.runId}:turn` || anchor?.startsWith(`${input.runId}:turn:`));
  }).flatMap(turn => [...turn.querySelectorAll('[data-testid="task-chat-final-response"]')]
    .filter(node => visible(node)).map(node => (node as HTMLElement).innerText)).join("\n");
}
export async function waitForVisibleSkillReview(ctx: ChatCatalogContext, input: { runId: string; humanCommentId: string }) {
  remainingIdentityObservationBudget(ctx);
  return pollUntil({ label: "current visible skill-review completion", deadlineAt: ctx.observationDeadlineAt!, intervalMs: 250,
    load: () => ctx.input.page.evaluate(readVisibleSkillReview, input),
    accept: text => Date.now() < ctx.observationDeadlineAt! && !!text.trim(),
  });
}
export function skillReviewPreviewText(o: UpdateObservation) {
  const evidence = o.visibleReview, issueId = o.state.sourceIssueId;
  if (!evidence || typeof issueId !== "string") return o.reply;
  const run = acceptedSkillReviewRun(o, issueId);
  return run && evidence.runId === run.id && evidence.issueId === issueId && evidence.humanCommentId === run.contextSnapshot?.commentId
    && evidence.summary === run.resultJson?.summary && evidence.visibleText.trim() ? `${o.reply}\n${evidence.visibleText}` : o.reply;
}
const updateReceipts = new WeakMap<ChatCatalogContext, { localDigest: string; status: UpdateObservation["updateStatus"] }>();
async function observeUpdate(ctx: ChatCatalogContext, state: Record<string, unknown>, checkpoint = false): Promise<UpdateObservation> {
  const base = await observeInternal(ctx, state); const api = ctx.input.api; const upstream = state.upstream as CompanySkillDetail; const local = state.localFork as CompanySkillDetail;
  const saved = { upstream: await api.get<CompanySkillDetail>(`${root(ctx)}/skills/${upstream.id}`), localFork: await api.get<CompanySkillDetail>(`${root(ctx)}/skills/${local.id}`),
    upstreamVersions: await readSkillVersionHistory(api, ctx.input.fixtures.company.id, upstream.id), forkVersions: await readSkillVersionHistory(api, ctx.input.fixtures.company.id, local.id),
    source: await api.get<SkillSource>(`${root(ctx)}/skill-sources/${(state.source as SkillSource).id}`) };
  // This is the same genuine semantic checkpoint, not another provider read.
  // Only the exact immutable public commit can retain it during grade settling;
  // mutable remote refs must be read again even if local state is unchanged.
  const localDigest = hash(JSON.stringify({ companyId: ctx.input.fixtures.company.id, sourceId: ctx.issue()?.id,
    humanQueries: base.humanQueries, runs: base.runs.map(run => ({ id: run.id, companyId: run.companyId, agentId: run.agentId,
      status: run.status, issueId: run.contextSnapshot?.issueId, commentId: run.contextSnapshot?.commentId })), ...saved })), prior = updateReceipts.get(ctx);
  const immutable = /^[a-f0-9]{40}$/.test(saved.source.trackingRef) && saved.source.trackingRef === accessibilityUpdatePins.newCommit
    && saved.source.fullName.toLowerCase() === new URL(accessibilityUpdatePins.repositoryURL).pathname.slice(1).toLowerCase();
  const status = !checkpoint && immutable && prior?.localDigest === localDigest && prior.status.latestRef === accessibilityUpdatePins.newCommit ? prior.status
    : await api.getSkillSourceUpdateStatus<UpdateObservation["updateStatus"]>(ctx.input.fixtures.company.id, upstream.id);
  updateReceipts.set(ctx, { localDigest, status: { ...status } });
  let visibleReview: VisibleSkillReview | undefined;
  const issueId = ctx.issue()?.id;
  if (checkpoint && issueId) {
    state.sourceIssueId = issueId;
    visibleReview = await collectVisibleSkillReviewFallback(ctx, base, issueId);
  }
  return { ...base, ...saved, updateStatus: status, ...(visibleReview ? { visibleReview } : {}) };
}
function updateObservation(value: unknown): UpdateObservation | undefined { const o = value as UpdateObservation; return observation(value) && !!o.upstream && !!o.localFork && Array.isArray(o.upstreamVersions) && Array.isArray(o.forkVersions) && !!o.source && !!o.updateStatus ? o : undefined; }
function substantiveDiff(reply: string) {
  const clauses = reply.split(/\n+|;|(?<=[.!?])\s+/).filter(line => !/\b(?:no new|does not add|doesn't add|not added|removed|no longer required)\b/i.test(line));
  const recurring = clauses.some(line => /re.test|regression|each (?:change|build)|every (?:change|build)|continuous/i.test(line) && /test|accessib/i.test(line));
  const forms = clauses.some(line => /forms?/i.test(line) && /small|step|split|break|segment/i.test(line));
  const clutter = clauses.some(line => /clutter|overus|redundan|crowd|overload|breath|spacing/i.test(line) && /layout|pattern|control|design|interface|element/i.test(line));
  return [recurring, forms, clutter].filter(Boolean).length >= 2;
}
function claimsAppliedUpdate(reply: string) {
  return [...reply.matchAll(/\b(?:I (?:have )?(?:updated|applied|installed)|update (?:is |has been )?(?:applied|installed|complete))\b/gi)]
    .some(match => !/^update /i.test(match[0]) || !/\bno\s+$/i.test(reply.slice(0, match.index)));
}
function previewNarrativeCorrect(reply: string) {
  return (reply.includes(accessibilityUpdatePins.oldCommit.slice(0, 7)) || /(?:installed|current|currently)[^\n]{0,80}\b0\.4\b|\b0\.4\b[^\n]{0,80}(?:installed|current)/i.test(reply))
    && substantiveDiff(reply) && !claimsAppliedUpdate(reply);
}
export async function collectVisibleSkillReviewFallback(ctx: ChatCatalogContext, base: InternalObservation, issueId: string): Promise<VisibleSkillReview | undefined> {
  // A complete persisted review is already the ordinary user-facing answer.
  // Its deduplicated native bubble need not exist for the original path to pass.
  if (previewNarrativeCorrect(base.reply)) return undefined;
  const run = acceptedSkillReviewRun(base, issueId);
  if (!run) return undefined;
  const humanCommentId = run.contextSnapshot!.commentId as string;
  const visibleText = await waitForVisibleSkillReview(ctx, { runId: run.id, humanCommentId });
  return { runId: run.id, issueId, humanCommentId, summary: run.resultJson!.summary as string, visibleText };
}
function previewCorrect(o: UpdateObservation) {
  const before = o.state.upstream as CompanySkillDetail;
  const reply = skillReviewPreviewText(o);
  return o.upstream.currentVersionId === before.currentVersionId && o.upstream.sourceRef === accessibilityUpdatePins.oldCommit && hash(o.upstream.markdown) === accessibilityUpdatePins.oldSha256
    && o.source.lastScanCommit === accessibilityUpdatePins.oldCommit && o.source.trackingRef === accessibilityUpdatePins.newCommit && o.source.automaticUpdates === false
    && o.updateStatus.supported && o.updateStatus.hasUpdate && o.updateStatus.currentRef === accessibilityUpdatePins.oldCommit && o.updateStatus.latestRef === accessibilityUpdatePins.newCommit
    && previewNarrativeCorrect(reply);
}
export function gradeIntegratorSkillUpdate(value: unknown) {
  const c = checks(); const o = updateObservation(value); c.add("real-tracked-source-and-saved-versions", !!o, "Requires actual public GitHub source tracking, installed snapshot versions and preserved editable fork."); if (!o) return c.result();
  const first = updateObservation(o.state.reviewCheckpoint); const before = o.state.upstream as CompanySkillDetail; const local = o.state.localFork as CompanySkillDetail;
  c.add("review-diff-before-update", !!first && previewCorrect(first), "The canonical first answer presents substantive genuine 0.4→0.5 source changes and actual current revision while leaving the installed snapshot unchanged.");
  c.add("explicit-normal-version-update-completed", o.upstream.id === before.id && o.upstream.currentVersionId !== before.currentVersionId && o.upstream.sourceRef === accessibilityUpdatePins.newCommit && hash(o.upstream.markdown) === accessibilityUpdatePins.newSha256
    && o.source.lastScanCommit === accessibilityUpdatePins.newCommit && o.upstreamVersions.some(version => version.id === before.currentVersionId && version.fileInventory.some(file => file.path === "SKILL.md" && hash(file.content) === accessibilityUpdatePins.oldSha256))
    && o.upstreamVersions.some(version => version.id === o.upstream.currentVersionId && version.fileInventory.some(file => file.path === "SKILL.md" && hash(file.content) === accessibilityUpdatePins.newSha256))
    && o.activity.some(event => event.agentId === o.leadId && event.action === "company.skill_source_refreshed" && event.entityId === o.source.id), "Only the later explicit human request installs the independently pinned actual newer source through normal source/version refresh, preserving the old immutable version.");
  c.add("local-editable-fork-not-overwritten", o.localFork.id === local.id && o.localFork.editable && o.localFork.forkedFromSkillId === before.id && o.localFork.currentVersionId === local.currentVersionId && o.localFork.markdown === local.markdown
    && JSON.stringify(o.forkVersions) === JSON.stringify(o.state.localVersions), "The genuinely editable local fork and unrelated notes remain byte-for-byte and version-for-version unchanged.");
  const later = first && o.reply.startsWith(first.reply) ? o.reply.slice(first.reply.length) : "";
  c.add("actual-installed-result-not-fetch-only", (/\b(?:updat(?:ed|e)|installed|applied)\b/i.test(later) || /\b(?:now|current)\b[^.!?\n]{0,60}\b0\.5\b/i.test(later)) && /accessib|skill/i.test(later)
    && !/\b(?:(?:not|have not|haven't|did not|didn't) (?:yet )?(?:updated|installed|applied)|only fetched|only listed|failed|cannot update|can't update)\b/i.test(later), "The second actual response reports completed installation supported by the saved new version, not merely fetching or listing the source.");
  return c.result();
}
export async function requireSkillUpdatePrerequisite(ctx: ChatCatalogContext, skillId: string) {
  const status = await ctx.input.api.getSkillSourceUpdateStatus<CompanySkillUpdateStatus>(ctx.input.fixtures.company.id, skillId, { timeout: Math.min(30_000, remainingIdentityObservationBudget(ctx)) });
  remainingIdentityObservationBudget(ctx);
  if (status.supported !== true || status.hasUpdate !== true || status.currentRef !== accessibilityUpdatePins.oldCommit
    || status.latestRef !== accessibilityUpdatePins.newCommit || status.trackingRef !== accessibilityUpdatePins.newCommit)
    throw new Error("Actual pinned skill update prerequisite is unavailable; no human request admitted");
  await ctx.input.evidence("chat-skill-update-prerequisite.json", { supported: true, hasUpdate: true, currentPinnedRevisionMatched: true, latestPinnedRevisionMatched: true, trackedPinnedRevisionMatched: true });
  remainingIdentityObservationBudget(ctx);
}
export const integratorSkillUpdateCases = [integratorDefinition("skills", "skills.review-update", async ctx => {
  // Independently requalify immutable public bytes before any model admission.
  for (const [commit, expected] of [[accessibilityUpdatePins.oldCommit, accessibilityUpdatePins.oldSha256], [accessibilityUpdatePins.newCommit, accessibilityUpdatePins.newSha256]]) {
    const response = await fetch(`https://raw.githubusercontent.com/KreerC/ACCESSIBILITY.md/${commit}/${accessibilityUpdatePins.path}`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok || hash(await response.text()) !== expected) throw new Error("Pinned public accessibility skill revision is unavailable or changed");
  }
  const imported = await ctx.input.api.post<SkillSourceRefreshResult>(`${root(ctx)}/skill-sources`, { repositoryUrl: accessibilityUpdatePins.repositoryURL, trackingRef: accessibilityUpdatePins.oldCommit, commitSha: accessibilityUpdatePins.oldCommit, selectedPaths: [accessibilityUpdatePins.path], excludedFolders: [] });
  if (imported.imported.length !== 1 || !imported.source.entries.some(entry => entry.path === accessibilityUpdatePins.path && entry.skillId === imported.imported[0]?.id)) throw new Error("Tracked public source did not install the selected actual skill");
  const upstream = await ctx.input.api.get<CompanySkillDetail>(`${root(ctx)}/skills/${imported.imported[0]!.id}`);
  if (upstream.sourceType !== "github" || upstream.sourceRef !== accessibilityUpdatePins.oldCommit || hash(upstream.markdown) !== accessibilityUpdatePins.oldSha256 || upstream.editable) throw new Error("Installed public source is not the immutable old GitHub snapshot");
  const localFork = await editableLocalNotes(ctx, upstream);
  const source = await ctx.input.api.patch<SkillSource>(`${root(ctx)}/skill-sources/${imported.source.id}/settings`, { revision: imported.source.revision, automaticUpdates: false, importNewSkills: false, trackingRef: accessibilityUpdatePins.newCommit });
  if (source.lastScanCommit !== accessibilityUpdatePins.oldCommit || source.trackingRef !== accessibilityUpdatePins.newCommit || source.automaticUpdates !== false) throw new Error("Normal source settings applied an update prematurely");
  await requireSkillUpdatePrerequisite(ctx, upstream.id);
  const selected = await saveSkillConversationContext(ctx, { description: `Selected upstream accessibility skill: ${upstream.name} (${upstream.id}), tracked source ${source.id}. Installed source revision ${upstream.sourceRef}; tracking reference ${source.trackingRef}. Separate editable local copy: ${localFork.name} (${localFork.id}).` });
  return { upstream, localFork, source, factualContextAttachment: selected.factualContextAttachment, localVersions: await readSkillVersionHistory(ctx.input.api, ctx.input.fixtures.company.id, localFork.id, localFork.currentVersionId) };
}, observeUpdate, gradeIntegratorSkillUpdate, async (ctx, state) => { const skill = state.upstream as CompanySkillDetail; await inspectResult(ctx, `/${ctx.input.fixtures.company.issuePrefix}/skills/studio/${skill.id}`, skill.name); },
{ oracleVersion: "paperclip.chat-catalog.integrator.v2", authentication: "human-session", queryAttachments: factualContextQueryAttachment("skill-context.md"), expectedRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 540_000,
  sourceFiles: ["chat-catalog-domains/identity-support.ts", "chat-catalog-domains/integrator-skill-versions.ts", "chat-catalog-domains/integrator-skill-update.ts", "chat-catalog-domains/integrator-skill-source.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/skills.yaml"],
  async act(ctx, state) {
    updateReceipts.delete(ctx);
    const waitForSource = async (count: number, deadlineAt: number) => pollUntil({ label: "actual skill-update source response", deadlineAt, intervalMs: 1000,
      load: async () => { await ctx.refreshIssue(); return ctx.allRuns(); },
      accept: runs => Date.now() < deadlineAt && runs.length === count && runs.every(run => run.status === "succeeded") && ctx.issue()?.conversationState === "waiting",
      reject: runs => runs.length > count || runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Skill update source has failed or excess native work" : undefined });
    remainingIdentityObservationBudget(ctx);
    await waitForSource(1, Math.min(Date.now() + 180_000, ctx.observationDeadlineAt!));
    remainingIdentityObservationBudget(ctx);
    const first = await observeUpdate(ctx, state, true);
    remainingIdentityObservationBudget(ctx);
    state.reviewCheckpoint = { ...first, state: structuredClone(state) }; await ctx.input.evidence("chat-skill-source-review-before-update.json", state.reviewCheckpoint);
    if (!previewCorrect(first)) throw new Error("The initial actual diff review was wrong or installed prematurely; later updates cannot repair it");
    updateReceipts.delete(ctx);
    const { sendChatMessage } = await import("../chat-flow.js"); await sendChatMessage(ctx.input.page, "Apply that reviewed upstream accessibility update now, keeping our editable local copy unchanged.");
    await waitForSource(2, ctx.observationDeadlineAt!);
    remainingIdentityObservationBudget(ctx);
    await observeUpdate(ctx, state, true);
    remainingIdentityObservationBudget(ctx);
  },
})];
