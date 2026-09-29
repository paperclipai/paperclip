import { eq } from "drizzle-orm";
import { toolConnections, toolInvocations, type Db } from "@paperclipai/db";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import {
  trackConnectionCreated,
  trackConnectionUpdated,
  trackConnectionInvoked,
} from "@paperclipai/shared/telemetry";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";

type ToolConnectionRow = typeof toolConnections.$inferSelect;
type ToolInvocationRow = typeof toolInvocations.$inferSelect;

export type ConnectorSetupFlow = "gallery" | "api" | "example";
export type ConnectorChangeSource =
  | "api"
  | "gallery"
  | "oauth_callback"
  | "credential_refresh"
  | "archive"
  | "example";

/**
 * Terminal `tool_invocations.status` values. `pending`, `authorized`,
 * `awaiting_approval`, and `executing` are in-flight and never emit: pending
 * approval is not a failure. `cancelled` is declared in the schema enum but no
 * current code path writes it to an invocation (signing-path cancellations
 * land on the action request and fail the invocation); it stays here so a
 * future writer is counted without a telemetry change.
 */
const TERMINAL_INVOCATION_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "timed_out",
  "rate_limited",
]);

/**
 * Connector identity for telemetry is the reviewed first-party catalog slug
 * only: `config.sourceTemplateKey` validated against the shared app-definitions
 * catalog. Anything else — custom MCP servers, user-named connections, keys
 * that no longer resolve to a catalog entry — reports the literal `custom` so
 * no user- or provider-controlled string leaves the process.
 */
export function connectorKeyForConnection(
  connection: Pick<ToolConnectionRow, "config">,
): string {
  const raw = connection.config?.sourceTemplateKey;
  const key = typeof raw === "string" ? raw : null;
  return key && getConnectableAppDefinition(key) ? key : "custom";
}

/**
 * Setup-test invocations (Apps → Test tab) are separated from agent usage on
 * durable invocation columns, mirroring the gateway's own test-origin
 * predicate, so the split survives reloads and approval-driven completion.
 */
export function invocationOrigin(
  invocation: Pick<
    ToolInvocationRow,
    "actorType" | "runId" | "issueId" | "gatewayId" | "connectionId"
  >,
): string {
  const isTestOrigin =
    invocation.actorType === "user" &&
    invocation.runId === null &&
    invocation.issueId === null &&
    invocation.gatewayId === null &&
    invocation.connectionId !== null;
  return isTestOrigin ? "setup_test" : invocation.actorType;
}

function isToolPurpose(connection: Pick<ToolConnectionRow, "connectionPurpose">): boolean {
  return connection.connectionPurpose === "tool";
}

/**
 * Emits one proposed `connection.created` event for a tool-purpose
 * connection row that a caller already committed. Channel and AI connections
 * never emit. This function never throws; a telemetry failure must never fail
 * a connection setup path.
 */
export function emitConnectionCreated(
  connection: ToolConnectionRow,
  setupFlow: ConnectorSetupFlow,
): void {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    if (!isToolPurpose(connection)) return;
    trackConnectionCreated(client, {
      connector_key: connectorKeyForConnection(connection),
      transport: connection.transport,
      auth_kind: connection.authKind,
      setup_flow: setupFlow,
      status: connection.status,
      enabled: connection.enabled,
    });
  } catch (err) {
    logger.warn(
      { err, connectionId: connection.id },
      "failed to emit connection.created telemetry",
    );
  }
}

/**
 * Emits one proposed `connection.updated` event when a committed
 * write changed a tool-purpose connection's persisted lifecycle state
 * (`status` or `enabled`). Metadata-only saves, health polls, credential
 * rotation, and catalog refreshes do not change either field and therefore
 * never emit. This function never throws.
 */
export function emitConnectionUpdated(
  connection: ToolConnectionRow,
  previous: Pick<ToolConnectionRow, "status" | "enabled">,
  changeSource: ConnectorChangeSource,
): void {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    if (!isToolPurpose(connection)) return;
    if (
      previous.status === connection.status &&
      previous.enabled === connection.enabled
    ) {
      return;
    }
    trackConnectionUpdated(client, {
      connector_key: connectorKeyForConnection(connection),
      transport: connection.transport,
      auth_kind: connection.authKind,
      change_source: changeSource,
      previous_status: previous.status,
      status: connection.status,
      previous_enabled: previous.enabled,
      enabled: connection.enabled,
    });
  } catch (err) {
    logger.warn(
      { err, connectionId: connection.id },
      "failed to emit connection.updated telemetry",
    );
  }
}

/**
 * Emits one proposed `connection.invoked` event for an invocation
 * a caller already wrote to a terminal status. Despite the name, this is a
 * completion event: it records finished invocation attempts and their
 * terminal status, never invocation starts. Never await it: like
 * `agent.task_run`, this is best-effort background work and must not delay
 * the caller's own response or lifecycle writes.
 *
 * Call placement inside the gateway is deliberate and asymmetric. Failure
 * paths call it right after their terminal save. Success paths call it only
 * after the post-save bookkeeping (action-request settlement, tool-call
 * event, audit) has completed, because a bookkeeping failure lands in a catch
 * that overwrites the row to `failed` and emits there — emitting the success
 * beforehand would let one execution report both outcomes.
 *
 * Self-guards, so callers do not have to re-check anything: non-terminal
 * statuses, invocations without a tool-purpose connection, and an
 * unregistered (still-proposed) event name all return without emitting. The
 * registration gate keeps the completion path free of telemetry reads until
 * schema adoption: the runtime client drops unregistered names in `track`,
 * so there is no point loading rows for an event that cannot be queued.
 *
 * Delivery is best-effort per execution, not exactly-once. Known residual
 * duplications, accepted for the proposal stage: an outer safety-net catch
 * can re-save `failed` and emit again when a failure path's own bookkeeping
 * throws after its emit (test-invocation approval flow), and a crash-side
 * replay that re-writes a terminal status emits again. Deduplication state
 * is out of scope for this proposal.
 */
export async function emitConnectionInvoked(
  db: Db,
  invocationId: string,
): Promise<void> {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    if (!client.isRegisteredEventName("connection.invoked")) return;

    const joined = await db
      .select({ invocation: toolInvocations, connection: toolConnections })
      .from(toolInvocations)
      .innerJoin(
        toolConnections,
        eq(toolInvocations.connectionId, toolConnections.id),
      )
      .where(eq(toolInvocations.id, invocationId))
      .then((rows) => rows[0] ?? null);
    if (!joined) return;
    const { invocation, connection } = joined;
    if (!TERMINAL_INVOCATION_STATUSES.has(invocation.status)) return;
    if (!isToolPurpose(connection)) return;

    const startedAtMs = invocation.startedAt
      ? new Date(invocation.startedAt).getTime()
      : null;
    const completedAtMs = invocation.completedAt
      ? new Date(invocation.completedAt).getTime()
      : null;
    const durationSeconds =
      startedAtMs !== null && completedAtMs !== null
        ? Math.max(0, Math.round((completedAtMs - startedAtMs) / 1000))
        : undefined;

    trackConnectionInvoked(client, {
      connector_key: connectorKeyForConnection(connection),
      transport: connection.transport,
      status: invocation.status,
      origin: invocationOrigin(invocation),
      ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
    });
  } catch (err) {
    logger.warn(
      { err, invocationId },
      "failed to emit connection.invoked telemetry",
    );
  }
}
