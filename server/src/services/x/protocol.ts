import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import twitterText from "twitter-text";
import { unprocessable } from "../../errors.js";

export const xId = z.string().regex(/^[1-9][0-9]{0,24}$/);
export const xPost = z
  .object({
    id: xId,
    text: z.string(),
    author_id: xId,
    conversation_id: xId.optional(),
    created_at: z.string().optional(),
    in_reply_to_tweet_id: xId.optional(),
    referenced_tweets: z
      .array(z.object({ type: z.string(), id: xId }))
      .optional(),
  })
  .passthrough();
export const xEvent = z.object({
  event_type: z.enum(["post.mention.create", "post.reply.create"]),
  event_uuid: z.string().optional(),
  filter: z.object({ user_id: xId }),
  payload: xPost,
  includes: z
    .object({
      users: z
        .array(
          z.object({
            id: xId,
            name: z.string().optional(),
            username: z.string().optional(),
          }),
        )
        .optional(),
      tweets: z.array(xPost).optional(),
    })
    .optional(),
});
export type XPost = z.infer<typeof xPost>;
export type XEvent = z.infer<typeof xEvent>;
export const X_SIGNATURE_HEADER = "x-twitter-webhooks-signature-oauth2";
export const xSignature = (body: Uint8Array | string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("base64")}`;
export function verifyXSignature(
  body: Uint8Array,
  signature: string | null,
  secret: string,
) {
  if (!secret || !signature || !/^sha256=[A-Za-z0-9+/]{43}=$/.test(signature))
    return false;
  const expected = Buffer.from(xSignature(body, secret));
  const supplied = Buffer.from(signature);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
export function xChallenge(request: Request, secret: string) {
  if (!secret) return new Response("X app is not configured", { status: 503 });
  const token = new URL(request.url).searchParams.get("crc_token");
  // A CRC is an opaque token, never a JSON message signing oracle.
  if (!token || !/^[A-Za-z0-9+/=_-]{1,256}$/.test(token))
    return new Response("Invalid crc_token", { status: 400 });
  return Response.json(
    { response_token: xSignature(token, secret) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
export function xEvents(value: unknown, botId: string): XEvent[] {
  const data = (value as { data?: unknown } | null)?.data;
  return (Array.isArray(data) ? data : [data]).flatMap((raw) => {
    const parsed = xEvent.safeParse(raw);
    return parsed.success &&
      parsed.data.filter.user_id === botId &&
      parsed.data.payload.author_id !== botId
      ? [parsed.data]
      : [];
  });
}
export function xParent(post: XPost) {
  return (
    post.in_reply_to_tweet_id ??
    post.referenced_tweets?.find((ref) => ref.type === "replied_to")?.id
  );
}
export function xControl(text: string, username: string | null) {
  if (!username) return null;
  const match = /^@([A-Za-z0-9_]+)\s+(stop|start)\s*$/i.exec(text.trim());
  return match?.[1].toLowerCase() === username.toLowerCase()
    ? (match[2].toLowerCase() as "stop" | "start")
    : null;
}
export function validateXReply(text: string) {
  const count = twitterText.parseTweet(text);
  if (!count.valid)
    throw unprocessable(
      `X reply is invalid (${count.weightedLength}/280 weighted characters). Write one shorter reply and call x_reply again; text is never truncated or split.`,
    );
}
