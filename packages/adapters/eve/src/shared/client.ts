import type { EveStreamEvent } from "./events.js";

/**
 * Thrown when Eve rejects a follow-up because the continuation token is
 * stale or the session is unknown. Callers should fall back to starting a
 * fresh session.
 */
export class EveStaleSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EveStaleSessionError";
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function buildHeaders(
  configured: Record<string, string>,
  includeContentType = true,
): Record<string, string> {
  // Content-Type describes a request body (RFC 7231); omit it on GETs.
  return includeContentType
    ? { "content-type": "application/json", ...configured }
    : { ...configured };
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function readBodySafe(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function startSession(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  message: string;
  timeoutMs: number;
}): Promise<{ sessionId: string; continuationToken: string | null }> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/eve/v1/session`,
    {
      method: "POST",
      headers: buildHeaders(opts.headers),
      body: JSON.stringify({ message: opts.message }),
    },
    opts.timeoutMs,
  );
  const body = await readBodySafe(res);
  if (!res.ok) {
    throw new Error(`Eve session start failed: HTTP ${res.status} ${truncate(body)}`);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Fall through to header fallback.
  }
  const sessionId = readString(parsed.sessionId) ?? readString(res.headers.get("x-eve-session-id"));
  if (!sessionId) {
    throw new Error(`Eve session start response did not include a sessionId: ${truncate(body)}`);
  }
  return {
    sessionId,
    continuationToken: readString(parsed.continuationToken),
  };
}

export async function sendFollowUp(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  continuationToken: string | null;
  message: string;
  timeoutMs: number;
}): Promise<{ continuationToken: string | null }> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/eve/v1/session/${encodeURIComponent(opts.sessionId)}`,
    {
      method: "POST",
      headers: buildHeaders(opts.headers),
      body: JSON.stringify({
        ...(opts.continuationToken ? { continuationToken: opts.continuationToken } : {}),
        message: opts.message,
      }),
    },
    opts.timeoutMs,
  );
  const body = await readBodySafe(res);
  if (!res.ok) {
    const message = `Eve follow-up failed: HTTP ${res.status} ${truncate(body)}`;
    if (res.status >= 400 && res.status < 500) {
      const lower = body.toLowerCase();
      const looksStale =
        res.status === 404 ||
        res.status === 409 ||
        res.status === 410 ||
        lower.includes("continuation") ||
        lower.includes("stale") ||
        lower.includes("unknown session") ||
        lower.includes("session not found");
      if (looksStale) throw new EveStaleSessionError(message);
    }
    throw new Error(message);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Response body may be empty; keep using the stored token.
  }
  return { continuationToken: readString(parsed.continuationToken) };
}

export async function streamSession(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  sessionId: string;
  startIndex?: number;
  signal: AbortSignal;
  onEvent: (event: EveStreamEvent, rawLine: string) => Promise<void>;
}): Promise<{ skippedLines: number }> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const startIndex = typeof opts.startIndex === "number" && opts.startIndex > 0 ? opts.startIndex : 0;
  const url = `${baseUrl}/eve/v1/session/${encodeURIComponent(opts.sessionId)}/stream${
    startIndex > 0 ? `?startIndex=${startIndex}` : ""
  }`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(opts.headers, false),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await readBodySafe(res);
    throw new Error(`Eve stream failed: HTTP ${res.status} ${truncate(body)}`);
  }
  if (!res.body) return { skippedLines: 0 };

  let skippedLines = 0;
  let buffer = "";
  const decoder = new TextDecoder();

  const handleLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: EveStreamEvent | null = null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.type === "string") {
          event = record as EveStreamEvent;
        }
      }
    } catch {
      // Unparseable line — skip and count.
    }
    if (!event) {
      skippedLines += 1;
      return;
    }
    await opts.onEvent(event, trimmed);
  };

  const reader = res.body.getReader();
  // Cancel the reader when the caller aborts so a pending read() resolves
  // promptly even when the server keeps the (durable) stream open. Real fetch
  // also rejects on abort, but reader.cancel() makes early exit deterministic.
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (opts.signal.aborted) {
    onAbort();
  } else {
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        await handleLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      await handleLine(buffer);
    }
  } catch (err) {
    if (opts.signal.aborted) return { skippedLines };
    throw err;
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
  }
  return { skippedLines };
}

export async function fetchInfo(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/eve/v1/info`,
    {
      method: "GET",
      headers: buildHeaders(opts.headers, false),
    },
    opts.timeoutMs,
  );
  const body = await readBodySafe(res);
  if (!res.ok) {
    throw new Error(`Eve info failed: HTTP ${res.status} ${truncate(body)}`);
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new Error(`Eve info returned a non-object body: ${truncate(body)}`);
}
