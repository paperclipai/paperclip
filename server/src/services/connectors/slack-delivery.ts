import { and, eq, sql, inArray } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { authorizeSlackChannel } from "./slack-access.js";
import type {
  SlackTaskAuthority,
  SlackTaskBinding,
} from "./slack-authority.js";
import {
  object,
  objects,
  nextCursor,
  type slackClient,
} from "./slack-client.js";

/** Reconciliation is read-only at Slack. Missing evidence never means safe to resend. */
export async function slackDelivery(
  db: Db,
  binding: SlackTaskBinding,
  authority: SlackTaskAuthority,
  api: ReturnType<typeof slackClient>,
  actionId: string,
) {
  let [action] = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.id, actionId),
        eq(chatActions.companyId, binding.companyId),
        eq(chatActions.endpointId, authority.endpoint.id),
        eq(chatActions.kind, "slack_tool_write"),
        sql`${chatActions.payload}->>'userId' = ${authority.userId}`,
        sql`${chatActions.payload}->'binding'->>'issueId' = ${binding.issueId}`,
      ),
    );
  if (!action)
    throw forbidden("Slack delivery does not belong to this requester's task");
  if (
    action.status === "processing" &&
    Date.now() - action.updatedAt.getTime() > 5 * 60_000
  ) {
    const [stale] = await db
      .update(chatActions)
      .set({ status: "uncertain", updatedAt: new Date() })
      .where(
        and(
          eq(chatActions.id, action.id),
          eq(chatActions.status, "processing"),
          eq(chatActions.updatedAt, action.updatedAt),
        ),
      )
      .returning();
    if (stale) action = stale;
  }
  const args = object(action.payload.args);
  if (action.status === "uncertain" && typeof args.channel === "string") {
    await authorizeSlackChannel(authority, api, args.channel);
    let receipt: Record<string, unknown> | null = null;
    if (action.payload.name === "slack_post_message") {
      let cursor = "";
      for (let page = 0; page < 5; page++) {
        const response = await api(
          args.thread_ts ? "conversations.replies" : "conversations.history",
          {
            channel: args.channel,
            ...(args.thread_ts ? { ts: args.thread_ts } : {}),
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
        );
        const match = objects(response.messages).find(
          (message) =>
            message.client_msg_id === args.idempotencyKey &&
            message.user === authority.endpoint.botExternalId,
        );
        if (match) {
          receipt = { channel: args.channel, ts: match.ts, reconciled: true };
          break;
        }
        const next = nextCursor(response);
        if (!next || cursor === next) break;
        cursor = next;
      }
    } else if (
      action.payload.name === "slack_upload_file" &&
      typeof action.result?.fileId === "string"
    ) {
      const file = object(
        (await api("files.info", { file: action.result.fileId })).file,
      );
      const shares = object(file.shares);
      const occurrences = [
        ...objects(object(shares.public)[args.channel]),
        ...objects(object(shares.private)[args.channel]),
      ];
      if (
        file.id === action.result.fileId &&
        occurrences.some(
          (share) => !args.thread_ts || share.thread_ts === args.thread_ts,
        )
      )
        receipt = {
          channel: args.channel,
          fileIds: [file.id],
          reconciled: true,
        };
    }
    if (receipt) {
      const [settled] = await db
        .update(chatActions)
        .set({ status: "processed", result: receipt, updatedAt: new Date() })
        .where(
          and(
            eq(chatActions.id, action.id),
            inArray(chatActions.status, ["uncertain", "processing"]),
          ),
        )
        .returning();
      if (settled) action = settled;
    }
  }
  return {
    actionId: action.id,
    state: action.status === "processed" ? "delivered" : action.status,
    receipt: action.result,
    ...(action.status === "uncertain"
      ? {
          instruction:
            "Delivery remains uncertain. No duplicate was sent. Inspect Slack and resolve the receipt before attempting another operation.",
        }
      : {}),
  };
}
