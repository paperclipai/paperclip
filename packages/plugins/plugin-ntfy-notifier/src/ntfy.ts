/**
 * Minimal ntfy publisher.
 *
 * The request carries only the fixed message body, a `Click` link, the fixed
 * `Title` and `Tags` headers and, when configured, `Authorization` and
 * `Priority` headers. Nothing else from the
 * Paperclip event is forwarded.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface NtfyMessage {
  /** Full publish URL, e.g. `<base>/<topic>`. */
  url: string;
  body: string;
  click: string;
  /** Fixed title from `buildMessageTitle`. */
  title: string;
  /** Fixed tag list from `MESSAGE_TAGS`. */
  tags: string;
  token?: string;
  priority?: number;
}

export interface NtfySendOptions {
  fetch: FetchLike;
  timeoutMs: number;
  /** Total attempts including the first one. */
  maxAttempts: number;
  /** Base delay between attempts; doubles each retry. */
  retryDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export type NtfySendResult =
  | { ok: true; attempts: number; status: number }
  | { ok: false; attempts: number; status?: number; reason: NtfyFailureReason };

export type NtfyFailureReason = "timeout" | "network" | "http_status";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildNtfyRequest(message: NtfyMessage): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Click: message.click,
    Title: message.title,
    Tags: message.tags,
  };
  if (message.token) headers.Authorization = `Bearer ${message.token}`;
  if (message.priority !== undefined) headers.Priority = String(message.priority);
  return {
    url: message.url,
    init: { method: "POST", headers, body: message.body, redirect: "error" },
  };
}

/** Status codes that are worth another attempt. Other 4xx are final. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Send one ntfy message with a bounded timeout per attempt and a bounded
 * number of attempts. Never throws: every failure is reported as a result
 * with a coarse reason that is safe to log.
 *
 * Retries happen only after a definite failure: a network error before a
 * response, or a retryable status (408, 429, 5xx). A timeout is not retried.
 */
export async function sendNtfy(message: NtfyMessage, options: NtfySendOptions): Promise<NtfySendResult> {
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const { url, init } = buildNtfyRequest(message);
  let last: NtfySendResult = { ok: false, attempts: 0, reason: "network" };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("timeout"));
      }, options.timeoutMs);
    });
    try {
      // Race the timer as well as passing the signal: a host-proxied fetch
      // may not honour AbortSignal across the worker boundary.
      const response = await Promise.race([
        options.fetch(url, { ...init, signal: controller.signal }),
        timeout,
      ]);
      // Drain the body so the connection can be reused; ignore its content.
      await Promise.race([response.text().catch(() => ""), timeout]).catch(() => "");
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, attempts: attempt, status: response.status };
      }
      last = { ok: false, attempts: attempt, status: response.status, reason: "http_status" };
      if (!isRetryableStatus(response.status)) return last;
    } catch {
      if (timedOut) {
        // A timeout is ambiguous: the request may still be in flight and ntfy
        // may accept it later (a host-proxied fetch keeps running after our
        // local timer fires). Retrying could publish the same message again,
        // so a timeout ends the send (at most one publish per timeout).
        return { ok: false, attempts: attempt, reason: "timeout" };
      }
      last = { ok: false, attempts: attempt, reason: "network" };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (attempt < maxAttempts) await sleep(options.retryDelayMs * 2 ** (attempt - 1));
  }
  return last;
}
