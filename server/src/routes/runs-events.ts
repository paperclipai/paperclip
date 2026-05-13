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

const RUN_EVENT_PAYLOAD_KEYS = [
  "data",
  "error",
  "exitCode",
  "level",
  "message",
  "metadata",
  "session_id",
  "signal",
  "stderr",
  "stdout",
  "text",
  "tool",
  "tool_name",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildRunEventPayload(body: RouteRequest["body"]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (isRecord(body.payload)) {
    Object.assign(payload, body.payload);
  }
  for (const key of RUN_EVENT_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      payload[key] = body[key];
    }
  }
  return payload;
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
    await deps.appendRunEvent({
      runId: v.claims.runId,
      type: req.body.type,
      ts: typeof req.body.ts === "string" ? req.body.ts : new Date().toISOString(),
      payload: buildRunEventPayload(req.body),
    });
    return { status: 204 };
  };
}
