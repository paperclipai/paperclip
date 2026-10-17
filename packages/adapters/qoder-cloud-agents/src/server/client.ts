import { parseSseStream, type SseFrame } from "./sse.js";

export type QoderFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type QoderRecord = Record<string, unknown>;

export class QoderApiError extends Error {
  readonly status: number;
  readonly errorType: string | null;
  readonly requestId: string | null;

  constructor(input: { status: number; message: string; errorType?: string | null; requestId?: string | null }) {
    super(input.message);
    this.name = "QoderApiError";
    this.status = input.status;
    this.errorType = input.errorType ?? null;
    this.requestId = input.requestId ?? null;
  }
}

function asRecord(value: unknown): QoderRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as QoderRecord;
}

function readList(value: unknown): QoderRecord[] {
  const data = asRecord(value)?.data;
  if (!Array.isArray(data)) return [];
  return data.map((entry) => asRecord(entry)).filter((entry): entry is QoderRecord => Boolean(entry));
}

export function normalizeQoderApiBaseUrl(raw: string, fallback: string): string {
  const value = raw.trim() || fallback;
  return value.replace(/\/+$/, "").replace(/\/api\/v1\/cloud$/, "");
}

/** Every request carries the access token, so anything but TLS would expose it. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export type QoderClient = ReturnType<typeof createQoderClient>;

export function createQoderClient(input: {
  apiBaseUrl: string;
  token: string;
  fetchImpl?: QoderFetch;
  signal?: AbortSignal;
}) {
  const fetchImpl: QoderFetch = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = `${input.apiBaseUrl}/api/v1/cloud`;

  async function toError(response: Response): Promise<QoderApiError> {
    const text = await response.text().catch(() => "");
    let parsed: QoderRecord | null = null;
    try {
      parsed = asRecord(JSON.parse(text));
    } catch {
      parsed = null;
    }
    const error = asRecord(parsed?.error);
    const message = typeof error?.message === "string" && error.message.trim().length > 0
      ? error.message.trim()
      : `Qoder API request failed with HTTP ${response.status}`;
    return new QoderApiError({
      status: response.status,
      message,
      errorType: typeof error?.type === "string" ? error.type : null,
      requestId: typeof parsed?.request_id === "string" ? parsed.request_id : null,
    });
  }

  async function send(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal ?? input.signal,
    });
    if (!response.ok) throw await toError(response);
    return response;
  }

  async function json(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<QoderRecord> {
    const response = await send(method, path, options);
    return asRecord(await response.json()) ?? {};
  }

  return {
    async listAgents(limit = 1): Promise<QoderRecord[]> {
      return readList(await json("GET", `/agents?limit=${limit}`));
    },
    async searchAgents(metadata: Record<string, string>): Promise<QoderRecord[]> {
      return readList(await json("POST", "/agents/search", {
        body: { metadata, limit: 20 },
        headers: { "x-qoder-beta": "search-2026-08-31" },
      }));
    },
    createAgent(body: QoderRecord): Promise<QoderRecord> {
      return json("POST", "/agents", { body });
    },
    updateAgent(agentId: string, body: QoderRecord): Promise<QoderRecord> {
      return json("POST", `/agents/${encodeURIComponent(agentId)}`, { body });
    },
    async listEnvironments(): Promise<QoderRecord[]> {
      return readList(await json("GET", "/environments?limit=100"));
    },
    createEnvironment(body: QoderRecord): Promise<QoderRecord> {
      return json("POST", "/environments", { body });
    },
    async listModels(): Promise<QoderRecord[]> {
      return readList(await json("GET", "/models"));
    },
    createSession(body: QoderRecord): Promise<QoderRecord> {
      return json("POST", "/sessions", { body });
    },
    /** Pass a signal to read the session after the run signal has aborted. */
    getSession(sessionId: string, signal?: AbortSignal): Promise<QoderRecord> {
      return json("GET", `/sessions/${encodeURIComponent(sessionId)}`, { signal });
    },
    async sendEvents(sessionId: string, events: QoderRecord[]): Promise<QoderRecord[]> {
      return readList(await json("POST", `/sessions/${encodeURIComponent(sessionId)}/events`, { body: { events } }));
    },
    async listRecentEvents(sessionId: string, limit = 100): Promise<QoderRecord[]> {
      return readList(await json("GET", `/sessions/${encodeURIComponent(sessionId)}/events?order=desc&limit=${limit}`));
    },
    /** Deliberately ignores the run signal so a cancelled run can still stop its remote turn. */
    async cancelSession(sessionId: string): Promise<void> {
      await send("POST", `/sessions/${encodeURIComponent(sessionId)}/cancel`, {
        signal: AbortSignal.timeout(30_000),
      });
    },
    async *streamEvents(sessionId: string, lastEventId: string | null): AsyncGenerator<SseFrame> {
      const response = await send("GET", `/sessions/${encodeURIComponent(sessionId)}/events/stream`, {
        headers: {
          Accept: "text/event-stream",
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
        },
      });
      if (!response.body) return;
      yield* parseSseStream(response.body as unknown as AsyncIterable<Uint8Array>);
    },
  };
}
