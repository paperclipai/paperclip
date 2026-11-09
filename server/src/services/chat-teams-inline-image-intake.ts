import type { Attachment, Message } from "chat";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";

const opaque = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\x00-\x20\x7f]+$/);
const mime = z.enum(["image/png", "image/jpeg", "image/gif"]);
const scopeSchema = z
  .object({
    companyId: z.uuid(),
    endpointId: z.uuid(),
    tenantId: z.uuid(),
    botAppId: z.uuid(),
    runtimeGeneration: z.number().int().min(0).max(2_147_483_647),
    credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    threadId: z.string().min(1).max(8192),
    messageId: opaque,
    principalExternalId: z.uuid(),
  })
  .strict();
const locatorSchema = scopeSchema
  .extend({
    kind: z.literal("teams_inline_image"),
    hostname: z
      .string()
      .min(1)
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    region: z
      .string()
      .max(128)
      .regex(/^(?:[a-z0-9][a-z0-9._-]{0,127})?$/),
    attachmentId: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/),
    view: z.enum(["original", "imgo"]),
    mimeType: mime,
    providerUserId: opaque,
  })
  .strict();

export type TeamsInlineImageScope = z.infer<typeof scopeSchema>;
export type TeamsInlineImageLocator = z.infer<typeof locatorSchema>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function officialHost(hostname: string): boolean {
  return [
    "botframework.com",
    "smba.trafficmanager.net",
    "teams.microsoft.com",
    "teams.microsoft.us",
  ].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function canonicalThread(value: string): string | null {
  const parts = value.split(":");
  if (parts[0] !== "teams" || parts.length < 2 || parts.length > 4) return null;
  if (parts.slice(2).includes("personal")) return null;
  const bytes = Buffer.from(parts[1]!, "base64url");
  if (
    bytes.toString("base64url") !== parts[1] ||
    !Buffer.from(bytes.toString("utf8")).equals(bytes) ||
    !opaque.safeParse(bytes.toString("utf8")).success
  )
    return null;
  return `teams:${parts[1]}`;
}

function route(contentUrl: unknown, serviceUrl: unknown) {
  if (
    typeof contentUrl !== "string" ||
    typeof serviceUrl !== "string" ||
    contentUrl.length > 4096 ||
    serviceUrl.length > 2048 ||
    /[\s%\\]/.test(contentUrl + serviceUrl)
  )
    return null;
  try {
    const content = new URL(contentUrl);
    const service = new URL(serviceUrl);
    if (content.toString() !== contentUrl || service.toString() !== serviceUrl)
      return null;
    for (const url of [content, service]) {
      if (
        url.protocol !== "https:" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !officialHost(url.hostname)
      )
        return null;
    }
    if (
      content.origin !== service.origin ||
      !/^\/(?:[a-z0-9][a-z0-9._-]{0,127}\/?|)$/i.test(service.pathname)
    )
      return null;
    const path =
      /^\/(?:(?<region>[a-z0-9][a-z0-9._-]{0,127})\/)?v3\/attachments\/(?<id>[A-Za-z0-9_-]{1,1024})\/views\/(?<view>original|imgo)$/.exec(
        content.pathname,
      );
    if (!path?.groups) return null;
    const region = path.groups.region ?? "";
    if (region && `/${region}` !== service.pathname.replace(/\/$/, ""))
      return null;
    return {
      hostname: content.hostname,
      region,
      attachmentId: path.groups.id!,
      view: path.groups.view!,
    };
  } catch {
    return null;
  }
}

/** Pure source validation, not JWT authentication or current DB authorization.
 * Only call with an original runtime-authenticated activity and independently
 * selected endpoint/delivery scope. Adapter fetchMetadata grants no authority.
 */
export function deriveTeamsInlineImageLocator(
  message: Message,
  attachment: Attachment,
  scope: TeamsInlineImageScope,
): TeamsInlineImageLocator | null {
  const expected = scopeSchema.safeParse(scope);
  const raw = record(message.raw);
  if (!expected.success || !raw || !message.attachments.includes(attachment))
    return null;
  const conversation = record(raw.conversation);
  const from = record(raw.from);
  const recipient = record(raw.recipient);
  const tenant = record(record(raw.channelData)?.tenant);
  const tenantId = conversation?.tenantId ?? tenant?.id;
  const threadId = canonicalThread(scope.threadId);
  if (
    raw.type !== "message" ||
    raw.channelId !== "msteams" ||
    !["channel", "groupChat"].includes(
      String(conversation?.conversationType),
    ) ||
    raw.id !== message.id ||
    message.id !== scope.messageId ||
    !opaque.safeParse(conversation?.id).success ||
    threadId !==
      `teams:${Buffer.from(conversation!.id as string).toString("base64url")}` ||
    canonicalThread(message.threadId) !== threadId ||
    tenantId !== scope.tenantId ||
    (tenant?.id !== undefined && tenant.id !== tenantId) ||
    recipient?.id !== `28:${scope.botAppId}` ||
    recipient.isTargeted === true ||
    !opaque.safeParse(from?.id).success ||
    from?.aadObjectId !== scope.principalExternalId ||
    from?.id !== message.author.userId ||
    from?.id === recipient.id ||
    message.author.isBot ||
    message.author.isMe ||
    message.author.isSystem ||
    !mime.safeParse(attachment.mimeType).success ||
    attachment.type !== "image" ||
    (attachment.size !== undefined &&
      (!Number.isSafeInteger(attachment.size) ||
        attachment.size < 0 ||
        attachment.size > MAX_ATTACHMENT_BYTES))
  )
    return null;
  const matching = Array.isArray(raw.attachments)
    ? raw.attachments.filter((value) => {
        const a = record(value);
        return (
          a &&
          a.contentType === attachment.mimeType &&
          a.contentUrl === attachment.url &&
          a.name === attachment.name &&
          a.content === undefined
        );
      })
    : [];
  if (matching.length !== 1) return null;
  const source = record(matching[0])!;
  const parsedRoute = route(source.contentUrl, raw.serviceUrl);
  if (!parsedRoute) return null;
  return parseTeamsInlineImageLocator(
    {
      ...scope,
      threadId,
      ...parsedRoute,
      kind: "teams_inline_image",
      mimeType: attachment.mimeType,
      providerUserId: from!.id,
    },
    scope,
  );
}

/** Rehydration compares immutable evidence to independent current endpoint and
 * retained delivery-origin fields. A copied locator is never a credential.
 */
export function parseTeamsInlineImageLocator(
  value: unknown,
  scope: TeamsInlineImageScope,
): TeamsInlineImageLocator | null {
  const expected = scopeSchema.safeParse(scope);
  const parsed = locatorSchema.safeParse(value);
  if (
    !expected.success ||
    !parsed.success ||
    !officialHost(parsed.data.hostname)
  )
    return null;
  for (const key of Object.keys(
    scopeSchema.shape,
  ) as (keyof TeamsInlineImageScope)[]) {
    if (
      parsed.data[key] !==
      (key === "threadId" ? canonicalThread(scope.threadId) : scope[key])
    )
      return null;
  }
  return parsed.data;
}

/** Construct only the closed Bot Connector attachment-resource route. */
export function teamsInlineImageDownloadUrl(
  locator: TeamsInlineImageLocator,
): string {
  return `https://${locator.hostname}${locator.region ? `/${locator.region}` : ""}/v3/attachments/${locator.attachmentId}/views/${locator.view}`;
}
