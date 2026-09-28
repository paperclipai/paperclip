import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  type Db,
} from "@paperclipai/db";
import { z } from "zod";
import { conflict, forbidden, notFound } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { xAncestors, XApiError, xRequest } from "./client.js";
import {
  xChallenge,
  xControl,
  xEvents,
  xId,
  xParent,
  validateXReply,
  verifyXSignature,
  X_SIGNATURE_HEADER,
  type XEvent,
} from "./protocol.js";

type Endpoint = typeof chatEndpoints.$inferSelect;
export type XBinding = {
  companyId: string;
  agentId: string;
  issueId: string;
  runId: string;
  workMode?: string;
};
export type XAuthority = {
  endpoint: Endpoint;
  conversation: typeof chatConversations.$inferSelect;
  delivery: typeof chatDeliveries.$inferSelect;
  actionId: string;
  senderId: string;
  workMode: string;
};
export type XHooks = {
  credentials(endpoint: Endpoint): Promise<Record<string, string>>;
  token(endpoint: Endpoint): Promise<string>;
  authorize(binding: XBinding, actionId?: string): Promise<XAuthority>;
  withSendLease<T>(endpoint: Endpoint, operation: () => Promise<T>): Promise<T>;
  dispatch(endpoint: Endpoint, event: XEvent): Promise<void>;
};
const replySchema = z
  .object({
    replyToPostId: xId,
    text: z.string().min(1),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
const empty = z.object({}).strict();
const statusSchema = z.object({ publicationId: z.string().uuid() }).strict();
const messageId = (delivery: XAuthority["delivery"]) =>
  String(
    (delivery.normalizedEvent.message as Record<string, unknown>)
      ?.providerMessageId ?? "",
  );
const summary = (row: typeof chatPublications.$inferSelect) => ({
  publicationId: row.id,
  status: row.state,
  postId: row.providerMessageId,
  error: row.redactedError,
});

export function xChannelService(db: Db, hooks: XHooks, fetchImpl = fetch) {
  async function optedOut(endpointId: string, senderId: string) {
    const [row] = await db
      .select({ status: chatActions.status })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, endpointId),
          eq(chatActions.providerActionId, `x-optout:${senderId}`),
        ),
      );
    return row?.status === "stopped";
  }
  async function authority(binding: XBinding, actionId?: string) {
    const result = await hooks.authorize(binding, actionId);
    if (await optedOut(result.endpoint.id, result.senderId))
      throw forbidden("This X account opted out of bot replies");
    return result;
  }
  async function intake(endpoint: Endpoint, request: Request) {
    const credentials = await hooks.credentials(endpoint);
    if (request.method === "GET") {
      const response = xChallenge(request, credentials.clientSecret);
      if (response.ok && ["verifying", "active"].includes(endpoint.status))
        await db
          .update(chatEndpoints)
          .set({
            setup: sql`jsonb_set(${chatEndpoints.setup}, '{webhookVerifiedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb)`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatEndpoints.id, endpoint.id),
              inArray(chatEndpoints.status, ["verifying", "active"]),
            ),
          );
      return response;
    }
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const body = new Uint8Array(await request.arrayBuffer());
    if (
      !verifyXSignature(
        body,
        request.headers.get(X_SIGNATURE_HEADER),
        credentials.clientSecret,
      )
    )
      return new Response("Invalid signature", { status: 401 });
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const events = xEvents(parsed, endpoint.botExternalId ?? "");
    // Commit all accepted events together. The HTTP acknowledgement never waits
    // for provider reads or an agent; restart recovery drains this same ledger.
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpoint.id))
        .for("update");
      if (
        !current ||
        !["verifying", "active"].includes(current.status) ||
        current.botExternalId !== endpoint.botExternalId
      )
        return;
      for (const event of events) {
        const control = xControl(event.payload.text, current.botUsername);
        if (control) {
          await tx
            .insert(chatActions)
            .values({
              companyId: current.companyId,
              endpointId: current.id,
              kind: "x_opt_out",
              providerActionId: `x-optout:${event.payload.author_id}`,
              payload: {
                postId: event.payload.id,
                senderId: event.payload.author_id,
              },
              status: control === "stop" ? "stopped" : "started",
            })
            .onConflictDoUpdate({
              target: [chatActions.endpointId, chatActions.providerActionId],
              set: {
                payload: {
                  postId: event.payload.id,
                  senderId: event.payload.author_id,
                },
                status: control === "stop" ? "stopped" : "started",
                updatedAt: new Date(),
              },
              setWhere: sql`(${chatActions.payload}->>'postId')::numeric < ${event.payload.id}::numeric`,
            });
          continue;
        }
        const payload = {
          event,
          botId: current.botExternalId,
          generation:
            (current.setup as unknown as Record<string, unknown>)
              .runtimeGeneration ?? 0,
        };
        await tx
          .insert(chatActions)
          .values({
            companyId: current.companyId,
            endpointId: current.id,
            kind: "x_webhook_ingress",
            providerActionId: `x-post:${event.payload.id}`,
            payload,
            status: "received",
          })
          .onConflictDoUpdate({
            target: [chatActions.endpointId, chatActions.providerActionId],
            set: {
              payload,
              status: "received",
              result: null,
              updatedAt: new Date(),
            },
            // Reply events can arrive first, before their duplicate mention. A
            // mention must still activate an otherwise unbound post. Common
            // delivery deduplication protects an already-admitted interaction.
            setWhere: sql`${event.event_type} = 'post.mention.create' and ${chatActions.payload}->'event'->>'event_type' = 'post.reply.create' and ${chatActions.payload}->>'generation' = ${String(payload.generation)}`,
          });
      }
      await tx
        .update(chatEndpoints)
        .set({
          setup: {
            ...current.setup,
            webhookVerifiedAt: new Date().toISOString(),
          },
          lastEventAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(chatEndpoints.id, current.id));
    });
    return new Response("accepted", { status: 200 });
  }
  async function resolveThread(endpoint: Endpoint, event: XEvent) {
    const existing = await db
      .select({ thread: chatConversations.externalThreadId })
      .from(chatMessageLinks)
      .innerJoin(
        chatConversations,
        eq(chatConversations.id, chatMessageLinks.conversationId),
      )
      .where(
        and(
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.providerMessageId, event.payload.id),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0].thread;
    const parentId = xParent(event.payload);
    if (parentId) {
      const [parent] = await db
        .select({ thread: chatConversations.externalThreadId })
        .from(chatMessageLinks)
        .innerJoin(
          chatConversations,
          eq(chatConversations.id, chatMessageLinks.conversationId),
        )
        .where(
          and(
            eq(chatMessageLinks.endpointId, endpoint.id),
            eq(chatMessageLinks.providerMessageId, parentId),
            eq(chatMessageLinks.direction, "outbound"),
          ),
        )
        .limit(1);
      if (parent) return parent.thread;
      // X can deliver a follow-up before the send response and outbound link
      // commit. Do not activate a second branch during that publication window.
      const [sending] = await db
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, endpoint.id),
            eq(chatPublications.state, "streaming"),
            sql`${chatPublications.payload}->'xReply' is not null`,
          ),
        )
        .limit(1);
      if (sending) return null;
    }
    // An explicit new invocation branches at this post, regardless of the
    // original X conversation. Unrelated replies are never wakeups.
    return event.event_type === "post.mention.create"
      ? `x:post:${event.payload.id}`
      : null;
  }
  async function processIngress(limit = 25) {
    const unmatchedBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Unmatched direct replies stay durable without occupying the ready queue.
    // Once the exact parent link exists, any process can continue the task.
    const awaitingParentReady = and(
      eq(chatActions.status, "awaiting_parent"),
      or(
        sql`exists (select 1 from chat_message_links link where link.endpoint_id = ${chatActions.endpointId} and link.direction = 'outbound' and link.provider_message_id = ${chatActions.payload}->>'parentPostId')`,
        and(
          sql`${chatActions.payload}->'event'->>'event_type' = 'post.mention.create'`,
          sql`not exists (select 1 from chat_publications publication where publication.endpoint_id = ${chatActions.endpointId} and publication.state = 'streaming' and publication.payload->'xReply' is not null)`,
        ),
        and(
          sql`${chatActions.payload}->'event'->>'event_type' = 'post.reply.create'`,
          lte(chatActions.createdAt, unmatchedBefore),
        ),
      ),
    );
    const rows = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "x_webhook_ingress"),
          or(
            eq(chatActions.status, "received"),
            awaitingParentReady,
            and(
              eq(chatActions.status, "processing"),
              lte(chatActions.updatedAt, new Date(Date.now() - 120_000)),
            ),
          ),
        ),
      )
      .orderBy(asc(chatActions.createdAt))
      .limit(limit);
    for (const action of rows) {
      const claim = randomUUID();
      const [claimed] = await db
        .update(chatActions)
        .set({ status: "processing", result: { claim }, updatedAt: new Date() })
        .where(
          and(
            eq(chatActions.id, action.id),
            or(
              eq(chatActions.status, "received"),
              awaitingParentReady,
              and(
                eq(chatActions.status, "processing"),
                lte(chatActions.updatedAt, new Date(Date.now() - 120_000)),
              ),
            ),
          ),
        )
        .returning();
      if (!claimed) continue;
      try {
        const [endpoint] = await db
          .select()
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, action.endpointId));
        const event = claimed.payload.event as XEvent;
        if (
          endpoint &&
          ["verifying", "active"].includes(endpoint.status) &&
          endpoint.botExternalId === action.payload.botId &&
          ((endpoint.setup as unknown as Record<string, unknown>)
            .runtimeGeneration ?? 0) === action.payload.generation &&
          !(await optedOut(endpoint.id, event.payload.author_id))
        ) {
          const threadId =
            typeof event.payload.paperclipThreadId === "string"
              ? event.payload.paperclipThreadId
              : await resolveThread(endpoint, event);
          if (!threadId && xParent(event.payload)) {
            const expired =
              event.event_type === "post.reply.create" &&
              claimed.createdAt <= unmatchedBefore;
            await db
              .update(chatActions)
              .set({
                status: expired ? "processed" : "awaiting_parent",
                result: expired
                  ? {
                      claim,
                      disposition: "ignored",
                      reason: "X reply parent was not recorded within 24 hours",
                    }
                  : { claim },
                payload: {
                  ...claimed.payload,
                  parentPostId: xParent(event.payload),
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  sql`${chatActions.result}->>'claim' = ${claim}`,
                ),
              );
            continue;
          }
          if (threadId) {
            const context =
              event.payload.paperclipContext ??
              (await xAncestors(event, () => hooks.token(endpoint), fetchImpl));
            // Persist the branch and context before dispatch; repeated SDK
            // callbacks deduplicate against the original post ID.
            event.payload.paperclipThreadId = threadId;
            event.payload.paperclipContext = context;
            const persisted = await db
              .update(chatActions)
              .set({
                payload: { ...claimed.payload, event },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  sql`${chatActions.result}->>'claim' = ${claim}`,
                ),
              )
              .returning({ id: chatActions.id });
            if (!persisted.length) continue;
            await hooks.dispatch(endpoint, event);
          }
        }
        await db
          .update(chatActions)
          .set({ status: "processed", updatedAt: new Date() })
          .where(
            and(
              eq(chatActions.id, action.id),
              sql`${chatActions.result}->>'claim' = ${claim}`,
            ),
          );
      } catch {
        await db
          .update(chatActions)
          .set({
            status: "received",
            result: { error: "X intake processing will retry" },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              sql`${chatActions.result}->>'claim' = ${claim}`,
            ),
          );
      }
    }
    return rows.length;
  }
  async function execute(binding: XBinding, tool: string, input: unknown) {
    const source = await authority(binding);
    if (tool === "x_read_thread") {
      empty.parse(input);
      const messages = await db
        .select({ event: chatDeliveries.normalizedEvent })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.companyId, binding.companyId),
            eq(chatDeliveries.conversationId, source.conversation.id),
          ),
        )
        .orderBy(desc(chatDeliveries.receivedAt))
        .limit(100);
      const replies = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, binding.companyId),
            eq(chatPublications.conversationId, source.conversation.id),
            sql`${chatPublications.payload}->'xReply' is not null`,
          ),
        )
        .orderBy(desc(chatPublications.createdAt))
        .limit(100);
      return {
        messages: messages.reverse().map((m) => m.event.message),
        replies: replies.reverse().map((row) => ({
          ...summary(row),
          replyToPostId: row.payload.xReply!.replyToPostId,
          text: row.payload.text,
        })),
        replyablePostIds: [messageId(source.delivery)],
        invokingPostId: messageId(source.delivery),
        invokingMessage: source.delivery.normalizedEvent.message,
      };
    }
    if (tool === "x_delivery") {
      const { publicationId } = statusSchema.parse(input);
      const [publication] = await db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.id, publicationId),
            eq(chatPublications.companyId, binding.companyId),
            eq(chatPublications.issueId, binding.issueId),
            eq(chatPublications.endpointId, source.endpoint.id),
          ),
        );
      if (!publication?.payload.xReply)
        throw notFound("X publication not found");
      return summary(publication);
    }
    if (tool !== "x_reply") throw forbidden("Unknown X tool");
    if (
      source.workMode !== "standard" ||
      (binding.workMode && binding.workMode !== "standard")
    )
      throw forbidden("X replies require standard work mode");
    const request = replySchema.parse(input);
    validateXReply(request.text);
    if (request.replyToPostId !== messageId(source.delivery))
      throw forbidden("Reply to the invoking post returned by x_read_thread");
    const key = `x:${source.endpoint.id}:${binding.issueId}:${request.idempotencyKey}`;
    const publication = await db.transaction(async (tx) => {
      await tx
        .select({ id: chatEndpoints.id })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, source.endpoint.id))
        .for("update");
      const [existing] = await tx
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, binding.companyId),
            eq(chatPublications.idempotencyKey, key),
          ),
        );
      if (existing) {
        if (
          existing.payload.xReply?.replyToPostId !== request.replyToPostId ||
          existing.payload.text !== request.text
        ) {
          throw conflict(
            "This idempotency key belongs to a different X reply; use a new key for a new interaction",
            { publicationId: existing.id },
          );
        }
        return existing;
      }
      const [interaction] = await tx
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.endpointId, source.endpoint.id),
            sql`${chatPublications.payload}->'xReply'->>'replyToPostId' = ${request.replyToPostId}`,
          ),
        );
      if (interaction)
        throw conflict(
          "This interaction already has a reply intent; check x_delivery",
          { publicationId: interaction.id },
        );
      const [created] = await tx
        .insert(chatPublications)
        .values({
          companyId: binding.companyId,
          endpointId: source.endpoint.id,
          conversationId: source.conversation.id,
          issueId: binding.issueId,
          idempotencyKey: key,
          payload: {
            text: request.text,
            xReply: {
              replyToPostId: request.replyToPostId,
              actionId: source.actionId,
              runId: binding.runId,
              agentId: binding.agentId,
              senderId: source.senderId,
            },
          },
        })
        .returning();
      await logActivity(tx as unknown as Db, {
        companyId: binding.companyId,
        actorType: "agent",
        actorId: binding.agentId,
        action: "chat.x_reply_requested",
        entityType: "issue",
        entityId: binding.issueId,
        details: {
          publicationId: created.id,
          replyToPostId: request.replyToPostId,
        },
      });
      return created;
    });
    return summary(publication);
  }
  async function processPublications(limit = 25) {
    await db
      .update(chatPublications)
      .set({
        state: "delivery_unknown",
        redactedError:
          "X delivery was interrupted. Check X before taking further action.",
        updatedAt: new Date(),
      })
      .where(
        and(
          sql`${chatPublications.payload}->'xReply' is not null`,
          eq(chatPublications.state, "streaming"),
          lte(chatPublications.updatedAt, new Date(Date.now() - 60_000)),
          sql`not exists (select 1 from chat_endpoint_leases lease where lease.endpoint_id = ${chatPublications.endpointId} and lease.lease_key = 'credentials' and lease.expires_at > now())`,
        ),
      );
    const rows = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          sql`${chatPublications.payload}->'xReply' is not null`,
          eq(chatPublications.state, "pending"),
        ),
      )
      .orderBy(asc(chatPublications.createdAt))
      .limit(limit);
    for (const row of rows) {
      const intent = row.payload.xReply!;
      let sending = false;
      try {
        const binding = {
          companyId: row.companyId,
          issueId: row.issueId,
          agentId: intent.agentId,
          runId: intent.runId,
        };
        const source = await authority(binding, intent.actionId);
        const token = await hooks.token(source.endpoint);
        await hooks.withSendLease(source.endpoint, async () => {
          await authority(binding, intent.actionId);
          const [claimed] = await db
            .update(chatPublications)
            .set({
              state: "streaming",
              attempts: sql`${chatPublications.attempts} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatPublications.id, row.id),
                eq(chatPublications.state, "pending"),
              ),
            )
            .returning();
          if (!claimed) return;
          sending = true;
          const result = await xRequest(
            token,
            "/2/tweets",
            {
              text: row.payload.text,
              reply: { in_reply_to_tweet_id: intent.replyToPostId },
            },
            fetchImpl,
          );
          const postId = xId.parse(result.data?.id);
          await db.transaction(async (tx) => {
            await tx
              .insert(chatMessageLinks)
              .values({
                companyId: row.companyId,
                endpointId: row.endpointId,
                conversationId: row.conversationId,
                publicationId: row.id,
                providerMessageId: postId,
                direction: "outbound",
              })
              .onConflictDoNothing();
            await tx
              .update(chatPublications)
              .set({
                state: "published",
                providerMessageId: postId,
                providerUrl: `https://x.com/i/status/${postId}`,
                publishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(chatPublications.id, row.id));
            await tx
              .update(chatEndpoints)
              .set({ lastPublicationAt: new Date(), updatedAt: new Date() })
              .where(eq(chatEndpoints.id, row.endpointId));
          });
        });
      } catch (error) {
        const knownRejection =
          error instanceof XApiError &&
          error.status >= 400 &&
          error.status < 500;
        await db
          .update(chatPublications)
          .set({
            state: sending && !knownRejection ? "delivery_unknown" : "failed",
            redactedError:
              error instanceof XApiError
                ? error.message
                : sending
                  ? "X delivery is uncertain. Check x_delivery and the external conversation; do not repost."
                  : "X reply authorization changed or credentials are unavailable",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatPublications.id, row.id),
              eq(chatPublications.state, sending ? "streaming" : "pending"),
            ),
          );
      }
    }
    return rows.length;
  }
  return {
    intake,
    resolveThread,
    processIngress,
    execute,
    authority,
    processPublications,
    optedOut,
  };
}
export type XChannelService = ReturnType<typeof xChannelService>;
