import { z } from "zod";
import { guardedRemoteHttpFetch } from "../remote-http-fetch.js";

const wakeReferences = {
  schema: z.literal("paperclip.external_bot_wake.v1"),
  bindingId: z.uuid(),
  bindingGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  correlationId: z.uuid(),
};
const wakeSchema = z.discriminatedUnion("kind", [
  z.object({ ...wakeReferences, kind: z.literal("verify"), challenge: z.string().min(20).max(100) }).strict(),
  z.object({ ...wakeReferences, kind: z.literal("mailbox_updated"), after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ ...wakeReferences, kind: z.literal("authority_revoked"), assignmentId: z.uuid() }).strict(),
]);

export type GrokRoutineWake = z.infer<typeof wakeSchema>;
export interface GrokRoutineCredential { webhookUrl: string; webhookKey: string }
export interface GrokRoutineDelivery {
  delivery: "accepted" | "rejected" | "unknown";
  httpStatus: number | null;
}
type RoutineFetch = (url: string, init: RequestInit) => Promise<Response>;

/** URL/key are one encrypted secret version. Neither belongs in the wake payload. */
export function validateGrokRoutineCredential(value: GrokRoutineCredential): GrokRoutineCredential {
  if (!value || typeof value.webhookUrl !== "string" || typeof value.webhookKey !== "string") throw new Error("Invalid Grok routine credential");
  let url: URL;
  try { url = new URL(value.webhookUrl); } catch { throw new Error("Invalid Grok routine credential"); }
  if (value.webhookUrl.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.hash || url.search
    || !/^[\x21-\x7e]{1,16384}$/.test(value.webhookKey)) {
    throw new Error("Invalid Grok routine credential");
  }
  return { webhookUrl: url.toString(), webhookKey: value.webhookKey };
}

const routineFetch: RoutineFetch = (url, init) => guardedRemoteHttpFetch(url, init, {
  allowPrivateNetwork: false, connectTimeoutMs: 5000, responseTimeoutMs: 10_000,
  error: () => new Error("Grok routine destination is unavailable"),
});

/**
 * Call only after a durable dispatch intent has been reserved and authority
 * rechecked. This transport sends once: uncertainty must be reconciled by the
 * caller, never retried here. HTTP acceptance does not prove an MCP reply,
 * agent readiness, work acceptance, completion, or remote termination.
 */
export async function deliverGrokRoutineWake(
  secret: GrokRoutineCredential,
  wake: GrokRoutineWake,
  fetcher: RoutineFetch = routineFetch,
): Promise<GrokRoutineDelivery> {
  let destination: GrokRoutineCredential;
  let body: string;
  try {
    destination = validateGrokRoutineCredential(secret);
    body = JSON.stringify(wakeSchema.parse(wake));
    if (Buffer.byteLength(body) > 4096) throw new Error("Grok wake exceeds reference limit");
  } catch {
    return { delivery: "rejected", httpStatus: null };
  }
  try {
    const response = await fetcher(destination.webhookUrl, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${destination.webhookKey}`, "Content-Type": "application/json" }, body,
    });
    // The provider documents 200 as receipt/start, not completed execution.
    // A proxy timeout or server error can occur after processing the request.
    const delivery = response.status === 200 ? "accepted"
      : response.status >= 400 && response.status < 500 && response.status !== 408 ? "rejected" : "unknown";
    // A response body is not an execution receipt and may contain secrets.
    await response.body?.cancel().catch(() => {});
    return { delivery, httpStatus: response.status };
  } catch {
    // Transport errors can contain the full URL/key. Return no exception text.
    return { delivery: "unknown", httpStatus: null };
  }
}
