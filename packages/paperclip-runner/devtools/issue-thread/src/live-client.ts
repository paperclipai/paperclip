import type { CapabilityIssueThreadSnapshot } from "../../../src/issue-thread/types";
import type { CapabilityDevtoolsSnapshot } from "../../../src/devtools";
import type { CapabilityJsonValue } from "../../../src/mock-core/capability-control-plane-types";
import {
  CAPABILITY_TURN_STREAM_ACCEPT,
  CapabilityTurnStreamError,
  readCapabilityTurnStream,
} from "../../../src/live/turn-stream";

/**
 * Browser client for the package session server.
 *
 * Every response is a server-projected `CapabilityIssueThreadSnapshot`. The client
 * posts intents and renders what comes back; it never patches the snapshot
 * locally, which is what keeps policy and state authority on the server
 * (contract §11).
 *
 * A turn is the one route that answers with many of those projections instead
 * of one: `send` consumes NDJSON frames as the provider produces them, hands
 * each interim view to `onFrame`, and resolves with the settled payload. The
 * authority rule is unchanged — every frame is still a server projection, and
 * the settled one is final.
 */

const BASE = "/api/capability/ui";

/**
 * Every route is session-scoped and mediated by the per-browser capability
 * cookie the server sets, so the cookie has to ride along. Stated rather than
 * left to the default so a future change to this client cannot silently drop
 * the capability and fall back to session-id-only access (track 7U).
 */
const CREDENTIALS = "same-origin" as const;

export interface CapabilityCleanRoomIdentity {
  token: string;
  sequence: number;
  companyId: string;
  actorId: string;
  taskId: string;
  identifier: string;
}

export interface CapabilityHarnessConfiguration {
  provider: "codex" | "opencode" | "acpx";
  model: string | null;
  acpxAgent?: "claude" | "codex";
  lifecyclePolicy:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
}

export interface CapabilityLiveResponse {
  sessionId: string;
  view: CapabilityIssueThreadSnapshot;
  surface?: "issue" | "cleanroom";
  /** Present on the clean-room surface so the UI can show which tenant is live. */
  identity?: CapabilityCleanRoomIdentity;
  limits?: { maxTurns: number; maxMessageBytes: number };
  turns?: number;
  configuration?: CapabilityHarnessConfiguration;
  runtime?: {
    providerSessionId: string | null;
    driverSessionId?: string | null;
    runnerPid: number | null;
    providerPid: number | null;
    sidecarPid?: number | null;
    agentPid?: number | null;
    providerVersion?: string | null;
    agentServerVersion?: string | null;
    agentRuntimeVersion?: string | null;
    acpProtocolVersion?: number | null;
    executionKind: "local_process" | "remote_service";
    status: string;
  };
}

export interface CapabilityToolTestResponse extends CapabilityLiveResponse {
  toolResult: CapabilityJsonValue;
  toolTurnId: string;
}

/**
 * The server names its own failures. Surfacing the code lets the clean room say
 * "this chat hit its turn limit" instead of "500", and — more importantly —
 * lets a failure to start real Codex read as a failure rather than quietly
 * degrading into a fixture.
 */
export class CapabilityLiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityLiveError";
  }
}

async function readError(response: Response, path: string): Promise<CapabilityLiveError> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return new CapabilityLiveError(
      body.error ?? `http_${response.status}`,
      body.message ?? `${path} failed with ${response.status}`,
    );
  } catch {
    return new CapabilityLiveError(`http_${response.status}`, `${path} failed with ${response.status}`);
  }
}

async function post<T = CapabilityLiveResponse>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: CREDENTIALS,
  });
  if (!response.ok) throw await readError(response, path);
  return (await response.json()) as T;
}

/** Interim projection delivered while the turn is still running. */
export type CapabilityTurnFrameHandler = (view: CapabilityIssueThreadSnapshot) => void;

export interface CapabilitySendOptions {
  onFrame?: CapabilityTurnFrameHandler;
  /** Abort the turn stream — used when the surface is torn down or rotated. */
  signal?: AbortSignal;
}

async function postTurnStream(
  path: string,
  body: unknown,
  options: CapabilitySendOptions,
): Promise<CapabilityLiveResponse> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: CAPABILITY_TURN_STREAM_ACCEPT },
    body: JSON.stringify(body),
    credentials: CREDENTIALS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // Admission failures still answer with a JSON body and a real status code,
  // because they are decided before the first frame is written.
  if (!response.ok) throw await readError(response, path);
  try {
    return await readCapabilityTurnStream<CapabilityIssueThreadSnapshot, CapabilityLiveResponse>(
      response,
      (frame) => options.onFrame?.(frame.view),
    );
  } catch (cause) {
    if (cause instanceof CapabilityTurnStreamError) {
      throw new CapabilityLiveError(cause.code, cause.message);
    }
    throw cause;
  }
}

export const capabilityLiveClient = {
  async devtools(sessionId: string): Promise<CapabilityDevtoolsSnapshot> {
    const response = await fetch(`${BASE}/devtools?sessionId=${encodeURIComponent(sessionId)}`, {
      credentials: CREDENTIALS,
    });
    if (!response.ok) throw await readError(response, "/devtools");
    return (await response.json()) as CapabilityDevtoolsSnapshot;
  },
  fork(sessionId: string, revision: number): Promise<CapabilityLiveResponse> {
    return post("/devtools/fork", { sessionId, revision });
  },
  invokeTool(
    sessionId: string,
    operationId: string,
    input: CapabilityJsonValue,
  ): Promise<CapabilityToolTestResponse> {
    return post("/tool", { sessionId, operationId, input }) as Promise<CapabilityToolTestResponse>;
  },
  async load(sessionId: string | null): Promise<CapabilityLiveResponse> {
    const query = sessionId === null ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
    const response = await fetch(`${BASE}/session${query}`, { credentials: CREDENTIALS });
    if (!response.ok) throw await readError(response, "/session");
    return (await response.json()) as CapabilityLiveResponse;
  },
  create(scenario: string): Promise<CapabilityLiveResponse> {
    return post("/session", { scenario });
  },
  /** Reconnect to a clean room, or open one when there is nothing to resume. */
  async loadCleanRoom(sessionId: string | null, configuration: CapabilityHarnessConfiguration): Promise<CapabilityLiveResponse> {
    const query = new URLSearchParams({ provider: configuration.provider });
    if (sessionId !== null) query.set("sessionId", sessionId);
    if (configuration.model !== null) query.set("model", configuration.model);
    if (configuration.acpxAgent) query.set("acpxAgent", configuration.acpxAgent);
    query.set("lifecycleMode", configuration.lifecyclePolicy.mode);
    if (configuration.lifecyclePolicy.mode === "warm") {
      query.set("idleTimeoutMs", String(configuration.lifecyclePolicy.idleTimeoutMs));
    }
    const response = await fetch(`${BASE}/cleanroom/session?${query.toString()}`, { credentials: CREDENTIALS });
    if (!response.ok) throw await readError(response, "/cleanroom/session");
    return (await response.json()) as CapabilityLiveResponse;
  },
  /** `New chat`: retire the current room and mint a new mock tenant. */
  newCleanRoom(sessionId: string | null, configuration: CapabilityHarnessConfiguration): Promise<CapabilityLiveResponse> {
    return post("/cleanroom/session", { ...(sessionId === null ? {} : { sessionId }), ...configuration });
  },
  /**
   * Runs one turn. `onFrame` fires for every interim projection the server
   * writes while the POST is open; the resolved value is the settled payload.
   */
  send(
    sessionId: string,
    message: string,
    options: CapabilitySendOptions = {},
  ): Promise<CapabilityLiveResponse> {
    return postTurnStream("/message", { sessionId, message }, options);
  },
  stop(sessionId: string): Promise<CapabilityLiveResponse> {
    return post("/interrupt", { sessionId });
  },
  reset(sessionId: string): Promise<CapabilityLiveResponse> {
    return post("/reset", { sessionId });
  },
  reconnect(sessionId: string): Promise<CapabilityLiveResponse> {
    return post("/reconnect", { sessionId });
  },
  respond(
    sessionId: string,
    interactionId: string,
    outcome: string,
    result: unknown,
  ): Promise<CapabilityLiveResponse> {
    return post("/interaction", { sessionId, interactionId, outcome, result });
  },
};

const SESSION_STORAGE_KEY = "paperclip-runner.capability.session";
/**
 * The clean room keeps its own key. Sharing one would let a scenario session id
 * be handed to the clean-room route (and the reverse) after a refresh, which is
 * exactly the cross-surface bleed the isolation criterion forbids.
 */
const CLEAN_ROOM_STORAGE_KEY = "paperclip-runner.capability.cleanroom.session";

function storageKey(surface: "issue" | "cleanroom"): string {
  return surface === "cleanroom" ? CLEAN_ROOM_STORAGE_KEY : SESSION_STORAGE_KEY;
}

export function rememberSession(sessionId: string, surface: "issue" | "cleanroom" = "issue"): void {
  try {
    window.localStorage.setItem(storageKey(surface), sessionId);
  } catch {
    // Refresh restore falls back to a fresh session when storage is blocked.
  }
}

export function recallSession(surface: "issue" | "cleanroom" = "issue"): string | null {
  try {
    return window.localStorage.getItem(storageKey(surface));
  } catch {
    return null;
  }
}
