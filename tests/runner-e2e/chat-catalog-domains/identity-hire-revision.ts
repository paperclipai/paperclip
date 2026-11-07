import { expect } from "@playwright/test";
import type { Approval, ApprovalComment } from "../../../packages/shared/src/types/approval.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { collectConversationLinks, conversationLinkLocator, type RenderedConversationLink } from "../chat-rendered-links.js";
import { checks, entity, type Entity } from "./internal-support.js";
import { identityDefinition, identityObservation, observeIdentity, openStandingChat, remainingIdentityObservationBudget, waitForReply, type IdentityObservation } from "./identity-support.js";
import { CHAT_OPENCODE_MODEL } from "../chat-runtime-profile.js";
import { readHireModelChoice, validHireModelChoice } from "./identity-hire-model-choice.js";

function namesSelectedModel(body: string, model: string, catalog: unknown): boolean {
  if (!Array.isArray(catalog) || !catalog.includes(model)) return false;
  const shortId = model.split("/").at(-1)!;
  const uniqueShortId = catalog.filter(id => typeof id === "string" && id.split("/").at(-1) === shortId).length === 1;
  const identifiers = body.match(/[A-Za-z0-9][A-Za-z0-9_./:@~-]*/g) ?? [];
  return identifiers.some(value => {
    const id = value.replace(/[.:]+$/, "");
    return id === model || uniqueShortId && id === shortId;
  });
}
function hasBoundRevisionHistory(o: IdentityObservation, approval: Approval | undefined): boolean {
  const comment = o.state.revisionHistoryComment as Entity | undefined;
  const link = o.state.revisionHistoryLink as RenderedConversationLink | undefined;
  const sourceId = o.state.sourceIssueId;
  if (!approval || !comment || !link || typeof sourceId !== "string" || o.runs.length !== 1 || o.humanQueries.length !== 1
    || comment.companyId !== o.companyId || comment.issueId !== sourceId || comment.authorAgentId !== o.leadId || comment.authorUserId
    || typeof comment.body !== "string" || typeof o.state.cheaperModel !== "string"
    || !namesSelectedModel(comment.body, o.state.cheaperModel, o.state.eligibleModels)) return false;
  const run = o.runs[0]!;
  if (run.id !== comment.createdByRunId || run.companyId !== o.companyId || run.agentId !== o.leadId || run.runtimeMode !== "native"
    || run.status !== "succeeded" || run.resultJson?.finalizationPhase !== "committed" || run.nativeIssueId !== sourceId
    || run.contextSnapshot?.source !== "issue.comment" || run.contextSnapshot.issueId !== sourceId) return false;
  if (!o.comments.some(row => row.id === comment.id && row.companyId === o.companyId && row.issueId === sourceId
    && row.authorAgentId === o.leadId && !row.authorUserId && row.createdByRunId === run.id && row.body === comment.body)) return false;
  const wake = run.contextSnapshot.paperclipWake as { comments?: Array<{ id?: string; issueId?: string; body?: string; author?: { type?: string; id?: string } }> } | undefined;
  if (!wake?.comments?.some(row => row.id === run.contextSnapshot?.commentId && row.issueId === sourceId
    && row.author?.type === "user" && row.author.id === o.state.humanId && row.body?.trim() === o.humanQueries[0]!.trim())) return false;
  if (link.source !== "reply" || link.conversationId !== sourceId || link.commentId !== comment.id
    || !o.renderedLinkEvidence?.some(row => row.source === "reply" && row.conversationId === sourceId
      && row.commentId === comment.id && row.href === link.href)) return false;
  try {
    const url = new URL(link.href, o.origin);
    const prefix = (o.company as Entity & { issuePrefix?: string }).issuePrefix;
    return url.origin === new URL(o.origin).origin && (url.pathname === `/approvals/${approval.id}`
      || !!prefix && url.pathname === `/${prefix}/approvals/${approval.id}`);
  } catch { return false; }
}
export function gradeHireRevision(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-formal-revision", !!o, "Actual governance proposal, catalog choice, saved history and attributed resubmission are required."); if (!o) return c.result();
  const approval = o.state.currentApproval as Approval | undefined; const original = o.state.originalApproval as Approval | undefined;
  const adapter = approval?.payload.adapterConfig as { model?: string; provider?: string } | undefined;
  c.add("same-unapproved-governed-hire", !!approval && approval.id === original?.id && approval.companyId === o.companyId && approval.type === "hire_agent"
    && approval.requestedByAgentId === o.leadId && approval.status === "pending" && approval.decidedByUserId === null && approval.decidedAt === null,
    "Revision returns the same actual hiring proposal to pending board review; it is never promoted to approved or a ready employee.");
  c.add("actual-board-selected-cheaper-choice", typeof o.state.cheaperModel === "string" && adapter?.model === o.state.cheaperModel
    && (original?.payload.adapterConfig as { model?: string } | undefined)?.model !== adapter?.model
    && Array.isArray(o.state.eligibleModels) && o.state.eligibleModels.includes(adapter.model) && o.state.originalOtherFieldsPreserved === true
    && approval?.payload.adapterType === "paperclip_runner" && adapter.provider === "opencode"
    && validHireModelChoice(o.state.modelChoice) && o.state.modelChoice.cheaperModel === adapter.model && o.state.modelChoice.originalModel === o.state.originalModel
    && (original?.payload.adapterConfig as { model?: string } | undefined)?.model === o.state.modelChoice.originalModel,
    "The actual public catalog and official published text/cache rates prove the selected1017 configuration costs less across all published rate variants. Only the pending proposed model changes; no inference or realized savings is claimed for the original configuration.");
  const comments = o.state.approvalComments as ApprovalComment[] | undefined;
  c.add("inspectable-original-and-revised-history", !!comments?.some(comment => comment.id === o.state.originalHistoryCommentId && comment.authorUserId === o.state.humanId
    && comment.body.includes(String(o.state.originalModel)) && comment.body.includes(String(o.state.cheaperModel)))
    && (comments.some(comment => comment.authorAgentId === o.leadId && comment.body.includes(String(o.state.cheaperModel)))
      || hasBoundRevisionHistory(o, approval))
    && o.activity.some(row => row.action === "approval.revision_requested" && row.entityId === approval?.id && row.actorType === "user")
    && o.activity.filter(row => row.action === "approval.resubmitted" && row.entityId === approval?.id && row.actorType === "agent" && row.agentId === o.leadId).length === 1,
    "The retained public original/board-choice comment, agent approval note or bound native revision reply, and actual revision/resubmission audit form inspectable history.");
  c.add("no-hire-or-approval-side-effect", o.agents.length === o.state.beforeAgentCount && !o.activity.some(row => row.action === "approval.approved" && row.entityId === approval?.id)
    && o.state.pendingProposalVisible === true && o.state.revisedModelVisible === true && /approval|review|pending|board/i.test(o.reply),
    "The actual proposal remains visibly pending with the revised model and no employee is instantiated or activated under the revision request.");
  return c.result();
}
export const hireRevisionIdentityCases: readonly ChatCatalogCase[] = [identityDefinition("questions-and-approvals.formal-hire-revision", async ctx => {
  const source = await openStandingChat(ctx); const { fixtures, execution, workspacePath, nonce } = ctx.input;
  const configuration = execution.profile.buildAgent({ environmentId: fixtures.environment.id, environmentFixtureId: execution.environment.id, workspacePath, secretRefs: fixtures.secretRefs, executionId: nonce });
  const config = configuration.adapterConfig as Record<string, unknown>;
  if (configuration.adapterType !== "paperclip_runner" || config.provider !== "opencode" || config.model !== CHAT_OPENCODE_MODEL) throw new Error("This hire-revision fixture requires the requested native OpenCode1017 profile");
  const models = await ctx.input.api.get<Array<{ id: string }>>(`/api/companies/${fixtures.company.id}/adapters/opencode_local/models?provider=openrouter&environmentId=${fixtures.environment.id}`);
  const modelChoice = await readHireModelChoice(models);
  const { originalModel, cheaperModel } = modelChoice;
  await ctx.input.evidence("identity-hire-model-choice.json", { ...modelChoice, originalConfigurationExecuted: false, publishedRateComparisonOnly: true });
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  const originalApproval = await ctx.input.api.post<Approval>(`/api/companies/${fixtures.company.id}/approvals`, { type: "hire_agent", requestedByAgentId: fixtures.agent.id, issueIds: [source.id],
    payload: { ...configuration, name: `Launch researcher ${nonce}`, role: "researcher", reportsTo: fixtures.agent.id, adapterConfig: { ...config, model: originalModel } } });
  const history = await ctx.input.api.post<ApprovalComment>(`/api/approvals/${originalApproval.id}/comments`, { body: `Original proposed hire configuration: model ${originalModel}. Board-selected lower-cost alternative for this proposal: ${cheaperModel}. Preserve all other hiring scope, use this selected alternative and resubmit for board approval. This is a request for revision, not approval. No provider prices or savings estimate are asserted.` });
  const url = ctx.input.page.url(); await ctx.input.page.goto(`/${fixtures.company.issuePrefix}/approvals/${originalApproval.id}`, { waitUntil: "domcontentloaded" });
  await ctx.input.page.getByRole("button", { name: "Request revision", exact: true }).click();
  await expect.poll(async () => (await ctx.input.api.get<Approval>(`/api/approvals/${originalApproval.id}`)).status).toBe("revision_requested");
  await ctx.input.page.goto(url, { waitUntil: "domcontentloaded" });
  return { sourceIssueId: source.id, originalApproval, originalHistoryCommentId: history.id, originalModel, cheaperModel, humanId: session.user.id,
    eligibleModels: models.map(row => row.id), modelChoice, beforeAgentCount: (await ctx.input.api.get<unknown[]>(`/api/companies/${fixtures.company.id}/agents`)).length };
}, gradeHireRevision, {
  authentication: "human-session", oracleVersion: "paperclip.chat-catalog.hire-revision.native1017.v5", sourceFiles: ["chat-catalog-domains/identity-hire-revision.ts", "chat-catalog-domains/identity-hire-model-choice.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-rendered-links.ts", "chat-scenarios/questions-and-approvals.yaml"],
  async act(ctx, state) {
    const remaining = () => remainingIdentityObservationBudget(ctx);
    remaining(); await waitForReply(ctx, ctx.observationDeadlineAt); remaining();
    const id = entity(state, "originalApproval").id, sourceId = String(state.sourceIssueId), source = ctx.input.page.url();
    if (ctx.issue()?.id !== sourceId || entity(state, "originalApproval").companyId !== ctx.input.fixtures.company.id)
      throw new Error("Hire review source does not match the owned proposal");
    const frame = await pollUntil({ label: "Actual canonical pending hire review link", deadlineAt: ctx.observationDeadlineAt!,
      load: async () => {
        await ctx.refreshIssue(); remaining();
        const [runs, comments, approval] = await Promise.all([
          ctx.allRuns(), ctx.input.api.get<Entity[]>(`/api/issues/${sourceId}/comments?order=asc`, { timeout: remaining() }),
          ctx.input.api.get<Approval>(`/api/approvals/${id}`, { timeout: remaining() }),
        ]);
        remaining();
        const links = await collectConversationLinks(ctx.input.page, { origin: ctx.input.api.baseURL, companyId: ctx.input.fixtures.company.id,
          companyPrefix: ctx.input.fixtures.company.issuePrefix, sourceId, leadId: ctx.input.fixtures.agent.id, comments, runs, projects: [], activity: [] });
        const humans = comments.filter(row => row.authorUserId === state.humanId && !row.createdByRunId && row.body?.trim() === ctx.scenario.query.trim());
        const run = runs[0];
        const bound = ctx.issue()?.id === sourceId && ctx.issue()?.conversationState === "waiting" && runs.length === 1 && !!run
          && run.companyId === ctx.input.fixtures.company.id && run.agentId === ctx.input.fixtures.agent.id && run.status === "succeeded"
          && run.contextSnapshot?.issueId === sourceId && humans.length === 1 && run.contextSnapshot?.commentId === humans[0]?.id;
        const boundLinks = bound && run ? links.filter(row => {
          if (row.source !== "reply" || row.conversationId !== sourceId || !comments.some(comment => comment.id === row.commentId
            && comment.authorAgentId === run.agentId && comment.createdByRunId === run.id)) return false;
          try { const url = new URL(row.href, ctx.input.api.baseURL); return url.origin === new URL(ctx.input.api.baseURL).origin
            && [ `/approvals/${id}`, `/${ctx.input.fixtures.company.issuePrefix}/approvals/${id}` ].includes(url.pathname); }
          catch { return false; }
        }) : [];
        const model = (approval.payload.adapterConfig as { model?: unknown } | undefined)?.model;
        const link = boundLinks.find(row => typeof model === "string" && model === state.cheaperModel
          && comments.some(comment => comment.id === row.commentId && typeof comment.body === "string"
            && namesSelectedModel(comment.body, model, state.eligibleModels))) ?? boundLinks[0];
        const comment = link ? comments.find(row => row.id === link.commentId) : undefined;
        return { approval, link, comment };
      },
      accept: value => Date.now() < ctx.observationDeadlineAt! && value.approval.id === id && value.approval.companyId === ctx.input.fixtures.company.id
        && value.approval.status === "pending" && !!value.link && !!value.comment,
      reject: value => value.approval.id !== id || value.approval.companyId !== ctx.input.fixtures.company.id || value.approval.status !== "pending"
        ? "The owned revised hire proposal is not pending" : undefined,
    });
    remaining(); if (!frame.link || !frame.comment) throw new Error("Actual pending revised proposal review link is missing");
    await conversationLinkLocator(ctx.input.page, frame.link).first().click({ timeout: remaining() });
    await expect(ctx.input.page.getByText("pending", { exact: true }).first()).toBeVisible({ timeout: remaining() }); state.pendingProposalVisible = true;
    await ctx.input.page.getByRole("button", { name: "See full request", exact: true }).click({ timeout: remaining() });
    await expect(ctx.input.page.locator("pre")).toContainText(String(state.cheaperModel), { timeout: remaining() }); state.revisedModelVisible = true;
    state.revisionHistoryComment = frame.comment;
    state.revisionHistoryLink = frame.link;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded", timeout: remaining() }); remaining();
  },
  async observe(ctx, state) {
    const id = entity(state, "originalApproval").id;
    const current = await ctx.input.api.get<Approval>(`/api/approvals/${id}`); state.currentApproval = current;
    state.approvalComments = await ctx.input.api.get<ApprovalComment[]>(`/api/approvals/${id}/comments`);
    const stripModel = (payload: Record<string, unknown>) => { const adapter = payload.adapterConfig as Record<string, unknown>; return { ...payload, adapterConfig: { ...adapter, model: undefined } }; };
    state.originalOtherFieldsPreserved = JSON.stringify(stripModel((state.originalApproval as Approval).payload)) === JSON.stringify(stripModel(current.payload));
    const sourceComments = await ctx.input.api.get<Entity[]>(`/api/issues/${String(state.sourceIssueId)}/comments?order=asc`);
    const observation = await observeIdentity(ctx, state);
    return { ...observation, comments: [...observation.comments.filter(row => row.issueId !== state.sourceIssueId), ...sourceComments] };
  },
})];
