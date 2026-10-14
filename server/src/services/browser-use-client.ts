import { HttpError } from "../errors.js";
import { BROWSER_USE_API_URL } from "@paperclipai/shared";
import { z } from "zod";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

export class BrowserUseError extends HttpError {
  constructor(
    status: number,
    message: string,
    public retryAfterMs = 0,
    public requestRejected = false,
  ) {
    super(status, message);
  }
}
export const browserUseTerminal = (status: string) =>
  ["completed", "failed", "cancelled"].includes(status);
export function isBrowserUseConnection(c: {
  transport: string;
  config?: Record<string, unknown>;
}) {
  return (
    c.transport === "rest_api" && c.config?.sourceTemplateKey === "browser-use-cloud"
  );
}
export function browserUseViewerUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new BrowserUseError(502, "The live browser is not available yet.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserUseError(
      502,
      "Browser Use returned an invalid viewer address.",
    );
  }
  if (
    url.origin !== "https://live.browser-use.com" ||
    url.username ||
    url.password
  ) {
    throw new BrowserUseError(
      502,
      "Browser Use returned an unsupported viewer address.",
    );
  }
  return url.href;
}
/** Provider data is untrusted, including text containing credential URLs. */
export function sanitizeBrowserUse(value: unknown): unknown {
  if (typeof value === "string")
    return value
      .replace(
        /(?:https?|wss?):(?:\\\/|\/){2}[^\s"<>\\]*(?:browser-use\.com|browser-use\.net)[^\s"<>]*/gi,
        "[private browser address]",
      )
      .replace(/bu_[a-zA-Z0-9_-]+/g, "[redacted]");
  if (Array.isArray(value)) return value.map(sanitizeBrowserUse);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/(?:url|uri|token|secret|cookie|authorization|api.?key|credential)/i.test(
              key,
            ),
        )
        .map(([key, val]) => [key, sanitizeBrowserUse(val)]),
    );
  return value;
}
export function browserUseCostCap(
  ...values: Array<number | null | undefined>
): number | undefined {
  const finite = values.filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  if (!finite.length) return undefined;
  const cap = Math.min(...finite);
  if (cap <= 0) throw new BrowserUseError(403, "No browser budget remains.");
  return cap;
}
const status = z.enum([
  "queued",
  "dispatching",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const created = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  status,
  model: z.string(),
});
const browser = z.object({
  id: z.string().uuid(),
  status: z.enum(["active", "stopped"]),
  agentSessionId: z.string().uuid().nullable().optional(),
  liveUrl: z.string().nullable().optional(),
  cdpUrl: z.string().nullable().optional(),
  timeoutAt: z.string().datetime().optional(),
});
export type BrowserUseRequest = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
const backoff = new Map<string, number>();
export function browserUseClient(
  headers: Record<string, string>,
  request?: BrowserUseRequest,
  scope = "default",
) {
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const until = backoff.get(scope) ?? 0;
    if (until > Date.now())
      throw new BrowserUseError(
        429,
        "Browser Use is rate limited. Retrying after the provider's delay.",
        until - Date.now(),
        true,
      );
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        redirect: "error",
        headers: { ...headers, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(25000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      };
      response = await (request
        ? request(BROWSER_USE_API_URL + path, init)
        : guardedRemoteHttpFetch(BROWSER_USE_API_URL + path, init, {
            error: () =>
              new BrowserUseError(502, "Browser Use could not be reached."),
          }));
    } catch {
      // Never surface a provider response/URL/header in a logged exception.
      throw new BrowserUseError(
        502,
        method === "POST" && path === "/runs"
          ? "Run creation could not be confirmed. It will not be retried automatically."
          : "Browser Use could not be reached.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get("retry-after");
      const retryMs = retry
        ? /^\d+(\.\d+)?$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now()
        : 5000;
      const delay = Number.isFinite(retryMs) ? Math.max(1000, retryMs) : 5000;
      if (response.status === 429) backoff.set(scope, Date.now() + delay);
      throw new BrowserUseError(
        response.status,
        response.status === 401 || response.status === 403
          ? "Browser Use rejected this credential. Reconnect the connection."
          : response.status === 409
            ? "This browser conversation is busy. Wait for its run to finish."
            : `Browser Use request failed (${response.status}).`,
        response.status === 429 ? delay : 0,
        response.status >= 400 && response.status < 500 && response.status !== 408,
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new BrowserUseError(502, "Browser Use returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) throw new Error();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      await reader.cancel();
      throw new BrowserUseError(
        502,
        "Browser Use returned an invalid response.",
      );
    }
  }
  const id = (value: string) => z.string().uuid().parse(value);
  return {
    async probe() {
      await call("/profiles?pageSize=1&pageNumber=1");
    },
    async start(body: {
      task: string;
      sessionId?: string;
      browserSettings?: {
        profileId?: string;
        record: false;
        allowResizing?: true;
      };
      maxCostUsd?: number;
    }) {
      return created.parse(await call("/runs", "POST", body));
    },
    async status(runId: string) {
      return z
        .object({ status })
        .parse(await call(`/runs/${id(runId)}/status`));
    },
    async listRuns(sessionId?: string | null, cursor?: string | null) {
      const query = new URLSearchParams({ limit: "100" });
      if (sessionId) query.set("sessionId", id(sessionId));
      if (cursor) query.set("cursor", cursor);
      return z.object({
        runs: z.array(z.object({
          id: z.string().uuid(), sessionId: z.string().uuid(), task: z.string(), status,
        })),
        nextCursor: z.string().nullable().optional(),
        hasMore: z.boolean().default(false),
      }).parse(await call(`/runs?${query}`));
    },
    async summary(runId: string) {
      return z
        .object({
          status,
          result: z.string().nullable(),
          output: z.unknown().optional(),
          totalCostUsd: z.string(),
          model: z.string(),
        })
        .parse(await call(`/runs/${id(runId)}`));
    },
    async events(runId: string, after: number) {
      return z
        .object({
          events: z.array(
            z.object({
              id: z.number().int(),
              type: z.string(),
              data: z.record(z.string(), z.unknown()),
            }),
          ),
          nextAfter: z.number().nullable().optional(),
          hasMore: z.boolean().default(false),
        })
        .parse(
          await call(
            `/runs/${id(runId)}/events?after=${after}&limit=200&include_output=false`,
          ),
        );
    },
    async cancel(runId: string) {
      await call(`/runs/${id(runId)}/cancel`, "POST");
    },
    async browsers(sessionId: string, page = 1) {
      return z
        .object({ items: z.array(browser), totalItems: z.number() })
        .parse(
          await call(
            `/browsers?agentSessionId=${id(sessionId)}&pageSize=100&pageNumber=${page}`,
          ),
        );
    },
    async browser(browserId: string) {
      return browser.parse(await call(`/browsers/${id(browserId)}`));
    },
    async stop(browserId: string) {
      await call(`/browsers/${id(browserId)}`, "PATCH", { action: "stop" });
    },
    async profiles(page = 1) {
      return z
        .object({
          items: z.array(
            z.object({
              id: z.string().uuid(),
              name: z.string().nullable().optional(),
            }),
          ),
          totalItems: z.number(),
        })
        .parse(await call(`/profiles?pageSize=100&pageNumber=${page}`));
    },
  };
}
