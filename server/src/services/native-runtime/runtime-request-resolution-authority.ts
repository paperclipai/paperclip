import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import type { HarnessRuntimeRequestKind } from "../../vendor/paperclip-runner/index.js";

const TERMINAL_RUNTIME_REQUEST_EVENTS = [
  "runtime_request.resolved",
  "runtime_request.cancelled",
  "runtime_request.expired",
] as const;
const RUNTIME_REQUEST_EVENTS = [
  "runtime_request.created",
  ...TERMINAL_RUNTIME_REQUEST_EVENTS,
] as const;
const APPROVAL_REQUEST_KINDS = new Set<NativeRuntimeRequestKind>([
  "command_approval",
  "file_approval",
  "permission_approval",
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export type NativeRuntimeRequestKind = HarnessRuntimeRequestKind | "runtime";

export interface PendingNativeRuntimeRequest {
  readonly companyId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly requestKind: NativeRuntimeRequestKind;
  readonly turnId: string;
  /** Server-owned policy derived from the canonical request kind. */
  readonly resolverPolicy: "human_only" | "instance_admin";
}

export interface NativeRuntimeRequestResolver {
  readonly type: "user";
  readonly userId: string;
  readonly isInstanceAdmin: boolean;
}

export class NativeRuntimeRequestResolutionAuthorizationError extends Error {
  constructor(readonly code: "native_runtime_request_resolver_denied") {
    super(code);
    this.name = "NativeRuntimeRequestResolutionAuthorizationError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalPendingRequest(input: {
  companyId: string;
  runId: string;
  requestId: string;
  payload: unknown;
}): PendingNativeRuntimeRequest | null {
  const event = record(record(input.payload)?.prpEvent);
  const eventPayload = record(event?.payload);
  const request = record(eventPayload?.request);
  if (
    !event
    || event.schema !== "paperclip.prp.event.v1"
    || event.eventType !== "runtime_request.created"
    || event.sourceKind !== "runner"
    || event.runId !== input.runId
    || !request
    || request.status !== "pending"
  ) return null;

  const requestId = typeof request.requestId === "string" ? request.requestId : "";
  const requestKind = typeof request.requestKind === "string" ? request.requestKind : "";
  const turnId = typeof request.turnId === "string"
    ? request.turnId
    : typeof event.turnId === "string"
      ? event.turnId
      : "";
  const supportedKinds: readonly NativeRuntimeRequestKind[] = [
    "command_approval",
    "file_approval",
    "permission_approval",
    "user_input",
    "elicitation",
    "runtime",
  ];
  if (
    requestId !== input.requestId
    || !REQUEST_ID_PATTERN.test(requestId)
    || !supportedKinds.includes(requestKind as NativeRuntimeRequestKind)
    || !REQUEST_ID_PATTERN.test(turnId)
  ) {
    return null;
  }
  const kind = requestKind as NativeRuntimeRequestKind;
  return {
    companyId: input.companyId,
    runId: input.runId,
    requestId,
    requestKind: kind,
    turnId,
    resolverPolicy: APPROVAL_REQUEST_KINDS.has(kind)
      ? "instance_admin"
      : "human_only",
  };
}

/**
 * Load the latest durable lifecycle event for one request. A request is
 * actionable only when that exact latest event is its canonical creation.
 * Client-supplied kind/turn fields never participate in this lookup.
 */
export async function readPendingNativeRuntimeRequest(
  db: Db,
  input: {
    readonly companyId: string;
    readonly runId: string;
    readonly requestId: string;
  },
): Promise<PendingNativeRuntimeRequest | null> {
  if (!REQUEST_ID_PATTERN.test(input.requestId)) return null;
  const [latest] = await db
    .select({
      eventType: heartbeatRunEvents.eventType,
      payload: heartbeatRunEvents.payload,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, input.companyId),
      eq(heartbeatRunEvents.runId, input.runId),
      inArray(heartbeatRunEvents.eventType, [...RUNTIME_REQUEST_EVENTS]),
      sql`coalesce(
        ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,request,requestId}',
        ${heartbeatRunEvents.payload} #>> '{prpEvent,payload,requestId}'
      ) = ${input.requestId}`,
    ))
    .orderBy(desc(heartbeatRunEvents.seq))
    .limit(1);
  if (!latest || latest.eventType !== "runtime_request.created") return null;
  return canonicalPendingRequest({ ...input, payload: latest.payload });
}

/** Revalidate the server-owned resolver policy at the command-consumption edge. */
export function assertNativeRuntimeRequestResolverAuthorized(
  request: PendingNativeRuntimeRequest,
  actor: NativeRuntimeRequestResolver,
): void {
  if (!actor.userId.trim()) {
    throw new NativeRuntimeRequestResolutionAuthorizationError(
      "native_runtime_request_resolver_denied",
    );
  }
  if (request.resolverPolicy === "instance_admin" && !actor.isInstanceAdmin) {
    throw new NativeRuntimeRequestResolutionAuthorizationError(
      "native_runtime_request_resolver_denied",
    );
  }
}
