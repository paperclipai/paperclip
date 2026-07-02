import crypto from "node:crypto";

const seenWebhookIds = new Map<string, number>();
const WEBHOOK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

function pruneWebhookDedupe(now: number) {
  for (const [id, expiresAt] of seenWebhookIds) {
    if (expiresAt <= now) seenWebhookIds.delete(id);
  }
}

export function verifyCursorWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  if (!input.signatureHeader?.trim()) return false;
  const expected = crypto
    .createHmac("sha256", input.secret)
    .update(input.rawBody, "utf8")
    .digest("hex");
  const provided = input.signatureHeader.replace(/^sha256=/, "").trim();
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

export function dedupeCursorWebhook(webhookId: string | undefined): boolean {
  if (!webhookId?.trim()) return false;
  const now = Date.now();
  pruneWebhookDedupe(now);
  if (seenWebhookIds.has(webhookId)) return true;
  seenWebhookIds.set(webhookId, now + WEBHOOK_DEDUPE_TTL_MS);
  return false;
}

export type CursorWebhookV0Payload = {
  id?: string;
  type?: string;
  agentId?: string;
  runId?: string;
  status?: string;
  git?: unknown;
};

export function normalizeCursorWebhookPayload(body: unknown): CursorWebhookV0Payload | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    type: typeof record.type === "string" ? record.type : undefined,
    agentId: typeof record.agentId === "string" ? record.agentId : undefined,
    runId: typeof record.runId === "string" ? record.runId : undefined,
    status: typeof record.status === "string" ? record.status : undefined,
    git: record.git,
  };
}
