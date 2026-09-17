import { eq } from "drizzle-orm";
import { toolConnections, toolInvocations, type Db } from "@paperclipai/db";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import {
  trackConnectorConnectionCreated,
  trackConnectorConnectionUpdated,
  trackConnectorInvocationCompleted,
} from "@paperclipai/shared/telemetry";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";

type ToolConnectionRow = typeof toolConnections.$inferSelect;
type ToolInvocationRow = typeof toolInvocations.$inferSelect;

export type ConnectorSetupFlow = "gallery" | "api" | "example" | "composio_sync";
export type ConnectorChangeSource =
  | "update_api"
  | "gallery_setup"
  | "oauth_callback"
  | "credential_refresh"
  | "archive"
  | "example"
  | "composio_sync";

/**
 * Terminal `tool_invocations.status` values actually written by the gateway
 * and approval-review paths. `pending`, `authorized`, `awaiting_approval`, and
 * `executing` are in-flight and never emit: pending approval is not a failure.
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
 * Emits one proposed `connector.connection_created` event for a tool-purpose
 * connection row that a caller already committed. Channel and AI connections
 * never emit. This function never throws; a telemetry failure must never fail
 * a connection setup path.
 */
export function emitConnectorConnectionCreated(
  connection: ToolConnectionRow,
  setupFlow: ConnectorSetupFlow,
): void {
  try {
    const client = getTelemetryClient();
    if (!client) return;
    if (!isToolPurpose(connection)) return;
    trackConnectorConnectionCreated(client, {
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
      "failed to emit connector.connection_created telemetry",
    );
  }
}

/**
 * Emits one proposed `connector.connection_updated` event when a committed
 * write changed a tool-purpose connection's persisted lifecycle state
 * (`status` or `enabled`). Metadata-only saves, health polls, credential
 * rotation, and catalog refreshes do not change either field and therefore
 * never emit. This function never throws.
 */
export function emitConnectorConnectionUpdated(
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
    trackConnectorConnectionUpdated(client, {
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
      "failed to emit connector.connection_updated telemetry",
    );
  }
}

/**
 * Emits one proposed `connector.invocation_completed` event for an invocation
 * a caller already wrote to a terminal status. Loads the committed row, so
 * call it beside each terminal status write with
 * `void emitConnectorInvocationCompleted(db, invocationId)` and never await
 * it: like `agent.task_run`, this is best-effort background work and must not
 * delay the caller's own response or lifecycle writes.
 *
 * Self-guards, so callers do not have to re-check anything: non-terminal
 * statuses, invocations without a connection, and non-tool-purpose
 * connections all return without emitting. Emission is per terminal write,
 * not exactly-once — a replayed terminal write on the same row emits again.
 */
export async function emitConnectorInvocationCompleted(
  db: Db,
  invocationId: string,
): Promise<void> {
  try {
    const client = getTelemetryClient();
    if (!client) return;

    const invocation = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.id, invocationId))
      .then((rows) => rows[0] ?? null);
    if (!invocation) return;
    if (!TERMINAL_INVOCATION_STATUSES.has(invocation.status)) return;
    if (!invocation.connectionId) return;

    const connection = await db
      .select()
      .from(toolConnections)
      .where(eq(toolConnections.id, invocation.connectionId))
      .then((rows) => rows[0] ?? null);
    if (!connection || !isToolPurpose(connection)) return;

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

    trackConnectorInvocationCompleted(client, {
      connector_key: connectorKeyForConnection(connection),
      transport: connection.transport,
      status: invocation.status,
      origin: invocationOrigin(invocation),
      ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
    });
  } catch (err) {
    logger.warn(
      { err, invocationId },
      "failed to emit connector.invocation_completed telemetry",
    );
  }
}
