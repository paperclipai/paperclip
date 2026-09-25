import { authorizeSlackDocument } from "./slack-document.js";
import { slackDelivery } from "./slack-delivery.js";
import { slackMessage } from "./slack-message.js";
import { executeSlackWrite } from "./slack-writes.js";
import { syncSlackBotTools } from "./slack-catalog.js";
import { SLACK_TOOLS } from "@paperclipai/shared";
import {
  toolProfiles,
  toolProfileBindings,
  toolProfileEntries,
  type Db,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { badRequest, forbidden } from "../../errors.js";
import {
  resolveSlackTaskAuthority,
  slackEndpointCandidates,
  type SlackTaskBinding,
} from "./slack-authority.js";
import {
  slackClient,
  object,
  objects,
  nextCursor,
  type SlackObject,
} from "./slack-client.js";
import {
  authorizeSlackChannel,
  recordSlackReadBoundary,
} from "./slack-access.js";

async function slackAssignedEndpoint(
  db: Db,
  binding: Partial<SlackTaskBinding> & { companyId: string; agentId: string },
) {
  if (!binding.runId || !binding.issueId) return [];
  let authority: Awaited<ReturnType<typeof resolveSlackTaskAuthority>>;
  try {
    authority = await resolveSlackTaskAuthority(
      db,
      binding as SlackTaskBinding,
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 403
    )
      return [];
    throw error;
  }
  // Catalog updates are idempotent and preserve configured policies.
  await db.transaction((tx) =>
    syncSlackBotTools(tx, authority.endpoint, authority.userId, true),
  );
  const [enabledProfile] = await db
    .select({ id: toolProfiles.id })
    .from(toolProfiles)
    .innerJoin(
      toolProfileBindings,
      and(
        eq(toolProfileBindings.profileId, toolProfiles.id),
        eq(toolProfileBindings.companyId, binding.companyId),
        eq(toolProfileBindings.targetType, "agent"),
        eq(toolProfileBindings.targetId, binding.agentId),
      ),
    )
    .innerJoin(
      toolProfileEntries,
      and(
        eq(toolProfileEntries.profileId, toolProfiles.id),
        eq(toolProfileEntries.connectionId, authority.endpoint.connectionId),
        eq(toolProfileEntries.effect, "include"),
      ),
    )
    .where(
      and(
        eq(toolProfiles.companyId, binding.companyId),
        eq(toolProfiles.profileKey, `slack-bot:${authority.endpoint.id}`),
        eq(toolProfiles.status, "active"),
      ),
    )
    .limit(1);
  if (!enabledProfile) return [];
  authority = await resolveSlackTaskAuthority(db, binding as SlackTaskBinding);
  return [
    {
      id: authority.endpoint.id,
      connectionId: authority.endpoint.connectionId,
      label: authority.endpoint.botDisplayName ?? "Slack",
      metadata: {
        workspaceId: authority.endpoint.providerAccountId,
        channelId: authority.conversation?.externalConversationId.replace(
          /^slack:/,
          "",
        ),
        requesterId: authority.slackUserId,
        authorizationRevision: authority.revision,
      },
    },
  ];
}
export async function slackAssignedResource(
  db: Db,
  binding: Partial<SlackTaskBinding> & { companyId: string; agentId: string },
) {
  const resources = [];
  for (const endpoint of await slackEndpointCandidates(db, binding)) {
    resources.push(
      ...(await slackAssignedEndpoint(db, {
        ...binding,
        endpointId: endpoint.id,
      })),
    );
  }
  return resources;
}

const messageView = (message: SlackObject, team: string, channel: string) => ({
  ts: message.ts,
  threadTs: message.thread_ts,
  user: message.user,
  text: message.text,
  subtype: message.subtype,
  replyCount: message.reply_count,
  files: objects(message.files).map((file) => ({
    id: file.id,
    name: file.name,
    mimetype: file.mimetype,
    size: file.size,
  })),
  sourceUrl:
    typeof message.ts === "string"
      ? `https://app.slack.com/client/${team}/${channel}/thread/${channel}-${message.thread_ts ?? message.ts}`
      : undefined,
});

export async function executeSlackTool(
  db: Db,
  binding: SlackTaskBinding,
  name: string,
  value: unknown,
  fetchImpl = fetch,
  invocationId?: string,
) {
  const tool = SLACK_TOOLS.find((entry) => entry.name === name);
  if (!tool) throw forbidden("Unknown Slack tool");
  const { endpointId, ...args } = tool.schema.parse(value) as SlackObject;
  if (endpointId !== undefined) {
    if (binding.endpointId && binding.endpointId !== endpointId)
      throw forbidden("Slack connection selector does not match this tool");
    binding = { ...binding, endpointId: String(endpointId) };
  }
  const authority = await resolveSlackTaskAuthority(db, binding);
  binding = { ...binding, endpointId: authority.endpoint.id };
  const upstream = slackClient(authority.botToken, fetchImpl);
  const users = new Map<string, Promise<SlackObject>>();
  const api: typeof upstream = (method, args = {}) => {
    if (method !== "users.info") return upstream(method, args);
    const user = String(args.user);
    if (!users.has(user)) users.set(user, upstream(method, args));
    return users.get(user)!;
  };
  // Mutations enter the durable executor; never fall through into arbitrary API execution.
  if (tool.risk !== "read")
    return executeSlackWrite(db, binding, name, args, invocationId, fetchImpl);
  if (name === "slack_delivery")
    return slackDelivery(db, binding, authority, api, String(args.actionId));
  const readable = async (id: string) => {
    const channel = await authorizeSlackChannel(authority, api, id);
    await recordSlackReadBoundary(db, authority, channel);
    return channel;
  };
  if (name === "slack_channels") {
    const result = await api("conversations.list", {
      ...args,
      limit: args.limit ?? 50,
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: true,
    });
    const channels: SlackObject[] = [];
    for (const channel of objects(result.channels)) {
      if (channel.is_member !== true && channel.is_im !== true) continue;
      try {
        const authorized = await authorizeSlackChannel(
          authority,
          api,
          String(channel.id),
        );
        if (
          authorized.is_private === true ||
          authorized.is_mpim === true ||
          authorized.is_im === true
        ) {
          if (
            authority.conversation &&
            !authority.conversation.isDirectMessage &&
            authorized.id !==
              authority.conversation.externalConversationId.replace(
                /^slack:/,
                "",
              )
          )
            continue;
          await recordSlackReadBoundary(db, authority, authorized);
        }
        channels.push({
          id: authorized.id,
          name: authorized.name,
          private: authorized.is_private,
          direct: authorized.is_im,
        });
      } catch (error) {
        // Access denials omit inaccessible channels; provider outages/rate limits
        // must remain visible rather than masquerading as an empty directory.
        if (!(
          error &&
          typeof error === "object" &&
          "status" in error &&
          error.status === 403
        ))
          throw error;
      }
    }
    return {
      channels,
      nextCursor: nextCursor(result),
      coverage:
        "Current bot memberships accessible to the linked requester; more pages may remain.",
    };
  }
  if (name === "slack_user") {
    const result = object((await api("users.info", args)).user);
    return {
      id: result.id,
      name: result.name,
      displayName: object(result.profile).display_name,
      realName: result.real_name,
      deleted: result.deleted,
      bot: result.is_bot,
    };
  }
  if (name === "slack_emoji") return { emoji: (await api("emoji.list")).emoji };
  if (name === "slack_search") {
    const channels = args.channels as string[];
    if (args.cursor && channels.length !== 1)
      throw badRequest(
        "Continue one channel at a time using its returned cursor",
      );
    // A deliberately bounded scan is also available when native RTS is not
    // qualified for the current runtime's transcript-retention behavior.
    const matches: unknown[] = [];
    const inspected: unknown[] = [];
    for (const channel of channels) {
      await readable(channel);
      const result = await api("conversations.history", {
        channel,
        limit: 100,
        ...(args.oldest ? { oldest: args.oldest } : {}),
        ...(args.latest ? { latest: args.latest } : {}),
        ...(args.cursor && channels.length === 1
          ? { cursor: args.cursor }
          : {}),
      });
      const messages = objects(result.messages);
      const candidates =
        args.contentType === "files"
          ? messages.filter((m) =>
              objects(m.files).some((f) =>
                [f.name, f.title].some(
                  (v) =>
                    typeof v === "string" &&
                    v
                      .toLocaleLowerCase()
                      .includes(String(args.query).toLocaleLowerCase()),
                ),
              ),
            )
          : messages;
      const found = candidates.filter(
        (m) =>
          (args.contentType === "files" ||
            (typeof m.text === "string" &&
              m.text
                .toLocaleLowerCase()
                .includes(String(args.query).toLocaleLowerCase()))) &&
          (!args.author || m.user === args.author),
      );
      const selected = found.slice(0, Number(args.limit ?? 20));
      matches.push(
        ...selected.map((m) =>
          messageView(m, authority.endpoint.providerAccountId!, channel),
        ),
      );
      inspected.push({
        channel,
        matched: selected.length,
        omittedMatches: found.length - selected.length,
        ...(found.length > selected.length
          ? { continueWith: { channel, latest: selected.at(-1)?.ts } }
          : {}),
        count: messages.length,
        oldest: messages.at(-1)?.ts ?? null,
        newest: messages[0]?.ts ?? null,
        nextCursor: nextCursor(result),
        hasMore: result.has_more === true || !!nextCursor(result),
      });
    }
    return {
      mode: "bounded_history",
      exhaustive: false,
      matches,
      inspected,
      limitation:
        "File searches match linked filenames/titles, not file contents. Scanned at most 100 top-level messages per specified channel. Thread replies, older pages, deleted and retention-limited content were not searched. Native Slack search is not qualified for this runtime's transcript retention. If matches were truncated, continue that channel using continueWith.latest (omit cursor); otherwise use its cursor. Fetch threads separately.",
    };
  }
  const channel = String(args.channel);
  const authorized = await readable(channel);
  if (name === "slack_channel_info")
    return {
      channel: {
        id: authorized.id,
        name: authorized.name,
        private: authorized.is_private,
        direct: authorized.is_im,
        topic: object(authorized.topic).value,
        purpose: object(authorized.purpose).value,
        memberCount: authorized.num_members,
      },
    };
  if (name === "slack_members") {
    const result = await api(tool.method, args);
    return { members: result.members, nextCursor: nextCursor(result) };
  }
  if (
    name === "slack_history" ||
    name === "slack_thread" ||
    name === "slack_message"
  ) {
    const request = { ...args, limit: args.limit ?? 100 };
    const single =
      name === "slack_message" ? await slackMessage(api, args) : null;
    const result =
      name === "slack_message"
        ? { messages: single ? [single] : [] }
        : await api(tool.method, request);
    const messages = objects(result.messages).filter(
      (m) => name !== "slack_message" || m.ts === args.ts,
    );
    return {
      messages: messages.map((m) =>
        messageView(m, authority.endpoint.providerAccountId!, channel),
      ),
      nextCursor: nextCursor(result),
      hasMore: result.has_more === true || !!nextCursor(result),
      sourceTrust: "untrusted",
      coverage:
        "Available Slack history only; provider retention may omit older content.",
    };
  }
  if (name === "slack_permalink")
    return {
      url: (await api(tool.method, { channel, message_ts: args.ts })).permalink,
    };
  if (
    name === "slack_file" ||
    name === "slack_read_canvas" ||
    name === "slack_list_items" ||
    name === "slack_canvas_sections"
  ) {
    const file = await authorizeSlackDocument(db, authority, api, args, false);
    if (name === "slack_canvas_sections")
      return {
        sections: (
          await api(tool.method, {
            canvas_id: args.file,
            criteria: { contains_text: args.contains_text },
          })
        ).sections,
        sourceTrust: "untrusted",
      };
    if (name === "slack_list_items") {
      const result = await api(tool.method, {
        list_id: args.file,
        cursor: args.cursor,
        limit: args.limit ?? 100,
      });
      return {
        items: result.items,
        nextCursor: nextCursor(result),
        sourceTrust: "untrusted",
      };
    }
    let content: string | null = null;
    const textual =
      typeof file.mimetype === "string" &&
      /^(text\/|application\/(json|xml|vnd\.slack-docs))/.test(file.mimetype);
    if (
      textual &&
      typeof file.url_private_download === "string" &&
      typeof file.size === "number" &&
      file.size <= 256 * 1024
    ) {
      const url = new URL(file.url_private_download);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "files.slack.com" ||
        url.username ||
        url.password ||
        url.port
      )
        throw forbidden("Unsupported Slack file download destination");
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${authority.botToken}` },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw forbidden("Slack file content is unavailable");
      }
      const reader = response.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 256 * 1024)
              throw forbidden("Slack text file exceeds the read limit");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        content = Buffer.concat(chunks).toString("utf8");
      }
    }
    return {
      file: {
        id: file.id,
        name: file.name,
        title: file.title,
        size: file.size,
        mimetype: file.mimetype,
        permalink: file.permalink,
      },
      content,
      limitation:
        content === null
          ? "Metadata only. This file type or size is not available as inline text; do not claim to have read its contents."
          : null,
      sourceTrust: "untrusted",
    };
  }
  if (name === "slack_reactions")
    return {
      reactions: object(
        (await api(tool.method, { channel, timestamp: args.ts })).message,
      ).reactions,
    };
  if (name === "slack_pins")
    return {
      pins: objects((await api(tool.method, { channel })).items).map((pin) => ({
        message: messageView(
          object(pin.message),
          authority.endpoint.providerAccountId!,
          channel,
        ),
        created: pin.created,
      })),
    };
  if (name === "slack_bookmarks")
    return {
      bookmarks: objects(
        (await api(tool.method, { channel_id: channel })).bookmarks,
      ).map((b) => ({ id: b.id, title: b.title, link: b.link })),
    };
  throw forbidden("Unsupported Slack operation");
}

/** Both native and CLI calls enter the same existing policy/approval gateway. */
export async function executeGovernedSlackTool(
  db: Db,
  binding: SlackTaskBinding,
  name: string,
  value: unknown,
) {
  const tool = SLACK_TOOLS.find((t) => t.name === name);
  if (!tool) throw forbidden("Unknown Slack tool");
  const { endpointId, ...args } = tool.schema.parse(value) as SlackObject;
  if (endpointId !== undefined) {
    if (binding.endpointId && binding.endpointId !== endpointId)
      throw forbidden("Slack connection selector does not match this task");
    binding = { ...binding, endpointId: String(endpointId) };
  }
  const authority = await resolveSlackTaskAuthority(db, binding);
  binding = { ...binding, endpointId: authority.endpoint.id };
  if (
    binding.workMode &&
    binding.workMode !== "standard" &&
    tool.risk !== "read"
  )
    throw forbidden("Slack writes require standard work mode");
  const { createToolGatewayService } = await import("../tool-gateway.js");
  const gateway = createToolGatewayService(db);
  const session = await gateway.createSession(binding);
  return gateway.executeTool({
    sessionToken: session.token,
    timeoutMs: 120_000,
    tool: `slack-bot.${authority.endpoint.id}:${name}`,
    parameters: args,
    idempotencyKey:
      typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
  });
}
