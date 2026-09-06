import type {
  ChatProviderInventoryResult,
  ChatProviderResourceInventoryItem,
} from "./chat-provider-inventory.js";

const DISCORD_API_URL = "https://discord.com/api/v10";
const REQUEST_TIMEOUT_MS = 25_000;

const PERMISSIONS = {
  addReactions: 1n << 6n,
  administrator: 1n << 3n,
  attachFiles: 1n << 15n,
  createPublicThreads: 1n << 35n,
  embedLinks: 1n << 14n,
  readMessageHistory: 1n << 16n,
  sendMessages: 1n << 11n,
  sendMessagesInThreads: 1n << 38n,
  viewChannel: 1n << 10n,
} as const;

const REQUIRED_CHANNEL_PERMISSIONS =
  PERMISSIONS.addReactions |
  PERMISSIONS.attachFiles |
  PERMISSIONS.createPublicThreads |
  PERMISSIONS.embedLinks |
  PERMISSIONS.readMessageHistory |
  PERMISSIONS.sendMessages |
  PERMISSIONS.sendMessagesInThreads |
  PERMISSIONS.viewChannel;

const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);

type DiscordUser = {
  avatar?: string | null;
  bot?: boolean;
  global_name?: string | null;
  id?: string;
  username?: string;
};

type DiscordApplication = {
  flags?: number;
  id?: string;
  name?: string;
};

type DiscordGuild = { id?: string; name?: string; owner_id?: string };
type DiscordMember = { roles?: string[]; user?: DiscordUser };
type DiscordRole = { id?: string; permissions?: string };
type DiscordOverwrite = {
  allow?: string;
  deny?: string;
  id?: string;
  type?: number;
};
type DiscordChannel = {
  id?: string;
  name?: string;
  permission_overwrites?: DiscordOverwrite[];
  position?: number;
  type?: number;
};

export interface DiscordBotIdentity {
  botAvatarUrl?: string;
  botExternalId: string;
  botLabel: string;
  botUsername: string;
  providerAccountId: string;
  providerAccountLabel: string;
}

function requestSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function snowflake(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^\d{17,20}$/.test(normalized)) {
    throw new Error(`${label} must be a Discord snowflake ID`);
  }
  return normalized;
}

function bigint(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

async function discordJson<T>(
  fetchImpl: typeof globalThis.fetch,
  token: string,
  path: string,
): Promise<T> {
  const response = await fetchImpl(`${DISCORD_API_URL}${path}`, {
    signal: requestSignal(),
    headers: { authorization: `Bot ${token}` },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Discord returned an unreadable response");
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : String(response.status);
    throw new Error(`Discord rejected the bot connection: ${message}`);
  }
  return body as T;
}

function channelPermissions(input: {
  channel: DiscordChannel;
  guildId: string;
  memberId: string;
  memberRoleIds: Set<string>;
  roles: DiscordRole[];
}): bigint {
  let permissions = 0n;
  for (const role of input.roles) {
    if (role.id === input.guildId || input.memberRoleIds.has(role.id ?? "")) {
      permissions |= bigint(role.permissions);
    }
  }
  if ((permissions & PERMISSIONS.administrator) !== 0n) return ~0n;

  const overwrites = input.channel.permission_overwrites ?? [];
  const everyone = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === input.guildId,
  );
  if (everyone) {
    permissions &= ~bigint(everyone.deny);
    permissions |= bigint(everyone.allow);
  }
  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !input.memberRoleIds.has(overwrite.id ?? ""))
      continue;
    roleDeny |= bigint(overwrite.deny);
    roleAllow |= bigint(overwrite.allow);
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;
  const member = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === input.memberId,
  );
  if (member) {
    permissions &= ~bigint(member.deny);
    permissions |= bigint(member.allow);
  }
  return permissions;
}

export async function verifyDiscordBot(input: {
  applicationId: string;
  botToken: string;
  fetch: typeof globalThis.fetch;
  guildId: string;
}): Promise<DiscordBotIdentity> {
  const applicationId = snowflake(
    input.applicationId,
    "Discord Application ID",
  );
  const guildId = snowflake(input.guildId, "Discord Server ID");
  const [user, application, guild] = await Promise.all([
    discordJson<DiscordUser>(input.fetch, input.botToken, "/users/@me"),
    discordJson<DiscordApplication>(
      input.fetch,
      input.botToken,
      "/oauth2/applications/@me",
    ),
    discordJson<DiscordGuild>(
      input.fetch,
      input.botToken,
      `/guilds/${encodeURIComponent(guildId)}`,
    ),
  ]);
  if (!user.bot || !user.id || !user.username) {
    throw new Error("Discord token does not identify a bot user");
  }
  if (application.id !== applicationId || user.id !== applicationId) {
    throw new Error(
      "Discord Application ID does not match the supplied bot token",
    );
  }
  if (((application.flags ?? 0) & MESSAGE_CONTENT_FLAGS) === 0) {
    throw new Error(
      "Discord Message Content intent is not enabled for this application",
    );
  }
  if (guild.id !== guildId) {
    throw new Error("Discord bot is not installed in the selected server");
  }
  return {
    providerAccountId: guildId,
    providerAccountLabel: guild.name ?? guildId,
    botExternalId: user.id,
    botUsername: user.username,
    botLabel: user.global_name ?? application.name ?? user.username,
    ...(user.avatar
      ? {
          botAvatarUrl: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`,
        }
      : {}),
  };
}

export async function listDiscordBotChannels(input: {
  botToken: string;
  fetch: typeof globalThis.fetch;
  guildId: string;
}): Promise<ChatProviderInventoryResult> {
  const guildId = snowflake(input.guildId, "Discord Server ID");
  const [guild, member, roles, channels] = await Promise.all([
    discordJson<DiscordGuild>(
      input.fetch,
      input.botToken,
      `/guilds/${encodeURIComponent(guildId)}`,
    ),
    discordJson<DiscordMember>(
      input.fetch,
      input.botToken,
      `/guilds/${encodeURIComponent(guildId)}/members/@me`,
    ),
    discordJson<DiscordRole[]>(
      input.fetch,
      input.botToken,
      `/guilds/${encodeURIComponent(guildId)}/roles`,
    ),
    discordJson<DiscordChannel[]>(
      input.fetch,
      input.botToken,
      `/guilds/${encodeURIComponent(guildId)}/channels`,
    ),
  ]);
  const memberId = member.user?.id;
  if (!memberId || guild.id !== guildId) {
    throw new Error("Discord bot membership could not be verified");
  }
  const memberRoleIds = new Set(member.roles ?? []);
  const resources: ChatProviderResourceInventoryItem[] = channels
    .filter((channel) => channel.type === 0 && channel.id)
    .filter((channel) => {
      const permissions = channelPermissions({
        channel,
        guildId,
        memberId,
        memberRoleIds,
        roles,
      });
      return (
        (permissions & REQUIRED_CHANNEL_PERMISSIONS) ===
        REQUIRED_CHANNEL_PERMISSIONS
      );
    })
    .sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
    .map((channel) => ({
      providerResourceId: channel.id!,
      parentProviderResourceId: guildId,
      type: "channel",
      label: channel.name ? `#${channel.name}` : channel.id!,
      providerUrl: `https://discord.com/channels/${guildId}/${channel.id}`,
      metadata: { source: "provider_inventory" },
    }));
  if (resources.length === 0) {
    throw new Error(
      "Discord bot needs View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Add Reactions, Embed Links, and Attach Files in at least one text channel",
    );
  }
  return { provider: "discord", resources };
}
