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
      parentProviderResourceId?: string;
      resourceType: string;
      label: string;
      providerUrl?: string;
      availability: ChatResourceAvailability;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "endpoint";
      provider: ChatProvider;
      providerEventId: string;
      availability: "available" | "attention" | "revoked";
      reason: string;
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

function githubRepositoryEffect(input: {
  eventId: string;
  repository: unknown;
  availability: ChatResourceAvailability;
}): ChatProviderLifecycleEffect | null {
  const repository = record(input.repository);
  if (!repository) return null;
  const repositoryId = identifier(repository.id);
  if (!repositoryId) return null;
  const fullName = string(repository.full_name);
  const name =
    fullName ?? string(repository.name) ?? `Repository ${repositoryId}`;
  const owner = record(repository.owner);
  return {
    kind: "resource",
    provider: "github",
    providerEventId: input.eventId,
    providerResourceId: repositoryId,
    resourceType: "repository",
    label: name,
    providerUrl:
      string(repository.html_url) ??
      (fullName ? `https://github.com/${fullName}` : undefined),
    availability: input.availability,
    metadata: {
      ...(fullName ? { fullName } : {}),
      ...(identifier(owner?.id) ? { ownerId: identifier(owner?.id) } : {}),
    },
  };
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

  if (type === "app_uninstalled" || type === "tokens_revoked") {
    return [
      {
        kind: "endpoint",
        provider: "slack",
        providerEventId: envelopeId,
        availability: "revoked",
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
        metadata: {
          source: "membership_event",
          ...(string(event.channel_type)
            ? { channelType: string(event.channel_type) }
            : {}),
        },
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
  const effects: ChatProviderLifecycleEffect[] = [];
  for (const repository of Array.isArray(payload.repositories_added)
    ? payload.repositories_added
    : []) {
    const effect = githubRepositoryEffect({
      eventId: `${delivery}:added:${effects.length}`,
      repository,
      availability: "available",
    });
    if (effect) effects.push(effect);
  }
  const removed = Array.isArray(payload.repositories_removed)
    ? payload.repositories_removed
    : [];
  for (const repository of removed) {
    const effect = githubRepositoryEffect({
      eventId: `${delivery}:removed:${effects.length}`,
      repository,
      availability: "removed",
    });
    if (effect) effects.push(effect);
  }
  return effects;
}

function teamsResourceType(payload: Record<string, unknown>): string {
  const conversation = record(payload.conversation);
  if (conversation?.isGroup === false) return "direct_message";
  const channelData = record(payload.channelData);
  if (record(channelData?.team) || record(channelData?.channel))
    return "channel";
  return "group_chat";
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
    const joined = added.some(
      (member) => identifier(member?.id) === input.botExternalId,
    );
    const left = removed.some(
      (member) => identifier(member?.id) === input.botExternalId,
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
  const membership = record(payload?.my_chat_member);
  const chat = record(membership?.chat);
  const member = record(membership?.new_chat_member);
  const chatId = identifier(chat?.id);
  const status = string(member?.status);
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
