import type {
  ChatProvider,
  ChatResourceAvailability,
} from "@paperclipai/shared";

export type ChatProviderLifecycleEffect =
  | {
      kind: "resource";
      provider: ChatProvider;
      providerEventId: string;
      providerResourceId: string;
      /** Telegram basic-group id superseded by this supergroup id. */
      previousProviderResourceId?: string;
      parentProviderResourceId?: string;
      resourceType: string;
      label: string;
      providerUrl?: string;
      availability: ChatResourceAvailability;
      providerOrder?: {
        sequence?: string;
        occurredAt?: string;
      };
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "endpoint";
      provider: ChatProvider;
      providerEventId: string;
      availability: "available" | "attention" | "revoked";
      reason: string;
      providerOrder?: {
        sequence?: string;
        occurredAt?: string;
      };
      metadata?: Record<string, unknown>;
    };

export interface ParseChatProviderLifecycleInput {
  provider: ChatProvider;
  headers?: Headers | Record<string, string | undefined>;
  payload: unknown;
  /** The provider-verified bot identity stored on the endpoint. */
  botExternalId?: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return string(value);
}

function header(
  headers: ParseChatProviderLifecycleInput["headers"],
  name: string,
): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === target,
  );
  return entry ? string(entry[1]) : null;
}

function numericSequence(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const candidate = string(value);
  return candidate && /^\d+(?:\.\d+)?$/.test(candidate) ? candidate : undefined;
}

function occurredAt(value: unknown): string | undefined {
  const candidate = string(value);
  if (!candidate) return undefined;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function parseSlackLifecycle(
  input: ParseChatProviderLifecycleInput,
): ChatProviderLifecycleEffect[] {
  const payload = record(input.payload);
  if (!payload) return [];
  const envelopeId =
    string(payload.event_id) ?? string(payload.trigger_id) ?? "slack:lifecycle";
  const event = record(payload.event) ?? payload;
  const type = string(event.type);
  if (!type) return [];
  const sequence = numericSequence(event.event_ts ?? payload.event_time);
  const providerOrder = sequence ? { sequence } : undefined;

  if (type === "app_uninstalled" || type === "tokens_revoked") {
    return [
      {
        kind: "endpoint",
        provider: "slack",
        providerEventId: envelopeId,
        availability: "revoked",
        providerOrder,
        reason:
          type === "app_uninstalled"
            ? "Slack app was uninstalled"
            : "Slack app credentials were revoked",
      },
    ];
  }

  if (type === "member_joined_channel" || type === "member_left_channel") {
    const user = identifier(event.user);
    const channel = identifier(event.channel);
    if (!channel || !input.botExternalId || user !== input.botExternalId)
      return [];
    return [
      {
        kind: "resource",
        provider: "slack",
        providerEventId: envelopeId,
        providerResourceId: channel,
        resourceType: "channel",
        label: channel,
        availability:
          type === "member_joined_channel" ? "available" : "unavailable",
        providerOrder,
        metadata: {
          source: "membership_event",
          ...(string(event.channel_type)
            ? { channelType: string(event.channel_type) }
            : {}),
        },
      },
    ];
  }

  // Slack emits these bot-self events when the installed app leaves a public
  // or private channel. They are distinct from member_left_channel and do not
  // include a user field because the authenticated bot is the member that
  // left. Without them, `/remove @bot` can leave Paperclip's reach inventory
  // incorrectly available until a later manual reconciliation.
  if (type === "channel_left" || type === "group_left") {
    const channel = identifier(event.channel);
    if (!channel) return [];
    return [
      {
        kind: "resource",
        provider: "slack",
        providerEventId: envelopeId,
        providerResourceId: channel,
        resourceType: "channel",
        label: channel,
        availability: "unavailable",
        providerOrder,
        metadata: { source: type },
      },
    ];
  }

  if (
    type === "channel_archive" ||
    type === "channel_unarchive" ||
    type === "channel_deleted" ||
    type === "channel_rename"
  ) {
    const channelValue = record(event.channel);
    const channelId =
      identifier(channelValue?.id) ?? identifier(event.channel) ?? null;
    if (!channelId) return [];
    const availability: ChatResourceAvailability =
      type === "channel_deleted"
        ? "removed"
        : type === "channel_archive"
          ? "unavailable"
          : "available";
    return [
      {
        kind: "resource",
        provider: "slack",
        providerEventId: envelopeId,
        providerResourceId: channelId,
        resourceType: "channel",
        label: string(channelValue?.name) ?? channelId,
        availability,
        providerOrder,
        metadata: { source: type },
      },
    ];
  }
  return [];
}

function parseGitHubLifecycle(
  input: ParseChatProviderLifecycleInput,
): ChatProviderLifecycleEffect[] {
  const payload = record(input.payload);
  if (!payload) return [];
  const event = header(input.headers, "x-github-event");
  const delivery =
    header(input.headers, "x-github-delivery") ?? "github:lifecycle";
  const action = string(payload.action);

  if (event === "installation") {
    const installation = record(payload.installation);
    const installationId = identifier(installation?.id);
    if (action === "deleted" || action === "suspend") {
      return [
        {
          kind: "endpoint",
          provider: "github",
          providerEventId: delivery,
          availability: action === "deleted" ? "revoked" : "attention",
          reason:
            action === "deleted"
              ? "GitHub App installation was removed"
              : "GitHub App installation was suspended",
          metadata: installationId ? { installationId } : undefined,
        },
      ];
    }
    if (
      action === "created" ||
      action === "unsuspend" ||
      action === "new_permissions_accepted"
    ) {
      return [
        {
          kind: "endpoint",
          provider: "github",
          providerEventId: delivery,
          availability: "available",
          reason:
            action === "unsuspend"
              ? "GitHub App installation was unsuspended"
              : "GitHub App installation is available",
          metadata: installationId ? { installationId } : undefined,
        },
      ];
    }
    return [];
  }

  if (event !== "installation_repositories") return [];
  // A repository-selection callback is one canonical reconciliation trigger,
  // regardless of how many repositories GitHub includes in its delta. The
  // service deliberately re-reads the complete installation inventory rather
  // than trusting these callback-local additions/removals.
  return [
    {
      kind: "endpoint",
      provider: "github",
      providerEventId: delivery,
      availability: "available",
      reason: "GitHub App repository access changed",
      metadata: {
        repositoriesAdded: Array.isArray(payload.repositories_added)
          ? payload.repositories_added.length
          : 0,
        repositoriesRemoved: Array.isArray(payload.repositories_removed)
          ? payload.repositories_removed.length
          : 0,
      },
    },
  ];
}

function teamsResourceType(payload: Record<string, unknown>): string {
  const conversation = record(payload.conversation);
  const conversationType = string(conversation?.conversationType)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  if (conversationType === "personal") return "direct_message";
  if (conversationType === "group" || conversationType === "groupchat")
    return "group_chat";
  if (conversationType === "channel") return "channel";
  if (conversation?.isGroup === false) return "direct_message";
  const channelData = record(payload.channelData);
  if (record(channelData?.team) || record(channelData?.channel))
    return "channel";
  return "group_chat";
}

function teamsBotIdentityMatches(
  botExternalId: string,
  memberId: unknown,
): boolean {
  const canonical = (value: unknown): string | null => {
    const id = identifier(value)?.toLowerCase();
    return id?.replace(/^28:/, "") ?? null;
  };
  const expected = canonical(botExternalId);
  return expected !== null && canonical(memberId) === expected;
}

function teamsResourceId(payload: Record<string, unknown>): string | null {
  const conversation = record(payload.conversation);
  const channelData = record(payload.channelData);
  const channel = record(channelData?.channel);
  // Teams root replies append `;messageid=...` to the Bot Framework
  // conversation id. Use its stable base as the access-control resource so
  // installation events and later message ingress address the same row.
  const conversationId = identifier(conversation?.id);
  return (
    conversationId?.replace(/;messageid=[^;]+/i, "") ?? identifier(channel?.id)
  );
}

function teamsResourceLabel(
  payload: Record<string, unknown>,
  fallback: string,
): string {
  const conversation = record(payload.conversation);
  const channelData = record(payload.channelData);
  const channel = record(channelData?.channel);
  const team = record(channelData?.team);
  return (
    string(channel?.name) ??
    string(conversation?.name) ??
    string(team?.name) ??
    fallback
  );
}

function parseTeamsLifecycle(
  input: ParseChatProviderLifecycleInput,
): ChatProviderLifecycleEffect[] {
  const payload = record(input.payload);
  if (!payload) return [];
  const type = string(payload.type);
  const eventId = identifier(payload.id) ?? "teams:lifecycle";
  const eventOccurredAt = occurredAt(payload.timestamp);
  const providerOrder = eventOccurredAt
    ? { occurredAt: eventOccurredAt }
    : undefined;
  const resourceId = teamsResourceId(payload);
  if (!resourceId) return [];

  if (type === "installationUpdate") {
    const action = string(payload.action)?.toLowerCase();
    if (
      !["add", "add-upgrade", "remove", "remove-upgrade"].includes(action ?? "")
    )
      return [];
    const channelData = record(payload.channelData);
    const team = record(channelData?.team);
    return [
      {
        kind: "resource",
        provider: "microsoft-teams",
        providerEventId: eventId,
        providerResourceId: resourceId,
        parentProviderResourceId: identifier(team?.id) ?? undefined,
        resourceType: teamsResourceType(payload),
        label: teamsResourceLabel(payload, resourceId),
        availability: action?.startsWith("remove") ? "removed" : "available",
        providerOrder,
        metadata: { source: "installation_update", action },
      },
    ];
  }

  if (type === "conversationUpdate" && input.botExternalId) {
    const added = Array.isArray(payload.membersAdded)
      ? payload.membersAdded.map(record).filter(Boolean)
      : [];
    const removed = Array.isArray(payload.membersRemoved)
      ? payload.membersRemoved.map(record).filter(Boolean)
      : [];
    const joined = added.some((member) =>
      teamsBotIdentityMatches(input.botExternalId!, member?.id),
    );
    const left = removed.some((member) =>
      teamsBotIdentityMatches(input.botExternalId!, member?.id),
    );
    if (!joined && !left) return [];
    return [
      {
        kind: "resource",
        provider: "microsoft-teams",
        providerEventId: eventId,
        providerResourceId: resourceId,
        resourceType: teamsResourceType(payload),
        label: teamsResourceLabel(payload, resourceId),
        availability: left ? "unavailable" : "available",
        providerOrder,
        metadata: { source: "conversation_membership" },
      },
    ];
  }
  return [];
}

function parseTelegramLifecycle(
  input: ParseChatProviderLifecycleInput,
): ChatProviderLifecycleEffect[] {
  const payload = record(input.payload);
  const migrationMessage =
    record(payload?.message) ?? record(payload?.channel_post);
  const migrationChat = record(migrationMessage?.chat);
  const migrationChatId = identifier(migrationChat?.id);
  const migrateToChatId = identifier(migrationMessage?.migrate_to_chat_id);
  const migrateFromChatId = identifier(migrationMessage?.migrate_from_chat_id);
  const migrationFromId = migrateToChatId ? migrationChatId : migrateFromChatId;
  const migrationToId =
    migrateToChatId ?? (migrateFromChatId ? migrationChatId : null);
  if (
    payload &&
    migrationMessage &&
    migrationChat &&
    migrationFromId &&
    migrationToId
  ) {
    const title =
      string(migrationChat.title) ??
      [string(migrationChat.first_name), string(migrationChat.last_name)]
        .filter(Boolean)
        .join(" ") ??
      string(migrationChat.username) ??
      migrationToId;
    const updateId = numericSequence(payload.update_id);
    return [
      {
        kind: "resource",
        provider: "telegram",
        providerEventId: `telegram:${identifier(payload.update_id) ?? "migration"}`,
        providerResourceId: migrationToId,
        previousProviderResourceId: migrationFromId,
        resourceType: "chat",
        label: title || migrationToId,
        availability: "available",
        providerOrder: updateId ? { sequence: updateId } : undefined,
        metadata: {
          source: "chat_migration",
          migratedFrom: migrationFromId,
          migratedTo: migrationToId,
        },
      },
    ];
  }
  const membership = record(payload?.my_chat_member);
  const chat = record(membership?.chat);
  const member = record(membership?.new_chat_member);
  const chatId = identifier(chat?.id);
  const status = string(member?.status);
  const updateId = numericSequence(payload?.update_id);
  if (!payload || !membership || !chat || !member || !chatId || !status)
    return [];
  const available =
    status === "member" ||
    status === "administrator" ||
    (status === "restricted" && member.is_member === true);
  const unavailable =
    status === "left" || status === "kicked" || status === "restricted";
  if (!available && !unavailable) return [];
  const title =
    string(chat.title) ??
    [string(chat.first_name), string(chat.last_name)]
      .filter(Boolean)
      .join(" ") ??
    string(chat.username) ??
    chatId;
  return [
    {
      kind: "resource",
      provider: "telegram",
      providerEventId: `telegram:${identifier(payload.update_id) ?? "lifecycle"}`,
      providerResourceId: chatId,
      resourceType: string(chat.type) === "private" ? "direct_message" : "chat",
      label: title || chatId,
      availability: available ? "available" : "unavailable",
      providerOrder: updateId ? { sequence: updateId } : undefined,
      metadata: { source: "my_chat_member", memberStatus: status },
    },
  ];
}

/**
 * Parse provider installation and membership events only after the native
 * adapter has verified the webhook. The returned effects contain no provider
 * credentials and are safe to persist in Paperclip's lifecycle ledger.
 */
export function parseChatProviderLifecycle(
  input: ParseChatProviderLifecycleInput,
): ChatProviderLifecycleEffect[] {
  switch (input.provider) {
    case "slack":
      return parseSlackLifecycle(input);
    case "github":
      return parseGitHubLifecycle(input);
    case "microsoft-teams":
      return parseTeamsLifecycle(input);
    case "telegram":
      return parseTelegramLifecycle(input);
  }
}
