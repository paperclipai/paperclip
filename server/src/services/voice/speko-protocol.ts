import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { respondIssueThreadInteractionSchema } from "@paperclipai/shared";

export const SPEKO_CALLBACK_LIMIT = 64 * 1024;
export const SPEKO_CALLBACK_TOLERANCE_SECONDS = 300;
const id = z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/);
const common = { session_id: id, tool_call_id: id, idempotency_key: z.string().max(401) };
export const spekoToolEnvelopeSchema = z.discriminatedUnion("tool", [
  z.object({ ...common, tool: z.literal("submit_request"), args: z.object({ text: z.string().trim().min(1).max(16_000) }).strict() }),
  z.object({ ...common, tool: z.literal("answer_question"), args: respondIssueThreadInteractionSchema.pick({ answers: true }).extend({ interactionId: z.string().uuid() }).strict() }),
  z.object({ ...common, tool: z.literal("get_updates"), args: z.object({ cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), repeat: z.boolean().optional() }).strict() }),
]).refine((v) => v.idempotency_key === `${v.session_id}:${v.tool_call_id}`, "Invalid tool identity");
export type SpekoToolEnvelope = z.infer<typeof spekoToolEnvelopeSchema>;
export interface SpekoSigningKey {
  secret: string;
  /** Old keys must have an explicit grace deadline. Do not retain them indefinitely. */
  validUntil?: Date;
}
export class SpekoProtocolError extends Error {
  constructor(readonly code: "body_too_large" | "invalid_signature" | "invalid_envelope") { super(code); }
}

/** Standard Webhooks verification over the ORIGINAL body; no parsed-body fallback. */
export function verifySpekoSignature(input: {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  keys: readonly SpekoSigningKey[];
  now?: number;
}): { webhookId: string } {
  if (input.body.length > SPEKO_CALLBACK_LIMIT) throw new SpekoProtocolError("body_too_large");
  const webhookId = input.headers["webhook-id"], timestamp = input.headers["webhook-timestamp"], signatures = input.headers["webhook-signature"];
  const now = input.now ?? Date.now();
  if (typeof webhookId !== "string" || !/^[A-Za-z0-9_:-]{1,401}$/.test(webhookId)
    || typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp)
    || Math.abs(now / 1000 - Number(timestamp)) > SPEKO_CALLBACK_TOLERANCE_SECONDS
    || typeof signatures !== "string" || signatures.length > 4096) throw new SpekoProtocolError("invalid_signature");
  const candidates = signatures.split(" ").filter((v) => /^v1,[A-Za-z0-9+/]{43}=$/.test(v)).map((v) => Buffer.from(v.slice(3), "base64"));
  let valid = false;
  for (const key of input.keys) {
    if (key.validUntil && key.validUntil.getTime() <= now || !/^whsec_[A-Za-z0-9+/]{43}=$/.test(key.secret)) continue;
    const expected = createHmac("sha256", Buffer.from(key.secret.slice(6), "base64")).update(`${webhookId}.${timestamp}.`).update(input.body).digest();
    for (const candidate of candidates) valid = timingSafeEqual(expected, candidate) || valid;
  }
  if (!valid) throw new SpekoProtocolError("invalid_signature");
  return { webhookId };
}
export function verifySpekoToolRequest(input: Parameters<typeof verifySpekoSignature>[0]): { envelope: SpekoToolEnvelope; webhookId: string; fingerprint: string } {
  const { webhookId } = verifySpekoSignature(input);
  let envelope: SpekoToolEnvelope;
  try { envelope = spekoToolEnvelopeSchema.parse(JSON.parse(input.body.toString("utf8"))); }
  catch { throw new SpekoProtocolError("invalid_envelope"); }
  const fingerprint = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
  return { envelope, webhookId, fingerprint };
}

export function spekoToolDefinitions(callbackUrl: string) {
  const url = new URL(callbackUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("Speko requires an explicit public HTTPS callback URL");
  const source = { kind: "webhook" as const, url: url.href, method: "POST" as const, responseMode: "sync" as const, timeoutMs: 3500, headers: { authorization: "Bearer {{paperclip_session_token}}" } };
  return [
    { name: "submit_request", description: "Delegate work, factual questions, corrections, and follow-up instructions to the assigned Paperclip agent on this task. Include the caller’s words and any clarified details. Submit once per new request, including while prior work runs. The agent has its own tools and execution environment: delegate questions about its computer, files, disk space, or capabilities. You may handle greetings, quick acknowledgments and clarification immediately without this tool. Acceptance means saved, not completed. Approved phone answers are pushed into the live call; get_updates can inspect status or repeat a delivered answer.", parameters: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 16000 } }, required: ["text"], additionalProperties: false }, source },
    { name: "answer_question", description: "Answer the exact pending question returned by get_updates, using its question and option IDs. Ask for clarification if the answer is ambiguous. Cannot approve actions.", parameters: { type: "object", properties: { interactionId: { type: "string", format: "uuid" }, answers: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { questionId: { type: "string" }, optionIds: { type: "array", items: { type: "string" } }, otherText: { type: "string", maxLength: 16000 } }, required: ["questionId", "optionIds"], additionalProperties: false } } }, required: ["interactionId", "answers"], additionalProperties: false }, source },
    { name: "get_updates", description: "Retrieve the assigned Paperclip agent’s approved answers for this live call. Use cursor=0 initially and then the returned cursor. Approved telephone answers are pushed into the live call automatically. Use this tool for a caller-requested status check, permitted task questions, or an explicit repeat; do not continuously poll for completion. Empty updates means pending, not finished. Read each returned answer once. Set repeat=true only when the caller explicitly asks to hear the last delivered answer again. The work state distinguishes queueing, execution, and awaiting publication; it is not an answer or proof of completion.", parameters: { type: "object", properties: { cursor: { type: "integer", minimum: 0 }, repeat: { type: "boolean", description: "Explicit caller request to repeat the last delivered answer" } }, required: ["cursor"], additionalProperties: false }, source },
  ];
}
