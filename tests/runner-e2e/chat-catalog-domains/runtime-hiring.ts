import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { pollUntil } from "../api.js";
import { conversationLinkLocator } from "../chat-rendered-links.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, unchangedAgent, type RuntimeAgent, type RuntimeObservation } from "./runtime-support.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
interface HireApproval { id: string; companyId: string; type: string; status: string; requestedByAgentId: string | null;
  decidedByUserId: string | null; payload: { agentId?: string; name?: string; role?: string; title?: string; reportsTo?: string; adapterType?: string; adapterConfig?: unknown } }
async function pendingHire(ctx: ChatCatalogContext, name: string) {
  return pollUntil({ label: `Actual governed ${name} proposal`, deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
    load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns(),
      approvals: await ctx.input.api.get<HireApproval[]>(`/api/companies/${ctx.input.fixtures.company.id}/approvals`),
      agents: await ctx.input.api.get<RuntimeAgent[]>(`/api/companies/${ctx.input.fixtures.company.id}/agents`) }; },
    accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting" && value.approvals.filter(row => row.type === "hire_agent" && row.status === "pending" && row.payload.name === name).length === 1
      && value.agents.some(row => row.name === name && row.status === "pending_approval")
      && value.runs.every(run => run.agentId === ctx.input.fixtures.agent.id && run.status === "succeeded"),
    reject: value => value.runs.length > 4 || value.runs.some(run => run.agentId !== ctx.input.fixtures.agent.id || ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Governed hire admitted unexpected work or failed" : undefined });
}
/** A same-origin board path to one approval: `/<prefix>/approvals/<id>`, or `/approvals/<id>`, which the UI redirects. */
function approvalPath(origin: string, href: string, approvalId: string, prefixed: boolean) {
  try {
    const url = new URL(href, origin); const parts = url.pathname.replace(/\/+$/, "").split("/").map(decodeURIComponent);
    if (url.origin !== new URL(origin).origin || parts[1] === "api") return false;
    return prefixed ? parts.length === 4 && !!parts[1] && parts[2] === "approvals" && parts[3] === approvalId
      : (parts.length === 3 && parts[1] === "approvals" && parts[2] === approvalId) || (parts.length === 4 && !!parts[1] && parts[2] === "approvals" && parts[3] === approvalId);
  } catch { return false; }
}
/** The reply's rendered links that point at this approval's board page, prefixed or through the UI redirect. */
export function replyApprovalLinks(o: Pick<RuntimeObservation, "origin" | "renderedLinkEvidence">, commentIds: unknown, approvalId: string | undefined) {
  const ids = Array.isArray(commentIds) ? commentIds.map(String) : [];
  return !approvalId || !ids.length ? [] : (o.renderedLinkEvidence ?? []).filter(link => link.source === "reply" && !!link.commentId && ids.includes(link.commentId)
    && approvalPath(o.origin, link.href, approvalId, false));
}
export interface OpenedApprovalLink { href: string | null; approvalId: string; landedPath: string | null; nameVisible: boolean }
/**
 * The reply reports the pending approval by giving the person the exact approval to open and decide. Its wording is
 * not graded; whether the hire ran early is graded from saved state and runs. The harness clicks the reply's link, so
 * an unprefixed link counts only when the UI really lands on that approval's company page showing the proposed hire.
 */
export function repliesLinkApproval(o: RuntimeObservation, commentIds: unknown, approvalId: string | undefined, opened: unknown, companyPrefix: unknown) {
  const click = opened as Partial<OpenedApprovalLink> | undefined;
  return !!approvalId && typeof companyPrefix === "string" && !!companyPrefix && click?.approvalId === approvalId && click.nameVisible === true
    && typeof click.href === "string" && replyApprovalLinks(o, commentIds, approvalId).some(link => link.href === click.href)
    && typeof click.landedPath === "string" && click.landedPath === `/${encodeURIComponent(companyPrefix)}/approvals/${approvalId}`
    && approvalPath(o.origin, click.landedPath, approvalId, true);
}
export function gradeGovernedHire(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("independent-governed-hire-evidence", !!o, "Actual pending proposals, human decisions, preserved intended identity and no premature worker execution are required."); if (!o) return c.result();
  const rejected = o.state.firstProposal as HireApproval | undefined; const accepted = o.state.secondProposal as HireApproval | undefined;
  const approvals = o.state.approvalsAfter as HireApproval[] | undefined;
  const first = approvals?.find(row => row.id === rejected?.id); const second = approvals?.find(row => row.id === accepted?.id);
  c.add("one-proposal-per-explicit-request", !!rejected && !!accepted && rejected.id !== accepted.id && approvals?.length === 2
    && rejected.companyId === o.companyId && accepted.companyId === o.companyId
    && [rejected, accepted].every(row => row.type === "hire_agent" && row.status === "pending" && row.requestedByAgentId === o.leadId
      && row.payload.role === "qa" && !!row.payload.adapterType && row.payload.adapterConfig != null)
    && rejected.payload.name === "Morgan" && accepted.payload.name === "Jules" && o.state.secondRequestAttributed === true,
  "The canonical Morgan proposal and separately changed human Jules request each produce one inspectable QA proposal with real configuration.");
  c.add("rejected-hire-stays-inactive", first?.status === "rejected" && !!first.decidedByUserId && o.state.rejectedBeforeChangedRequest === true
    && !o.agents.some(row => row.id === rejected?.payload.agentId && row.lifecycleState === "ready")
    && o.state.noRepeatedProposalBeforeChangedRequest === true,
  "The genuine human rejection leaves no working Morgan or repeated proposal before the person explicitly changes their request.");
  const before = o.state.acceptedBefore as RuntimeAgent | undefined; const current = o.agents.find(row => row.id === accepted?.payload.agentId);
  c.add("accepted-same-intended-hire", second?.status === "approved" && !!second.decidedByUserId && !!before && !!current
    && current.name === "Jules" && current.companyId === o.companyId && current.lifecycleState === "ready"
    && ["active", "idle"].includes(current.status ?? "") && unchangedAgent(before, current),
  "Human acceptance activates the exact proposed Jules identity and admitted configuration, rather than a replacement employee.");
  c.add("no-worker-before-or-after-decision", o.state.noWorkerBeforeFirstDecision === true && o.state.noWorkerBeforeSecondDecision === true
    && o.runs.length >= 2 && o.runs.length <= 4 && o.runs.every(run => run.agentId === o.leadId && run.status === "succeeded") && o.tasks.length === 0,
  "Neither proposed employee executes before approval, and no unrequested task or employee work is created by either decision.");
  const extra = o.runs.filter(run => !(o.state.requestRunIds as string[]).includes(run.id));
  c.add("bounded-authoritative-decision-notifications", extra.every(run => ["approval.approved", "approval.rejected"].includes(String(run.contextSnapshot?.source))
    && [rejected?.id, accepted?.id].includes(String(run.contextSnapshot?.approvalId))),
  "Any extra provider turn is independently tied to one of these exact real human approval decisions.");
  c.add("reply-links-each-pending-approval", repliesLinkApproval(o, o.state.firstReplyCommentIds, rejected?.id, o.state.firstApprovalLink, o.state.companyPrefix)
    && repliesLinkApproval(o, o.state.secondReplyCommentIds, accepted?.id, o.state.secondApprovalLink, o.state.companyPrefix),
  "Each request's own reply links the exact pending approval, and clicking that link opens the approval's page (directly or through the board redirect).");
  return c.result();
}
/**
 * Clicks the request reply's rendered link to this approval and records where the UI lands. Without such a link the
 * grade fails; the approval page is still opened directly so the later decision phases keep their evidence.
 */
async function openApprovalFromReply(ctx: ChatCatalogContext, state: Record<string, unknown>, runIds: string[], approval: HireApproval, name: string): Promise<OpenedApprovalLink> {
  const page = ctx.input.page; const prefix = ctx.input.fixtures.company.issuePrefix;
  if (typeof prefix !== "string" || !prefix) throw new Error("Approval link inspection requires the actual company prefix");
  const replyIds = async () => (await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`))
    .filter(row => runIds.includes(String(row.createdByRunId)) && row.authorAgentId === ctx.input.fixtures.agent.id).map(row => row.id);
  // The reply can settle before its links render in the thread; wait briefly for them.
  const found = await pollUntil({ label: `${name} approval link rendered in its reply`, deadlineAt: Date.now() + 20_000,
    load: async () => { const o = await observeRuntime(ctx, state); return { o, links: replyApprovalLinks(o, await replyIds(), approval.id) }; },
    accept: value => value.links.length > 0 }).catch(() => undefined);
  const receipt = found?.links[0];
  const landed = (url: URL) => url.pathname === `/${encodeURIComponent(prefix)}/approvals/${approval.id}`;
  if (receipt) {
    await conversationLinkLocator(page, receipt).first().click();
    await page.waitForURL(landed).catch(() => undefined);
  }
  const landedPath = receipt && landed(new URL(page.url())) ? new URL(page.url()).pathname : null;
  if (!landedPath) await page.goto(`/${prefix}/approvals/${approval.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  const opened = { href: receipt?.href ?? null, approvalId: approval.id, landedPath, nameVisible: !!landedPath };
  await ctx.input.evidence(`chat-catalog-${name.toLowerCase()}-approval-link.json`, { ...opened, url: page.url() });
  return opened;
}
export const runtimeHiringCases = [runtimeDefinition("agents.hire-needs-approval", async ctx => {
  await ctx.input.api.patch(`/api/companies/${ctx.input.fixtures.company.id}`, { requireBoardApprovalForNewAgents: true });
  const company = await ctx.input.api.get<{ requireBoardApprovalForNewAgents: boolean }>(`/api/companies/${ctx.input.fixtures.company.id}`);
  if (!company.requireBoardApprovalForNewAgents) throw new Error("Actual company hire approval policy did not persist");
  return { companyRequiresApproval: true };
}, gradeGovernedHire, {
  sourceFiles: ["chat-catalog-domains/runtime-hiring.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agents.yaml"],
  oracleVersion: "paperclip.chat-catalog.runtime-hiring.v4",
  expectedHumanMessageCount: 2, expectedRunCount: 4, minimumRunCount: 2, attemptTimeoutMs: 720_000,
  async act(ctx, state) {
    const root = `/api/companies/${ctx.input.fixtures.company.id}`; const source = ctx.input.page.url();
    const initial = await pendingHire(ctx, "Morgan"); const first = initial.approvals.find(row => row.payload.name === "Morgan" && row.status === "pending")!;
    state.firstProposal = first; state.noWorkerBeforeFirstDecision = initial.runs.every(run => run.agentId === ctx.input.fixtures.agent.id);
    state.firstReply = (await observeRuntime(ctx, state)).reply; state.companyPrefix = ctx.input.fixtures.company.issuePrefix;
    const firstRequestRuns = initial.runs.filter(run => run.contextSnapshot?.source !== "approval.approved" && run.contextSnapshot?.source !== "approval.rejected").map(run => run.id);
    state.firstApprovalLink = await openApprovalFromReply(ctx, state, firstRequestRuns, first, "Morgan");
    await ctx.input.page.getByRole("button", { name: "Reject", exact: true }).click();
    const rejected = await pollUntil({ label: "Rejected Morgan stays inactive without a repeated proposal", deadlineAt: Date.now() + 60_000,
      load: async () => ({ approvals: await ctx.input.api.get<HireApproval[]>(`${root}/approvals`), agent: await ctx.input.api.get<RuntimeAgent>(`/api/agents/${first.payload.agentId}`) }),
      accept: value => value.approvals.find(row => row.id === first.id)?.status === "rejected" && value.agent.lifecycleState === "rejected" });
    state.rejectedBeforeChangedRequest = true; state.noRepeatedProposalBeforeChangedRequest = rejected.approvals.length === 1;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const prior = (await ctx.allRuns()).map(run => run.id);
    const changed = "I rejected Morgan. I am changing the request: propose a separate QA engineer named Jules using our currently admitted coding account and runtime. Do not create a task or start employee work. Keep the required board approval pending so I can inspect and accept that one intended hire.";
    await sendChatMessage(ctx.input.page, changed);
    const secondPhase = await pendingHire(ctx, "Jules"); const second = secondPhase.approvals.find(row => row.payload.name === "Jules" && row.status === "pending")!;
    state.secondProposal = second; state.noWorkerBeforeSecondDecision = secondPhase.runs.every(run => run.agentId === ctx.input.fixtures.agent.id);
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    const human = comments.filter(row => row.body === changed && !row.authorAgentId);
    const next = secondPhase.runs.filter(run => !prior.includes(run.id) && !["approval.approved", "approval.rejected"].includes(String(run.contextSnapshot?.source)));
    const profiles = await Promise.all(next.map(run => ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`)));
    state.secondRequestAttributed = human.length === 1 && next.length === 1 && profiles.some(run => run.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id));
    state.requestRunIds = [...firstRequestRuns, ...next.map(run => run.id)];
    const leadReplies = (runIds: string[]) => comments.filter(row => runIds.includes(String(row.createdByRunId)) && row.authorAgentId === ctx.input.fixtures.agent.id);
    state.firstReplyCommentIds = leadReplies(firstRequestRuns).map(row => row.id);
    state.secondReplyCommentIds = leadReplies(next.map(run => run.id)).map(row => row.id);
    state.secondReply = leadReplies(next.map(run => run.id)).map(row => row.body ?? "").join("\n");
    state.acceptedBefore = secondPhase.agents.find(row => row.id === second.payload.agentId);
    state.worker = state.acceptedBefore;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    state.secondApprovalLink = await openApprovalFromReply(ctx, state, next.map(run => run.id), second, "Jules");
    await ctx.input.page.getByRole("button", { name: "Approve", exact: true }).click();
    await pollUntil({ label: "Accepted exact QA hire becomes genuinely admitted", deadlineAt: Date.now() + 90_000,
      load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${second.payload.agentId}`),
      accept: row => row.lifecycleState === "ready" && ["idle", "active"].includes(row.status ?? ""),
      reject: row => row.lifecycleState === "error" ? "Approved runtime did not qualify; no fake ready state is permitted" : undefined });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText("approved", { exact: true }).first()).toBeVisible();
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    state.approvalsAfter = await ctx.input.api.get<HireApproval[]>(`/api/companies/${ctx.input.fixtures.company.id}/approvals`);
    return observeRuntime(ctx, state);
  },
})];
