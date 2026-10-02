import type { PrpEvent } from "../protocol/replay-contract.js";
import type {
  GoalOperation,
  ManifestSummary,
  RunnerSessionState,
} from "./protocol.js";

export interface RunnerClientErrorBody {
  error?: unknown;
  message?: unknown;
}

export class RunnerClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RunnerClientError";
    this.status = status;
    this.code = code;
  }
}

export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface RunnerClientOptions {
  /** Defaults to the package-local reference protocol server. */
  baseUrl?: string;
  /** Inject a credential-aware fetch wrapper without exposing credentials to components. */
  fetchImpl?: typeof fetch;
  /** Inject an EventSource-compatible transport for auth, proxies, or tests. */
  eventSourceFactory?: EventSourceFactory;
}

export interface EventStreamHandle {
  close(): void;
}

export interface RunnerClient {
  fetchManifests(): Promise<ManifestSummary[]>;
  createSession(input: {
    manifest: string;
    objective: string;
    message?: string;
    startTurn?: boolean;
  }): Promise<RunnerSessionState>;
  readSession(sessionId: string): Promise<RunnerSessionState>;
  readEvents(
    sessionId: string,
    after?: number,
  ): Promise<{ events: PrpEvent[]; cursor: number; replay: boolean }>;
  startTurn(sessionId: string, text: string): Promise<RunnerSessionState>;
  steerTurn(sessionId: string, turnId: string, text: string): Promise<RunnerSessionState>;
  interruptTurn(sessionId: string, turnId: string | null): Promise<RunnerSessionState>;
  resolveRequest(
    sessionId: string,
    requestId: string,
    turnId: string,
    resolution: Record<string, unknown>,
  ): Promise<RunnerSessionState>;
  goalOperation(
    sessionId: string,
    operation: GoalOperation,
    body?: Record<string, unknown>,
  ): Promise<RunnerSessionState>;
  reconnectSession(sessionId: string): Promise<RunnerSessionState>;
  closeSession(sessionId: string): Promise<void>;
  openEventStream(
    sessionId: string,
    after: number,
    handlers: {
      onEvent: (event: PrpEvent) => void;
      onOpen?: () => void;
      onError?: () => void;
    },
  ): EventStreamHandle;
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function nativeFetch(): typeof fetch {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("A fetch implementation is required in this environment.");
  }
  return globalThis.fetch.bind(globalThis);
}

function nativeEventSource(url: string): EventSourceLike {
  if (typeof globalThis.EventSource !== "function") {
    throw new Error("An EventSource factory is required in this environment.");
  }
  return new globalThis.EventSource(url);
}

/**
 * Creates the framework-free browser client. Provider credentials remain on
 * the protocol server; injected transports may carry browser-to-server auth
 * but that auth is never copied into public session state or component props.
 */
export function createRunnerClient(options: RunnerClientOptions = {}): RunnerClient {
  const baseUrl = normalizedBaseUrl(options.baseUrl ?? "/api/liveConsole");
  const fetchImpl = options.fetchImpl ?? nativeFetch();
  const eventSourceFactory = options.eventSourceFactory ?? nativeEventSource;

  async function send<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers });
    const text = await response.text();
    let body: RunnerClientErrorBody = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as RunnerClientErrorBody;
      } catch {
        if (!response.ok) {
          throw new RunnerClientError(response.status, "invalid_response", "The runner returned invalid JSON.");
        }
        throw new RunnerClientError(response.status, "invalid_response", "The runner returned invalid JSON.");
      }
    }
    if (!response.ok) {
      throw new RunnerClientError(
        response.status,
        typeof body.error === "string" ? body.error : "request_failed",
        typeof body.message === "string" ? body.message : `Request to ${path} failed.`,
      );
    }
    return body as T;
  }

  return {
    async fetchManifests() {
      const body = await send<{ manifests: ManifestSummary[] }>("/manifests");
      return body.manifests;
    },
    createSession(input) {
      return send<RunnerSessionState>("/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    readSession(sessionId) {
      return send<RunnerSessionState>(`/sessions/${encodeURIComponent(sessionId)}`);
    },
    readEvents(sessionId, after = 0) {
      return send(`/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`);
    },
    startTurn(sessionId, text) {
      return send<RunnerSessionState>(`/sessions/${encodeURIComponent(sessionId)}/turns`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    },
    steerTurn(sessionId, turnId, text) {
      return send<RunnerSessionState>(`/sessions/${encodeURIComponent(sessionId)}/steer`, {
        method: "POST",
        body: JSON.stringify({ turnId, text }),
      });
    },
    interruptTurn(sessionId, turnId) {
      return send<RunnerSessionState>(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
        method: "POST",
        body: JSON.stringify({ reason: "browser_operator", ...(turnId === null ? {} : { turnId }) }),
      });
    },
    resolveRequest(sessionId, requestId, turnId, resolution) {
      return send<RunnerSessionState>(
        `/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}/resolve`,
        { method: "POST", body: JSON.stringify({ turnId, resolution }) },
      );
    },
    goalOperation(sessionId, operation, body = {}) {
      return send<RunnerSessionState>(
        `/sessions/${encodeURIComponent(sessionId)}/goal/${operation}`,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    reconnectSession(sessionId) {
      return send<RunnerSessionState>(`/sessions/${encodeURIComponent(sessionId)}/reconnect`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
    async closeSession(sessionId) {
      await send(`/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
    openEventStream(sessionId, after, handlers) {
      const source = eventSourceFactory(
        `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/stream?after=${after}`,
      );
      source.onopen = () => handlers.onOpen?.();
      source.onmessage = (message) => {
        try {
          handlers.onEvent(JSON.parse(message.data) as PrpEvent);
        } catch {
          handlers.onError?.();
        }
      };
      source.onerror = () => handlers.onError?.();
      return { close: () => source.close() };
    },
  };
}
