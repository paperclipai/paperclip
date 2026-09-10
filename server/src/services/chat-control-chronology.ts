import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatPublications,
  type Db,
} from "@paperclipai/db";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

/** Absence is not affirmative authorization. Consumers must compare exactly. */
export type ChatControlChronology =
  "no_proven_control" | "before_or_unproven" | "after_all_proven_controls";

export function teamsConversationId(threadId: string): string | null {
  const match = /^teams:([^:]+)(?::|$)/.exec(threadId);
  if (!match) return null;
  try {
    const encoded = match[1];
    const bytes = Buffer.from(encoded, "base64url");
    const decoded = bytes.toString("utf8");
    // Node's base64url decoder is deliberately permissive: an ordinary
    // legacy id such as `teams:personal-chat` can decode to replacement
    // characters instead of throwing. Require a canonical byte round trip so
    // only SDK-encoded Teams conversation ids lose their mutable route suffix.
    if (
      bytes.toString("base64url") !== encoded ||
      !Buffer.from(decoded, "utf8").equals(bytes)
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function canonicalTeamsThreadId(threadId: string): string | null {
  const conversationId = teamsConversationId(threadId);
  return conversationId
    ? `teams:${Buffer.from(conversationId).toString("base64url")}`
    : null;
}

export function externalThreadIdentityCondition(
  expression: SQL,
  threadId: string,
): SQL | undefined {
  const canonicalTeamsId = canonicalTeamsThreadId(threadId);
  if (!canonicalTeamsId) return eq(expression, threadId);
  const encodedConversationId = canonicalTeamsId.slice("teams:".length);
  // Compare colon-delimited identity segments exactly. A LIKE prefix would
  // treat valid base64url `_` characters as wildcards and could merge the
  // delivery queue or lease for two unrelated Teams conversations.
  return and(
    eq(sql<string>`split_part(${expression}, ':', 1)`, "teams"),
    eq(sql<string>`split_part(${expression}, ':', 2)`, encodedConversationId),
  );
}

export async function readChatControlChronology(
  database: DbOrTransaction,
  endpoint: Pick<
    typeof chatEndpoints.$inferSelect,
    "companyId" | "id" | "provider"
  >,
  thread: { id: string; channelId: string },
  delivery: Pick<
    typeof chatDeliveries.$inferSelect,
    "normalizedEvent" | "receivedAt"
  >,
  options: { requirePublishedControlProofForConversationId?: string } = {},
): Promise<ChatControlChronology> {
  // This proves only source chronology, never current task/provider authority.
  // Intake ignores unproved control candidates. Presentation's stricter mode
  // requires exact proof for every published control in its current binding.
  const requiredConversationId =
    options.requirePublishedControlProofForConversationId;
  if (requiredConversationId) {
    const [binding] = await database
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.id, requiredConversationId),
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          ...(endpoint.provider === "microsoft-teams"
            ? []
            : [eq(chatConversations.externalConversationId, thread.channelId)]),
          externalThreadIdentityCondition(
            sql`${chatConversations.externalThreadId}`,
            thread.id,
          ),
        ),
      )
      .limit(1);
    if (!binding) return "before_or_unproven";
  }
  // Operator-confirmed completion may have no outbound ID/link.
  const command = alias(chatActions, "completed_native_command");
  // Match linearControlCommand's ECMAScript trim exactly. PostgreSQL's default
  // btrim removes only ASCII spaces, forgetting valid newline/tab controls.
  const trimWhitespace =
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  const retainedControlText = sql<string>`btrim(${chatDeliveries.normalizedEvent}->'message'->>'text', ${trimWhitespace})`;
  const redactedControl = and(
    sql`${chatDeliveries.normalizedEvent}->'filtering'->>'contentRetained' = 'false'`,
    or(
      isNull(chatDeliveries.principalId),
      eq(chatDeliveries.principalId, chatActions.principalId),
    ),
    sql`not (${chatDeliveries.normalizedEvent} ? 'principal')`,
    sql`not (coalesce(${chatDeliveries.normalizedEvent}->'message', '{}'::jsonb) ? 'text')`,
  );
  let cursor: string | null = null;
  let hasProvenControl = false;
  while (true) {
    const boundaries = await database
      .select({
        publication: { id: chatPublications.id },
        authorization: { id: chatActions.id, updatedAt: chatActions.updatedAt },
        delivery: {
          id: chatDeliveries.id,
          receivedAt: chatDeliveries.receivedAt,
          providerSentAt: sql<
            string | null
          >`${chatDeliveries.normalizedEvent}->'message'->>'providerSentAt'`,
          providerSentAtSource: sql<
            string | null
          >`${chatDeliveries.normalizedEvent}->'message'->>'providerSentAtSource'`,
          providerMessageSequence: sql<unknown>`${chatDeliveries.normalizedEvent}->'message'->'providerMessageSequence'`,
          providerMessageId: sql<
            string | null
          >`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId'`,
        },
        command: {
          id: command.id,
          createdAt: command.createdAt,
          interactionId: sql<unknown>`${command.payload}->'invocation'->>'interactionId'`,
        },
      })
      .from(chatPublications)
      .innerJoin(
        chatConversations,
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.id, chatPublications.conversationId),
          ...(endpoint.provider === "microsoft-teams"
            ? []
            : [eq(chatConversations.externalConversationId, thread.channelId)]),
          externalThreadIdentityCondition(
            sql`${chatConversations.externalThreadId}`,
            thread.id,
          ),
        ),
      )
      .leftJoin(
        chatActions,
        and(
          eq(chatConversations.issueId, chatPublications.issueId),
          eq(chatActions.companyId, endpoint.companyId),
          eq(chatActions.endpointId, endpoint.id),
          eq(chatActions.conversationId, chatConversations.id),
          eq(chatActions.kind, "task_control_authorization"),
          eq(chatActions.status, "processed"),
          isNotNull(chatActions.principalId),
          sql`${chatActions.providerActionId} = 'task-control-authorization:' || ${chatPublications.id}::text`,
          sql`${chatActions.payload}->>'publicationId' = ${chatPublications.id}::text`,
          sql`${chatActions.result}->>'code' in ('task_control_authorized_and_sent', 'task_control_marked_delivered_by_operator')`,
        ),
      )
      .leftJoin(
        chatDeliveries,
        and(
          eq(chatDeliveries.companyId, endpoint.companyId),
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.conversationId, chatConversations.id),
          or(
            eq(chatDeliveries.principalId, chatActions.principalId),
            redactedControl,
          ),
          eq(chatDeliveries.state, "processed"),
          inArray(chatDeliveries.eventKind, [
            "message",
            "direct_message",
            "mention",
          ]),
          sql`${chatPublications.idempotencyKey} in ('control:close:' || ${chatDeliveries.id}::text, 'control:new:' || ${chatDeliveries.id}::text)`,
          sql`${chatDeliveries.normalizedEvent}->>'providerEventId' = ${chatDeliveries.providerEventId}`,
          or(
            sql`${chatDeliveries.normalizedEvent}->>'kind' = ${chatDeliveries.eventKind}`,
            redactedControl,
          ),
          ...(endpoint.provider === "microsoft-teams"
            ? []
            : [
                or(
                  sql`${chatDeliveries.normalizedEvent}->'conversation'->>'externalConversationId' = ${chatConversations.externalConversationId}`,
                  redactedControl,
                ),
              ]),
          externalThreadIdentityCondition(
            sql`${chatDeliveries.normalizedEvent}->'conversation'->>'externalThreadId'`,
            thread.id,
          ),
          or(
            redactedControl,
            and(
              sql`${retainedControlText} ~ '^/([nN][eE][wW]|[cC][lL][oO][sS][eE])(@[A-Za-z0-9_.-]+)?$'`,
              sql`substring(lower(${retainedControlText}) from '^/(new|close)') = split_part(${chatPublications.idempotencyKey}, ':', 2)`,
            ),
          ),
          sql`length(${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId') > 0`,
        ),
      )
      .leftJoin(
        command,
        and(
          sql`${endpoint.provider} = 'discord'`,
          eq(command.companyId, endpoint.companyId),
          eq(command.endpointId, endpoint.id),
          eq(command.conversationId, chatConversations.id),
          eq(command.principalId, chatActions.principalId),
          eq(command.kind, "discord_native_command"),
          eq(command.status, "processed"),
          sql`${command.payload}->>'version' = '1'`,
          sql`${command.result}->>'kind' = 'discord_native_command_recorded'`,
          sql`${command.result}->>'publicationId' = ${chatPublications.id}::text`,
          sql`${command.providerActionId} = 'discord-native-command:' || (${command.payload}->'invocation'->>'interactionId')`,
          sql`${chatPublications.idempotencyKey} = 'control:' || (${command.payload}->'invocation'->>'command') || ':discord:' || ${endpoint.id} || ':' || (${command.payload}->'invocation'->>'interactionId')`,
          sql`${command.payload}->'target'->>'conversationId' = ${chatConversations.id}::text`,
          sql`${command.payload}->'target'->>'issueId' = ${chatConversations.issueId}::text`,
          sql`${command.payload}->'target'->>'sessionGeneration' = ${chatConversations.sessionGeneration}::text`,
        ),
      )
      .where(
        and(
          eq(chatPublications.companyId, endpoint.companyId),
          eq(chatPublications.endpointId, endpoint.id),
          sql`${chatPublications.idempotencyKey} ~ '^control:(close|new):'`,
          or(
            and(
              isNotNull(chatActions.id),
              or(isNotNull(chatDeliveries.id), isNotNull(command.id)),
            ),
            ...(requiredConversationId
              ? [
                  and(
                    eq(chatPublications.conversationId, requiredConversationId),
                    eq(chatPublications.state, "published"),
                  ),
                ]
              : []),
          ),
          ...(cursor ? [lt(chatPublications.id, cursor)] : []),
        ),
      )
      // A late older control/operator confirmation cannot erase a stronger
      // earlier boundary. Exact UUID keyset pages avoid timestamp precision
      // loss and impose no arbitrary lifetime limit on valid conversations.
      .orderBy(desc(chatPublications.id))
      .limit(64);
    if (!boundaries.length)
      return hasProvenControl
        ? "after_all_proven_controls"
        : "no_proven_control";
    if (
      boundaries.some(
        (boundary) =>
          !boundary.authorization || (!boundary.delivery && !boundary.command),
      )
    )
      return "before_or_unproven";
    hasProvenControl = true;
    const object = (value: unknown): Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const source = object(delivery.normalizedEvent.message);
    const parsedTime = (message: Record<string, unknown>) =>
      typeof message.providerSentAt === "string" &&
      message.providerSentAt.length <= 64
        ? Date.parse(message.providerSentAt)
        : Number.NaN;
    const slackControlOrigin =
      object(delivery.normalizedEvent.admission).origin ===
        "slack_slash_control" && endpoint.provider === "slack";
    const snowflake = (value: unknown) =>
      typeof value === "string" && /^[0-9]{17,20}$/.test(value)
        ? BigInt(value)
        : null;
    const discordSource =
      endpoint.provider === "discord"
        ? snowflake(source.providerMessageId)
        : null;
    const sourceTime = slackControlOrigin
      ? delivery.receivedAt.getTime()
      : discordSource !== null
        ? Number((discordSource >> 22n) + 1420070400000n)
        : parsedTime(source);
    const clockMarker =
      endpoint.provider === "telegram"
        ? "telegram_message_date"
        : endpoint.provider === "microsoft-teams"
          ? "teams_activity_timestamp"
          : endpoint.provider === "slack" && !slackControlOrigin
            ? "slack_message_ts"
            : null;
    if (
      !Number.isFinite(sourceTime) ||
      sourceTime > delivery.receivedAt.getTime() ||
      (endpoint.provider === "discord" && discordSource === null) ||
      (clockMarker && source.providerSentAtSource !== clockMarker)
    )
      return "before_or_unproven";
    for (const boundary of boundaries) {
      const original = boundary.delivery;
      const originalMessage = object(original);
      const originalTime = parsedTime(originalMessage);
      const originalHasProviderClock =
        original &&
        Number.isFinite(originalTime) &&
        originalTime <= original.receivedAt.getTime() &&
        (endpoint.provider === "slack"
          ? originalMessage.providerSentAtSource === "slack_message_ts"
          : clockMarker
            ? originalMessage.providerSentAtSource === clockMarker
            : true);
      let cutoff = originalHasProviderClock
        ? originalTime
        : (original?.receivedAt.getTime() ??
          boundary.authorization!.updatedAt.getTime());
      let discordControl: bigint | null = null;
      if (boundary.command) {
        discordControl = snowflake(boundary.command.interactionId);
        if (discordControl !== null) {
          const interactionTime = Number(
            (discordControl >> 22n) + 1420070400000n,
          );
          if (
            Number.isSafeInteger(interactionTime) &&
            interactionTime <= boundary.command.createdAt.getTime()
          )
            cutoff = interactionTime;
        }
      }
      if (sourceTime < cutoff) return "before_or_unproven";
      if (sourceTime > cutoff) continue;
      // Telegram dates are whole seconds; the actual provider message sequence
      // can prove a later source in that same second. Receipt order cannot.
      if (endpoint.provider === "telegram" && originalHasProviderClock) {
        const incoming = source.providerMessageSequence;
        const previous = originalMessage.providerMessageSequence;
        if (
          typeof incoming === "number" &&
          Number.isSafeInteger(incoming) &&
          incoming > 0 &&
          typeof previous === "number" &&
          Number.isSafeInteger(previous) &&
          previous > 0 &&
          incoming > previous
        )
          continue;
      }
      if (endpoint.provider === "slack" && originalHasProviderClock) {
        const incoming = source.providerMessageId;
        const previous = originalMessage.providerMessageId;
        if (
          typeof incoming === "string" &&
          typeof previous === "string" &&
          /^[1-9][0-9]{0,12}\.[0-9]{6}$/.test(incoming) &&
          /^[1-9][0-9]{0,12}\.[0-9]{6}$/.test(previous) &&
          BigInt(incoming.replace(".", "")) > BigInt(previous.replace(".", ""))
        )
          continue;
      }
      // Within one millisecond, only the same worker/process increment orders
      // Discord events. Numerically larger IDs from another worker do not.
      if (
        discordSource !== null &&
        discordControl !== null &&
        discordSource >> 12n === discordControl >> 12n &&
        (discordSource & 0xfffn) > (discordControl & 0xfffn)
      )
        continue;
      return "before_or_unproven";
    }
    cursor = boundaries.at(-1)!.publication.id;
  }
}
