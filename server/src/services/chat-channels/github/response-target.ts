import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { chatActions, chatConversations, chatDeliveries, chatEndpoints, type Db } from "@paperclipai/db";
import { forbidden, HttpError } from "../../../errors.js";

export type GitHubResponseSource = {
  endpoint: Pick<typeof chatEndpoints.$inferSelect,
    "id" | "companyId" | "assignedAgentId" | "botExternalId" | "botUsername"
  > & { setup: unknown };
  conversation: Pick<typeof chatConversations.$inferSelect, "id" | "issueId" | "externalThreadId">;
  delivery: Pick<typeof chatDeliveries.$inferSelect, "id" | "principalId" | "createdAt">;
  number: number;
  replyId: string | null;
  repositoryId?: string;
};

export const isMainPullResponse = (source: GitHubResponseSource) =>
  !source.replyId && /^github:[^:]+:[1-9][0-9]*$/.test(source.conversation.externalThreadId);

export const requestResponseMarker = (source: GitHubResponseSource) => `<!-- paperclip-response:${createHash("sha256")
  .update(`${source.endpoint.companyId}:${source.endpoint.id}:${source.delivery.id}`).digest("hex")} -->`;

export const pullResponseMarker = (source: GitHubResponseSource) => `<!-- paperclip-pr-response:${createHash("sha256")
  .update(`${source.endpoint.companyId}:${source.endpoint.id}:${source.conversation.externalThreadId.toLowerCase()}`).digest("hex")} -->`;

/** The per-request ledger remains intact; only the main PR's publication target
 * is shared. Callers serialize mutations with the repository publication lease. */
export async function stagePullResponse(db: Db, source: GitHubResponseSource) {
  const key = `github_pr_response:${source.conversation.externalThreadId.toLowerCase()}`;
  const [inserted] = await db.insert(chatActions).values({
    companyId: source.endpoint.companyId, endpointId: source.endpoint.id,
    conversationId: source.conversation.id, kind: "github_pr_response_comment", providerActionId: key,
    payload: { botExternalId: source.endpoint.botExternalId, agentId: source.endpoint.assignedAgentId }, status: "processed",
  }).onConflictDoNothing().returning();
  const target = inserted ?? (await db.select().from(chatActions).where(and(
    eq(chatActions.companyId, source.endpoint.companyId), eq(chatActions.endpointId, source.endpoint.id),
    eq(chatActions.providerActionId, key),
  )))[0];
  if (!target || target.conversationId !== source.conversation.id ||
      target.payload.botExternalId !== source.endpoint.botExternalId || target.payload.agentId !== source.endpoint.assignedAgentId)
    throw forbidden("GitHub main response binding changed");
  return target;
}

/** Adopt only comments identified by this conversation's durable request ledger
 * or the previous PR summary marker, never an arbitrary comment by the App. */
export async function legacyPullResponseMarkers(db: Db, source: GitHubResponseSource) {
  const rows = await db.select({ deliveryId: chatActions.deliveryId }).from(chatActions).where(and(
    eq(chatActions.companyId, source.endpoint.companyId), eq(chatActions.endpointId, source.endpoint.id),
    eq(chatActions.conversationId, source.conversation.id), eq(chatActions.kind, "github_response_comment"),
  )).orderBy(asc(chatActions.createdAt));
  // Per-request markers include the company and endpoint, and remain provable
  // after a receipt was lost between the provider write and the local commit.
  const summary = source.repositoryId ? [`<!-- paperclip-review:${createHash("sha256")
    .update(JSON.stringify(`${source.endpoint.id}:${source.repositoryId}:${source.number}`)).digest("hex")} -->`] : [];
  return [...summary, ...rows.filter(row => row.deliveryId).map(row => requestResponseMarker({ ...source, delivery: { ...source.delivery, id: row.deliveryId! } }))];
}

/** Retire the proven old placeholder before its only receipt is replaced. */
export async function retireLegacyResponsePlaceholder(
  source: GitHubResponseSource,
  result: typeof chatActions.$inferSelect["result"],
  current: { id: string; url: string },
  api: { request<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> },
  assertCurrent: () => Promise<void>,
) {
  if (!result?.id || String(result.id) === current.id || result.final === true) return;
  if (!/^[1-9][0-9]*$/.test(String(result.id))) throw forbidden("Invalid GitHub response receipt");
  const item = source.replyId ? "/pulls/comments" : "/issues/comments";
  try {
    await assertCurrent();
    const old = await api.request<{ id: number; body?: string; user?: { login?: string } }>(`${item}/${result.id}`);
    if (old.user?.login !== source.endpoint.botUsername || !old.body?.includes(requestResponseMarker(source)))
      throw forbidden("GitHub response is no longer owned by this App");
    await assertCurrent();
    await api.request(`${item}/${old.id}`, { method: "PATCH", body: {
      body: `See the [current review](${current.url}).\n\n${requestResponseMarker(source)}\n<!-- paperclip-response-state:final -->`,
    } });
  } catch (error) {
    const details = error instanceof HttpError ? error.details as { providerStatus?: number } | undefined : undefined;
    if (details?.providerStatus !== 404) throw error;
  }
}
