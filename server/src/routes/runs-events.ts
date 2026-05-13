import type { RunJwtService } from "../services/run-jwt.js";

export interface RunEventInput {
  runId: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export interface RunsEventsDeps {
  runJwt: RunJwtService;
  appendRunEvent: (input: RunEventInput) => Promise<void>;
}

export interface RouteRequest {
  params: { runId: string };
  headers: { authorization?: string };
  body: { type?: string; ts?: string; [k: string]: unknown };
}

export interface RouteResponse {
  status: number;
  body?: Record<string, unknown>;
}

const MAX_RUN_EVENT_PAYLOAD_BYTES = 32 * 1024;
const MAX_RUN_EVENT_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000;

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function parseEventTimestamp(input: unknown, now = new Date()): string | null {
  if (input === undefined) return now.toISOString();
  if (typeof input !== "string") return null;
  const parsedMs = Date.parse(input);
  if (!Number.isFinite(parsedMs)) return null;
  if (Math.abs(parsedMs - now.getTime()) > MAX_RUN_EVENT_TIMESTAMP_SKEW_MS) return null;
  return new Date(parsedMs).toISOString();
}

export function createRunsEventsRoute(deps: RunsEventsDeps) {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return { status: 401, body: { error: "missing_authorization" } };
    const v = deps.runJwt.verify(auth.slice("Bearer ".length));
    if (!v.ok) return { status: 401, body: { error: "invalid_jwt" } };
    if (v.claims.runId !== req.params.runId) {
      return { status: 403, body: { error: "run_id_mismatch" } };
    }
    if (typeof req.body.type !== "string") {
      return { status: 400, body: { error: "missing_event_type" } };
    }
    if (jsonByteLength(req.body) > MAX_RUN_EVENT_PAYLOAD_BYTES) {
      return { status: 413, body: { error: "payload_too_large", maxBytes: MAX_RUN_EVENT_PAYLOAD_BYTES } };
    }
    const ts = parseEventTimestamp(req.body.ts);
    if (!ts) {
      return { status: 400, body: { error: "invalid_event_timestamp" } };
    }
    await deps.appendRunEvent({
      runId: v.claims.runId,
      type: req.body.type,
      ts,
      payload: req.body,
    });
    return { status: 204 };
  };
}
