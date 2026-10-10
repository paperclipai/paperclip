import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  chatActions, chatConversations, chatDeliveries, chatEndpoints,
  chatEndpointResources, chatGitHubConfigurations, chatMessageLinks, heartbeatRuns, issues,
  fastResponseRequests, chatPublications,
  type Db,
} from "@paperclipai/db";
import { conflict, forbidden, HttpError } from "../errors.js";
import { githubChatPrincipalAccess } from "./chat-github-access.js";
import { githubAutomaticAdmission } from "./chat-github-events.js";
import { githubBotRepositoryToken, githubBotRequest } from "./chat-github-client.js";
import { withGitHubPublicationLease } from "./chat-github-publication-lease.js";
import { projectSafeChatPublicationText } from "./chat-publication-projection.js";
import type { GitHubAutomaticEventContext } from "@paperclipai/shared";
import { githubRunReplyState } from "./chat-run-publications.js";
import { logActivity } from "./activity-log.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Api = { request<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> };
type Lease = { commit<T>(write: (tx: Transaction) => Promise<T>): Promise<T> };
type Source = {
  endpoint: typeof chatEndpoints.$inferSelect;
  conversation: typeof chatConversations.$inferSelect;
  delivery: typeof chatDeliveries.$inferSelect;
  number: number;
  replyId: string | null;
};
type Comment = { id: number; body?: string; html_url: string; user?: { login?: string } };
const generation = (endpoint: Source["endpoint"]) => (endpoint.setup as { runtimeGeneration?: number }).runtimeGeneration ?? 0;
const actionKey = (deliveryId: string) => `github_response:${deliveryId}`;
const responseMarker = (source: Source) => `<!-- paperclip-response:${createHash("sha256")
  .update(`${source.endpoint.companyId}:${source.endpoint.id}:${source.delivery.id}`).digest("hex")} -->`;

async function findResponseComment(source: Source, api: Api): Promise<Comment | null> {
  const list = source.replyId ? `/pulls/${source.number}/comments` : `/issues/${source.number}/comments`;
  for (let page = 1; page <= 100; page++) {
    const rows = await api.request<Comment[]>(`${list}?per_page=100&page=${page}`);
    const found = rows.find(row => row.body?.includes(responseMarker(source)) && row.user?.login === source.endpoint.botUsername);
    if (found) return found;
    if (rows.length < 100) return null;
  }
  throw conflict("GitHub history is too large to safely recover the response");
}

/** One durable, App-owned comment per accepted request. Callers hold the same
 * repository publication lease used by agent replies and review summaries. */
async function stageResponse(db: Db, source: Source) {
  const [inserted] = await db.insert(chatActions).values({
    companyId: source.endpoint.companyId, endpointId: source.endpoint.id,
    conversationId: source.conversation.id, deliveryId: source.delivery.id,
    principalId: source.delivery.principalId, kind: "github_response_comment",
    providerActionId: actionKey(source.delivery.id),
    payload: { runtimeGeneration: generation(source.endpoint), agentId: source.endpoint.assignedAgentId },
    status: "received",
  }).onConflictDoNothing().returning();
  const response = inserted ?? (await db.select().from(chatActions).where(and(
    eq(chatActions.companyId, source.endpoint.companyId), eq(chatActions.endpointId, source.endpoint.id),
    eq(chatActions.providerActionId, actionKey(source.delivery.id)),
  )))[0];
  if (!response || response.conversationId !== source.conversation.id ||
      response.payload.runtimeGeneration !== generation(source.endpoint) ||
      response.payload.agentId !== source.endpoint.assignedAgentId)
    throw forbidden("GitHub response binding changed");
  return response;
}

export async function writeGitHubResponseComment(
  db: Db, source: Source, api: Api, lease: Lease,
  input: { body: string; final: boolean; versionAt?: Date; acknowledgement?: boolean },
  assertCurrent: () => Promise<void>,
) {
  const response = await stageResponse(db, source);
  // A delayed acknowledgement or progress retry must never replace a result.
  if (response.result?.id && (input.acknowledgement || (response.result.final === true && !input.final) ||
      (input.versionAt && Date.parse(String(response.result.versionAt)) > input.versionAt.getTime()))) {
    if (!input.acknowledgement && response.result.final === true && !input.final)
      throw conflict("This GitHub response is already final");
    return { id: String(response.result.id), url: String(response.result.url) };
  }
  const marker = responseMarker(source);
  const list = source.replyId ? `/pulls/${source.number}/comments` : `/issues/${source.number}/comments`;
  const item = source.replyId ? "/pulls/comments" : "/issues/comments";
  await assertCurrent();
  let previous: Comment | null = null;
  if (response.result?.id) {
    // Never recreate a deleted comment or edit an arbitrary caller-selected ID.
    if (!/^[1-9][0-9]*$/.test(String(response.result.id))) throw forbidden("Invalid GitHub response receipt");
    previous = await api.request<Comment>(`${item}/${response.result.id}`);
    if (!previous.body?.includes(marker) || previous.user?.login !== source.endpoint.botUsername)
      throw forbidden("GitHub response is no longer owned by this App");
  } else {
    previous = await findResponseComment(source, api);
  }
  await assertCurrent();
  const alreadyFinal = previous?.body?.includes("<!-- paperclip-response-state:final -->") === true;
  const body = `${projectSafeChatPublicationText(input.body)}\n\n${marker}${input.final ? "\n<!-- paperclip-response-state:final -->" : ""}`;
  const posted = previous && (input.acknowledgement || (alreadyFinal && !input.final)) ? previous : await api.request<Comment>(
    previous ? `${item}/${previous.id}` : source.replyId
      ? `/pulls/${source.number}/comments/${source.replyId}/replies` : list,
    { method: previous ? "PATCH" : "POST", body: { body } },
  );
  if (!Number.isSafeInteger(posted.id) || posted.id <= 0 || !posted.html_url)
    throw conflict("GitHub response delivery was not confirmed");
  await assertCurrent();
  const receipt = { id: String(posted.id), url: posted.html_url };
  await lease.commit(async tx => {
    await tx.update(chatActions).set({ status: "processed", result: {
      ...receipt, final: input.final || alreadyFinal, versionAt: (input.versionAt ?? response.createdAt).toISOString(),
    }, updatedAt: new Date() }).where(eq(chatActions.id, response.id));
    await logActivity(tx as unknown as Db, { companyId: source.endpoint.companyId,
      actorType: "system", actorId: "github-response", action: "chat_github.response_updated",
      entityType: "chat_endpoint", entityId: source.endpoint.id,
      details: { deliveryId: source.delivery.id, final: input.final, ...receipt } });
  });
  return receipt;
}

export function githubResponseCommentService(db: Db, fetchImpl = fetch) {
  async function context(deliveryId: string) {
    const [row] = await db.select({ endpoint: chatEndpoints, conversation: chatConversations,
      delivery: chatDeliveries, resource: chatEndpointResources, config: chatGitHubConfigurations,
      assignee: issues.assigneeAgentId }).from(chatMessageLinks)
      .innerJoin(chatDeliveries, and(eq(chatDeliveries.id, chatMessageLinks.deliveryId), eq(chatDeliveries.companyId, chatMessageLinks.companyId)))
      .innerJoin(chatConversations, and(eq(chatConversations.id, chatMessageLinks.conversationId), eq(chatConversations.companyId, chatMessageLinks.companyId)))
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatConversations.endpointId), eq(chatEndpoints.companyId, chatConversations.companyId)))
      .innerJoin(chatEndpointResources, eq(chatEndpointResources.id, chatConversations.resourceId))
      .innerJoin(chatGitHubConfigurations, eq(chatGitHubConfigurations.endpointId, chatEndpoints.id))
      .innerJoin(issues, and(eq(issues.id, chatConversations.issueId), eq(issues.companyId, chatEndpoints.companyId)))
      .where(and(eq(chatMessageLinks.deliveryId, deliveryId), eq(chatMessageLinks.direction, "inbound"), eq(chatEndpoints.provider, "github")));
    if (!row || !row.delivery.principalId || !["processing", "processed"].includes(row.delivery.state) ||
        !["active", "verifying"].includes(row.endpoint.status) || !row.config.configuration.toolsEnabled ||
        !row.resource.enabled || row.resource.availability !== "available" || row.assignee !== row.endpoint.assignedAgentId)
      throw forbidden("GitHub request is no longer authorized");
    const access = await githubChatPrincipalAccess(db, row.endpoint, row.delivery.principalId);
    if (!access?.allowed) throw forbidden("The initiating GitHub person is no longer authorized");
    const automatic = (row.delivery.normalizedEvent.githubAutomatic ?? row.delivery.normalizedEvent.githubIssue) as
      { context: GitHubAutomaticEventContext } | undefined;
    if (automatic && !(await githubAutomaticAdmission(db, row.endpoint, automatic.context))?.allowed)
      throw forbidden("Automatic GitHub task authority changed");
    const match = /^github:([^:]+):(?:issue:)?([1-9][0-9]*)(?::rc:([1-9][0-9]*))?$/.exec(row.conversation.externalThreadId);
    const repositoryId = String(row.resource.metadata.providerRepositoryId ?? "");
    if (!match || match[1]!.toLowerCase() !== row.resource.providerResourceId.toLowerCase() || !/^[1-9][0-9]*$/.test(repositoryId))
      throw forbidden("Invalid GitHub request repository");
    return { ...row, repositoryId, repository: match[1]!, number: Number(match[2]), replyId: match[3] ?? null };
  }
  async function acknowledge(deliveryId: string, finalBody?: string, assertRun?: () => Promise<void>) {
    const source = await context(deliveryId);
    // Persist before competing for the publication lane. A busy lane leaves
    // durable acknowledgement work for maintenance instead of losing it.
    await stageResponse(db, source);
    return withGitHubPublicationLease(db, { companyId: source.endpoint.companyId, endpointId: source.endpoint.id,
      repositoryId: source.repositoryId, number: source.number }, fetchImpl, async lease => {
      const assertCurrent = async () => {
        await assertRun?.();
        const current = await context(deliveryId);
        if (generation(current.endpoint) !== generation(source.endpoint) || current.endpoint.assignedAgentId !== source.endpoint.assignedAgentId)
          throw forbidden("GitHub response binding changed");
      };
      await assertCurrent();
      let onlyExisting = false;
      if (finalBody === undefined) {
        const existing = await stageResponse(db, source);
        const [run] = await db.select().from(heartbeatRuns).innerJoin(chatMessageLinks, and(
          eq(chatMessageLinks.companyId, source.endpoint.companyId), eq(chatMessageLinks.endpointId, source.endpoint.id),
          eq(chatMessageLinks.deliveryId, deliveryId), eq(chatMessageLinks.direction, "inbound"),
          or(sql`${chatMessageLinks.commentId}::text = ${heartbeatRuns.contextSnapshot}->>'wakeCommentId'`,
            sql`coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${chatMessageLinks.commentId}::text`),
        )).where(and(eq(heartbeatRuns.companyId, source.endpoint.companyId), eq(heartbeatRuns.agentId, source.endpoint.assignedAgentId),
          sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${source.conversation.issueId}`))
          .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
        if (run && ["succeeded", "failed", "interrupted", "timed_out", "cancelled"].includes(run.heartbeat_runs.status)) {
          const reply = await githubRunReplyState(db, { companyId: source.endpoint.companyId, endpointId: source.endpoint.id,
            issueId: source.conversation.issueId!, runId: run.heartbeat_runs.id });
          if (reply === "unsettled") throw conflict("GitHub reply is still being resolved");
          onlyExisting = reply === "confirmed" && !existing.result?.id;
          finalBody = reply === "confirmed" ? "This request has been handled. See the response in this conversation."
            : run.heartbeat_runs.status === "succeeded" ? "This turn ended without publishing a final response. See the Paperclip task for details."
            : "This turn stopped before completing. See the Paperclip task for details.";
        } else if (existing.result?.id) return { id: String(existing.result.id), url: String(existing.result.url) };
        if (finalBody === undefined) {
          const [fast] = await db.select({ request: fastResponseRequests, publicationState: chatPublications.state })
            .from(fastResponseRequests).leftJoin(chatPublications, and(
              eq(chatPublications.companyId, fastResponseRequests.companyId),
              eq(chatPublications.commentId, fastResponseRequests.commentId),
              eq(chatPublications.endpointId, fastResponseRequests.endpointId),
              eq(chatPublications.conversationId, fastResponseRequests.conversationId),
            )).where(and(eq(fastResponseRequests.companyId, source.endpoint.companyId),
              eq(fastResponseRequests.endpointId, source.endpoint.id),
              eq(fastResponseRequests.deliveryId, deliveryId))).limit(1);
          if (fast && ["published", "delivery_unknown"].includes(fast.publicationState ?? "")) {
            await lease.commit(async tx => { await tx.update(chatActions).set({
              status: "processed", result: { code: "fast_response_superseded" }, updatedAt: new Date(),
            }).where(eq(chatActions.id, existing.id)); });
            return;
          }
          // Keep durable fallback work pending while the contextual receipt can
          // still arrive. Never race an in-flight or ambiguous external send.
          if (fast && (fast.publicationState === "streaming" ||
              (fast.request.expiresAt.getTime() > Date.now() &&
                (["pending", "running"].includes(fast.request.status) ||
                  ["pending", "retry"].includes(fast.publicationState ?? ""))))) return;
        }
      }
      const token = await githubBotRepositoryToken(db, source.endpoint.companyId, source.endpoint.id, source.repositoryId, lease.fetch);
      const prefix = `/repos/${source.repository.split("/").map(encodeURIComponent).join("/")}`;
      const api: Api = { request: (path, options) => githubBotRequest(lease.fetch, token, `${prefix}${path}`, options) };
      if (onlyExisting && !(await findResponseComment(source, api))) {
        const existing = await stageResponse(db, source);
        await lease.commit(async tx => { await tx.update(chatActions).set({ status: "cancelled", result: { final: true, code: "run_already_answered" }, updatedAt: new Date() }).where(eq(chatActions.id, existing.id)); });
        return;
      }
      return writeGitHubResponseComment(db, source, api, lease,
        { body: finalBody ?? "Working on this…", final: finalBody !== undefined,
          acknowledgement: finalBody === undefined, ...(finalBody !== undefined ? { versionAt: new Date() } : {}) }, assertCurrent);
    });
  }
  async function requestsForRun(input: { companyId: string; endpointId: string; issueId: string; runId: string }) {
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
    if (!run || (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== input.issueId) throw forbidden("GitHub run has no request binding");
    const ids = [...new Set([run.contextSnapshot?.wakeCommentId, ...(Array.isArray(run.contextSnapshot?.wakeCommentIds) ? run.contextSnapshot.wakeCommentIds : [])].filter((id): id is string => typeof id === "string"))];
    if (!ids.length) throw forbidden("GitHub run has no request binding");
    const links = await db.select({ deliveryId: chatMessageLinks.deliveryId }).from(chatMessageLinks)
      .innerJoin(chatConversations, and(eq(chatConversations.id, chatMessageLinks.conversationId), eq(chatConversations.companyId, input.companyId),
        eq(chatConversations.endpointId, input.endpointId), eq(chatConversations.issueId, input.issueId)))
      .where(and(eq(chatMessageLinks.companyId, input.companyId), eq(chatMessageLinks.endpointId, input.endpointId),
        inArray(chatMessageLinks.commentId, ids), eq(chatMessageLinks.direction, "inbound")))
      .orderBy(asc(chatMessageLinks.createdAt));
    return { run, links };
  }
  async function finishRun(input: { companyId: string; endpointId: string; issueId: string; runId: string; closePrimary?: boolean },
    primary: Source, receipt: { id: string; url: string }, api: Api, lease: Lease, assertCurrent: () => Promise<void>) {
    const { run, links } = await requestsForRun(input);
    if (run.agentId !== primary.endpoint.assignedAgentId) throw forbidden("GitHub response authority changed");
    for (const link of links) {
      if (!link.deliveryId || (link.deliveryId === primary.delivery.id && !input.closePrimary)) continue;
      const sibling = await context(link.deliveryId);
      if (sibling.endpoint.id !== primary.endpoint.id || sibling.number !== primary.number || sibling.replyId !== primary.replyId || sibling.conversation.id !== primary.conversation.id)
        throw forbidden("Coalesced GitHub response belongs to another conversation");
      const [response] = await db.select().from(chatActions).where(and(eq(chatActions.deliveryId, link.deliveryId), eq(chatActions.kind, "github_response_comment")));
      if (!response || response.result?.final === true) continue;
      // Never create a sibling placeholder just to close it. Mark a failed
      // acknowledgement settled so its maintenance retry cannot post later.
      if (!response.result?.id && !(await findResponseComment(sibling, api))) {
        await lease.commit(async tx => { await tx.update(chatActions).set({ status: "cancelled", result: { final: true, code: "run_already_answered" }, updatedAt: new Date() }).where(eq(chatActions.id, response.id)); });
        continue;
      }
      try {
        await writeGitHubResponseComment(db, sibling, api, lease, {
          body: link.deliveryId === primary.delivery.id
            ? `Review complete. See the [review finding](${receipt.url}).`
            : `Handled with the [response to this request](${receipt.url}).`, final: true, versionAt: new Date(),
        }, async () => { await assertCurrent(); await context(link.deliveryId!); });
      } catch (error) {
        const details = error instanceof HttpError ? error.details as { code?: string; providerStatus?: number } | undefined : undefined;
        if (!response.result?.id || details?.code !== "github_bot_operation_failed" || details.providerStatus !== 404) throw error;
        // A human can delete an earlier working comment while the coalesced
        // review runs. Settle that exact receipt without recreating the comment
        // or blocking the current response and check publication.
        await assertCurrent();
        await context(link.deliveryId);
        await lease.commit(async tx => { await tx.update(chatActions).set({ status: "cancelled",
          result: { ...response.result, final: true, code: "response_deleted" }, updatedAt: new Date(),
        }).where(and(eq(chatActions.id, response.id), eq(chatActions.companyId, input.companyId),
          eq(chatActions.endpointId, input.endpointId))); });
      }
    }
  }
  async function failRun(input: { companyId: string; endpointId: string; issueId: string; runId: string; body: string }) {
    const { run, links } = await requestsForRun(input);
    let receipt: { id: string; url: string } | undefined;
    for (const link of links) {
      if (!link.deliveryId) continue;
      const assertRun = async () => {
        const source = await context(link.deliveryId!);
        const [current] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, input.companyId)));
        if (!current || current.agentId !== source.endpoint.assignedAgentId ||
            !["succeeded", "failed", "interrupted", "timed_out", "cancelled"].includes(current.status) ||
            source.endpoint.id !== input.endpointId || source.conversation.issueId !== input.issueId ||
            (current.nativeIssueId ?? current.contextSnapshot?.issueId) !== input.issueId)
          throw forbidden("GitHub failure authority changed");
        if (await githubRunReplyState(db, input) !== "none") throw conflict("GitHub reply is still being resolved");
      };
      receipt = await acknowledge(link.deliveryId, input.body, assertRun);
    }
    if (!receipt) throw forbidden("GitHub failure has no request binding");
    return receipt;
  }
  async function hasWorkingResponseForRun(input: { companyId: string; endpointId: string; issueId: string; runId: string }) {
    const { links } = await requestsForRun(input);
    const ids = links.map(link => link.deliveryId).filter((id): id is string => !!id);
    if (!ids.length) return false;
    const responses = await db.select({ result: chatActions.result }).from(chatActions).where(and(
      eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, input.endpointId),
      inArray(chatActions.deliveryId, ids), eq(chatActions.kind, "github_response_comment")));
    return responses.some(response => response.result?.final !== true);
  }
  async function processPending(limit = 10) {
    const rows = await db.select().from(chatActions).where(and(eq(chatActions.kind, "github_response_comment"),
      or(eq(chatActions.status, "received"), and(eq(chatActions.status, "failed"), sql`${chatActions.result}->>'retryable' = 'true'`,
        sql`(${chatActions.result}->>'retryAt')::timestamptz <= now()`)))).orderBy(asc(chatActions.createdAt)).limit(limit);
    for (const row of rows) if (row.deliveryId) await tryAcknowledge(row.deliveryId);
    return rows.length;
  }
  async function tryAcknowledge(deliveryId: string) {
    try { return await acknowledge(deliveryId); }
    catch (error) {
      const [row] = await db.select().from(chatActions).where(and(eq(chatActions.kind, "github_response_comment"), eq(chatActions.deliveryId, deliveryId)));
      if (!row || row.result?.id) return;
      const attempts = Number(row.result?.attempts ?? 0) + 1;
      const denied = error instanceof Error && "status" in error && error.status === 403;
      await db.update(chatActions).set({ status: denied ? "cancelled" : "failed", result: {
        attempts, retryable: !denied && attempts < 8,
        retryAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** attempts)).toISOString(),
        code: denied ? "authorization_changed" : "acknowledgement_unconfirmed",
      }, updatedAt: new Date() }).where(and(eq(chatActions.id, row.id), sql`${chatActions.result}->>'id' is null`));
    }
  }
  return { tryAcknowledge, processPending, failRun, finishRun, hasWorkingResponseForRun };
}
