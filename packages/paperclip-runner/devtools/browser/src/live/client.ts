import type { PrpEvent } from "../../../../src/protocol/replay-contract";
import type {
  GoalOperation,
  LiveManifestSummary,
  LiveSessionState,
} from "./protocol";

const BASE = "/api/liveConsole";

export class LiveConsoleError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LiveConsoleError";
    this.status = status;
    this.code = code;
  }
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new LiveConsoleError(
      response.status,
      typeof body.error === "string" ? body.error : "request_failed",
      typeof body.message === "string" ? body.message : `Request to ${path} failed.`,
    );
  }
  return body as T;
}

export async function fetchManifests(): Promise<LiveManifestSummary[]> {
  const body = await send<{ manifests: LiveManifestSummary[] }>("/manifests");
  return body.manifests;
}

export async function createSession(input: {
  manifest: string;
  objective: string;
  message?: string;
  startTurn?: boolean;
}): Promise<LiveSessionState> {
  return send<LiveSessionState>("/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function readSession(sessionId: string): Promise<LiveSessionState> {
  return send<LiveSessionState>(`/sessions/${sessionId}`);
}

export async function readEvents(
  sessionId: string,
  after = 0,
): Promise<{ events: PrpEvent[]; cursor: number; replay: boolean }> {
  return send(`/sessions/${sessionId}/events?after=${after}`);
}

export async function startTurn(
  sessionId: string,
  text: string,
): Promise<LiveSessionState> {
  return send<LiveSessionState>(`/sessions/${sessionId}/turns`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function steerTurn(
  sessionId: string,
  turnId: string,
  text: string,
): Promise<LiveSessionState> {
  return send<LiveSessionState>(`/sessions/${sessionId}/steer`, {
    method: "POST",
    body: JSON.stringify({ turnId, text }),
  });
}

export async function interruptTurn(
  sessionId: string,
  turnId: string | null,
): Promise<LiveSessionState> {
  return send<LiveSessionState>(`/sessions/${sessionId}/interrupt`, {
    method: "POST",
    body: JSON.stringify({
      reason: "browser_operator",
      ...(turnId === null ? {} : { turnId }),
    }),
  });
}

export async function resolveRequest(
  sessionId: string,
  requestId: string,
  turnId: string,
  resolution: Record<string, unknown>,
): Promise<LiveSessionState> {
  return send<LiveSessionState>(
    `/sessions/${sessionId}/requests/${encodeURIComponent(requestId)}/resolve`,
    { method: "POST", body: JSON.stringify({ turnId, resolution }) },
  );
}

export async function goalOperation(
  sessionId: string,
  operation: GoalOperation,
  body: Record<string, unknown> = {},
): Promise<LiveSessionState> {
  return send<LiveSessionState>(`/sessions/${sessionId}/goal/${operation}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function reconnectSession(sessionId: string): Promise<LiveSessionState> {
  return send<LiveSessionState>(`/sessions/${sessionId}/reconnect`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function closeSession(sessionId: string): Promise<void> {
  await send(`/sessions/${sessionId}/close`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export interface EventStreamHandle {
  close(): void;
}

/**
 * Subscribes to the canonical event stream from a durable cursor. The stream
 * never carries provider credentials; the server redacts every frame.
 */
export function openEventStream(
  sessionId: string,
  after: number,
  handlers: {
    onEvent: (event: PrpEvent) => void;
    onOpen?: () => void;
    onError?: () => void;
  },
): EventStreamHandle {
  const source = new EventSource(`${BASE}/sessions/${sessionId}/stream?after=${after}`);
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
}
