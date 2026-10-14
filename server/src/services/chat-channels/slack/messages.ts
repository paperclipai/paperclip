import { createHash } from "node:crypto";


export function slackLifecycleFilesDigest(raw: unknown): string {
  const files =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).files
      : undefined;
  // Match the pinned Slack adapter's content-change projection. Transport
  // locators/unfurls are not content identity and must never enter durable keys.
  const projection = Array.isArray(files)
    ? files.map((file) => {
        const row =
          file && typeof file === "object" && !Array.isArray(file)
            ? (file as Record<string, unknown>)
            : {};
        return [
          ...["id", "name", "mimetype"].map((key) =>
            typeof row[key] === "string" ? row[key] : null,
          ),
          ...["size", "original_w", "original_h"].map((key) =>
            typeof row[key] === "number" && Number.isFinite(row[key])
              ? row[key]
              : null,
          ),
        ];
      })
    : [];
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

export function slackMessageSentAt(raw: unknown, messageId: string): Date | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ts = (raw as { ts?: unknown }).ts;
  if (
    ts !== messageId ||
    typeof ts !== "string" ||
    !/^[1-9][0-9]{0,12}\.[0-9]{6}$/.test(ts)
  )
    return null;
  const date = new Date(Number(ts) * 1_000);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function isSlackReceiptReactionAlreadyApplied(error: unknown): boolean {
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value: error },
  ];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (
      !current ||
      current.depth > 4 ||
      !current.value ||
      typeof current.value !== "object" ||
      seen.has(current.value)
    ) {
      continue;
    }
    seen.add(current.value);
    const record = current.value as {
      cause?: unknown;
      code?: unknown;
      data?: { error?: unknown };
      original?: unknown;
      originalError?: unknown;
    };
    if (
      record.code === "already_reacted" ||
      record.data?.error === "already_reacted"
    ) {
      return true;
    }
    for (const value of [record.cause, record.original, record.originalError]) {
      pending.push({ depth: current.depth + 1, value });
    }
  }
  return false;
}

export function slackThreadChannelId(threadId: string): string | null {
  if (!threadId.startsWith("slack:")) return null;
  const channelAndThread = threadId.slice("slack:".length);
  const separator = channelAndThread.indexOf(":");
  const channelId =
    separator === -1 ? channelAndThread : channelAndThread.slice(0, separator);
  return channelId || null;
}
